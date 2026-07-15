import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import {
  buildTelegramMonitorServiceInstallPlan,
  resolveDefaultTelegramMonitorHookUrl,
} from "../commands/telegram-monitor-service-install-helpers.js";
import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
import {
  resolveTelegramMonitorLaunchAgentLabel,
  resolveTelegramMonitorSystemdServiceName,
  resolveTelegramMonitorWindowsTaskName,
} from "../daemon/constants.js";
import {
  buildPlatformRuntimeLogHints,
  buildPlatformServiceStartHints,
} from "../daemon/runtime-hints.js";
import { resolveGatewayRuntimeIdentityEnv } from "../daemon/service-env.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../daemon/service.js";
import { resolveTelegramMonitorService } from "../daemon/telegram-monitor-service.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { readListenerHealth, resolveListenerHealthStorePath } from "../monitor/listener-health.js";
import { defaultRuntime } from "../runtime.js";
import { resolveLocalTelegramMonitorHookUrl } from "../telegram-user/monitor-hook-url.js";
import {
  clearTelegramUserMonitorBinding,
  readTelegramUserMonitorBinding,
  summarizeTelegramUserMonitorBinding,
  writeTelegramUserMonitorBinding,
} from "../telegram-user/monitor-service-binding.js";
import type { TelegramUserMonitorBinding } from "../telegram-user/monitor-service-binding.js";
import { colorize } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import {
  runServiceRestart,
  runServiceStop,
  runServiceUninstall,
} from "./daemon-cli/lifecycle-core.js";
import { buildDaemonServiceSnapshot } from "./daemon-cli/response.js";
import {
  createCliStatusTextStyles,
  createDaemonInstallActionContext,
  failIfNixDaemonInstallMode,
  filterDaemonEnv,
  formatRuntimeStatus,
  resolveRuntimeStatusColor,
} from "./daemon-cli/shared.js";

type TelegramMonitorServiceInstallOptions = {
  cronStore?: string;
  cursorStore?: string;
  envFile?: string;
  force?: boolean;
  hookUrl?: string;
  json?: boolean;
  limit?: string | number;
  monitorStore?: string;
  pollIntervalMs?: string | number;
  runtime?: string;
  session?: string;
};

type TelegramMonitorServiceLifecycleOptions = {
  json?: boolean;
};

function readPositiveIntegerOption(value: unknown, flag: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Telegram monitor service requires ${flag} to be a positive integer.`);
  }
  const parsed = parseStrictPositiveInteger(typeof value === "number" ? value.toString() : value);
  if (parsed === undefined) {
    throw new Error(`Telegram monitor service requires ${flag} to be a positive integer.`);
  }
  return parsed;
}

function resolveTelegramMonitorServiceCliEnv(env: NodeJS.ProcessEnv = process.env) {
  return resolveGatewayRuntimeIdentityEnv(env);
}

function renderTelegramMonitorServiceStartHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const daemonEnv = resolveTelegramMonitorServiceCliEnv(env);
  const profile = daemonEnv.OPENCLAW_PROFILE;
  return buildPlatformServiceStartHints({
    installCommand: formatCliCommand("openclaw telegram-user monitor-service install"),
    startCommand: formatCliCommand("openclaw telegram-user monitor-service install --force"),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveTelegramMonitorLaunchAgentLabel(profile)}.plist`,
    systemdServiceName: resolveTelegramMonitorSystemdServiceName(profile),
    windowsTaskName: resolveTelegramMonitorWindowsTaskName(profile),
  });
}

function buildTelegramMonitorRuntimeHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const daemonEnv = resolveTelegramMonitorServiceCliEnv(env);
  const profile = daemonEnv.OPENCLAW_PROFILE;
  return buildPlatformRuntimeLogHints({
    env: { ...daemonEnv, OPENCLAW_LOG_PREFIX: daemonEnv.OPENCLAW_LOG_PREFIX ?? "telegram-monitor" },
    systemdServiceName: resolveTelegramMonitorSystemdServiceName(profile),
    windowsTaskName: resolveTelegramMonitorWindowsTaskName(profile),
  });
}

function sanitizeServiceCommandForJson(
  command: GatewayServiceCommandConfig | null,
): GatewayServiceCommandConfig | null {
  if (!command) {
    return null;
  }
  const safeEnvironment = command.environment ? filterDaemonEnv(command.environment) : undefined;
  return {
    ...command,
    programArguments: redactTelegramMonitorSelectorArguments(command.programArguments),
    environment:
      safeEnvironment && Object.keys(safeEnvironment).length > 0 ? safeEnvironment : undefined,
  };
}

function redactTelegramMonitorSelectorArguments(args: string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    if (redacted[index] === "--env-file" || redacted[index] === "--session") {
      if (index + 1 < redacted.length) {
        redacted[index + 1] = "<configured>";
        index += 1;
      }
    }
  }
  return redacted;
}

function readTelegramMonitorSelectorArgument(
  programArguments: string[],
  flag: "--env-file" | "--session",
): string | undefined {
  let selector: string | undefined;
  for (let index = 0; index < programArguments.length; index += 1) {
    if (programArguments[index] !== flag) {
      continue;
    }
    const value = programArguments[index + 1]?.trim();
    if (value) {
      // Generated service commands contain one selector per flag. Keeping the
      // last valid value also mirrors normal CLI precedence for legacy units.
      selector = value;
    }
    index += 1;
  }
  return selector;
}

function readMonitorArgument(programArguments: string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < programArguments.length; index += 1) {
    if (programArguments[index] !== flag) {
      continue;
    }
    const candidate = programArguments[index + 1]?.trim();
    if (candidate) {
      value = candidate;
    }
    index += 1;
  }
  return value;
}

function isLoopbackHookUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    resolveLocalTelegramMonitorHookUrl(value);
    return true;
  } catch {
    return false;
  }
}

async function assertRestorableInstalledCommand(
  command: GatewayServiceCommandConfig,
): Promise<void> {
  if (Object.values(command.environmentValueSources ?? {}).includes("file")) {
    throw new Error(
      "installed service uses EnvironmentFile values that cannot be restored faithfully; update the unit explicitly before forcing replacement",
    );
  }
  if (!command.sourcePath) {
    return;
  }
  let source: string;
  try {
    source = await fs.readFile(command.sourcePath, "utf8");
  } catch (err) {
    throw new Error(`unable to verify installed service source ${command.sourcePath}`, {
      cause: err,
    });
  }
  // Empty, optional, or unreadable EnvironmentFile targets do not contribute
  // value-source metadata, but replacing their directive would still change
  // future service behavior and could inline credentials during rollback.
  if (/^\s*EnvironmentFile\s*=/m.test(source)) {
    throw new Error(
      "installed service uses an EnvironmentFile directive that cannot be restored faithfully; update the unit explicitly before forcing replacement",
    );
  }
}

function summarizeInstalledIdentity(
  command: GatewayServiceCommandConfig | null,
  expected: Record<string, string | undefined>,
  key: "OPENCLAW_PROFILE" | "OPENCLAW_CONFIG_PATH" | "OPENCLAW_STATE_DIR",
) {
  const installed = command?.environment?.[key]?.trim() || undefined;
  const expectedValue = expected[key]?.trim() || undefined;
  return {
    configured: Boolean(installed),
    matches: command !== null && installed === expectedValue,
  };
}

async function restoreInstalledCommand(params: {
  command: GatewayServiceCommandConfig;
  env: NodeJS.ProcessEnv;
  service: ReturnType<typeof resolveTelegramMonitorService>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  // A forced install may rewrite the durable unit before activation fails.
  // Reinstall the captured command so the next login/restart cannot boot the
  // rejected selectors even when the old process is still alive right now.
  await params.service.install({
    env: params.env,
    stdout: params.stdout,
    programArguments: params.command.programArguments,
    workingDirectory: params.command.workingDirectory,
    environment: params.command.environment,
  });
}

function readTelegramMonitorBindingFromCommand(
  command: GatewayServiceCommandConfig,
): TelegramUserMonitorBinding {
  const resolveInstalledSelector = (selector: string | undefined): string | undefined => {
    if (!selector) {
      return undefined;
    }
    // Legacy commands stored selectors before install planning canonicalized
    // them. Resolve relative values as the service did at execution time, not
    // against whichever directory a later repair CLI happens to run from.
    return path.resolve(command.workingDirectory ?? process.cwd(), selector);
  };
  return {
    envFile: resolveInstalledSelector(
      readTelegramMonitorSelectorArgument(command.programArguments, "--env-file"),
    ),
    session: resolveInstalledSelector(
      readTelegramMonitorSelectorArgument(command.programArguments, "--session"),
    ),
  };
}

function installedCommandMatchesPlan(params: {
  command: GatewayServiceCommandConfig | null;
  environment: Record<string, string | undefined>;
  programArguments: string[];
  workingDirectory?: string;
}): boolean {
  if (!params.command) {
    return false;
  }
  if (params.command.workingDirectory !== params.workingDirectory) {
    return false;
  }
  const environmentMatches = Object.entries(params.environment).every(
    ([key, value]) => value === undefined || params.command?.environment?.[key] === value,
  );
  if (!environmentMatches) {
    return false;
  }
  return (
    params.command.programArguments.length === params.programArguments.length &&
    params.command.programArguments.every((arg, index) => arg === params.programArguments[index])
  );
}

async function restoreTelegramMonitorBinding(params: {
  env: NodeJS.ProcessEnv;
  previous: TelegramUserMonitorBinding | null;
}): Promise<void> {
  // A missing prior file is meaningful: restoring it as {} would incorrectly
  // advertise that a selector was configured before this failed install.
  if (params.previous === null) {
    await clearTelegramUserMonitorBinding(params.env);
    return;
  }
  await writeTelegramUserMonitorBinding({ env: params.env, ...params.previous });
}

export async function runTelegramMonitorServiceInstall(opts: TelegramMonitorServiceInstallOptions) {
  const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
  if (failIfNixDaemonInstallMode(fail)) {
    return;
  }

  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  let intervalMs: number;
  let limit: number | undefined;
  try {
    intervalMs =
      readPositiveIntegerOption(opts.pollIntervalMs ?? "1000", "--poll-interval-ms") ?? 1000;
    limit = readPositiveIntegerOption(opts.limit, "--limit") ?? undefined;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const service = resolveTelegramMonitorService();
  const daemonEnv = resolveTelegramMonitorServiceCliEnv(process.env);
  let loaded = false;
  let previousCommand: GatewayServiceCommandConfig | null = null;
  try {
    loaded = await service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv });
  } catch (err) {
    fail(`Telegram monitor service check failed: ${String(err)}`);
    return;
  }
  if (loaded && !opts.force) {
    try {
      const existingBinding = await readTelegramUserMonitorBinding(daemonEnv as NodeJS.ProcessEnv);
      if (existingBinding === null) {
        const installedCommand = await service.readCommand(daemonEnv as NodeJS.ProcessEnv);
        if (!installedCommand) {
          fail(
            "Telegram monitor binding backfill failed: unable to read the installed service command.",
          );
          return;
        }
        // Legacy installs encoded selectors only in the service command. Copy
        // them into profile state without reinstalling or replacing a binding
        // that a newer install already owns.
        await writeTelegramUserMonitorBinding({
          env: daemonEnv as NodeJS.ProcessEnv,
          ...readTelegramMonitorBindingFromCommand(installedCommand),
        });
      }
    } catch (err) {
      fail(`Telegram monitor binding backfill failed: ${String(err)}`);
      return;
    }
    emit({
      ok: true,
      result: "already-installed",
      message: `Telegram monitor service already ${service.loadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`Telegram monitor service already ${service.loadedText}.`);
      defaultRuntime.log(
        `Reinstall with: ${formatCliCommand("openclaw telegram-user monitor-service install --force")}`,
      );
    }
    return;
  }

  if (opts.force) {
    try {
      previousCommand = await service.readCommand(daemonEnv as NodeJS.ProcessEnv);
      if (loaded && !previousCommand) {
        fail(
          "Telegram monitor replacement refused: unable to capture the installed service command.",
        );
        return;
      }
      if (previousCommand) {
        await assertRestorableInstalledCommand(previousCommand);
      }
    } catch (err) {
      fail(`Telegram monitor replacement readiness check failed: ${String(err)}`);
      return;
    }
  }

  const plan = await buildTelegramMonitorServiceInstallPlan({
    cronStore: opts.cronStore,
    cursorStore: opts.cursorStore,
    env: daemonEnv,
    envFile: opts.envFile,
    hookUrl: opts.hookUrl,
    intervalMs,
    limit,
    monitorStore: opts.monitorStore,
    session: opts.session,
    runtime: runtimeRaw,
    warn: (message) => {
      if (json) {
        warnings.push(message);
      } else {
        defaultRuntime.log(message);
      }
    },
  });

  let previousBinding: TelegramUserMonitorBinding | null;
  try {
    previousBinding = await readTelegramUserMonitorBinding(plan.binding.env);
    // Commit selectors before touching launchd/systemd. A service that starts
    // during an error path must never outlive the credentials it was given.
    await writeTelegramUserMonitorBinding(plan.binding);
  } catch (err) {
    fail(`Telegram monitor binding preparation failed: ${String(err)}`);
    return;
  }

  try {
    await service.install({
      env: daemonEnv as NodeJS.ProcessEnv,
      stdout,
      programArguments: plan.programArguments,
      workingDirectory: plan.workingDirectory,
      environment: plan.environment,
      description: plan.description,
    });
  } catch (installError) {
    let installed: boolean | null = null;
    let checkError: unknown;
    try {
      installed = await service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv });
    } catch (err) {
      checkError = err;
    }

    const restorePriorBinding = async () => {
      try {
        if (previousCommand) {
          await restoreInstalledCommand({
            command: previousCommand,
            env: daemonEnv as NodeJS.ProcessEnv,
            service,
            stdout,
          });
        }
        await restoreTelegramMonitorBinding({ env: plan.binding.env, previous: previousBinding });
      } catch (rollbackError) {
        fail(
          `Telegram monitor install failed: ${String(installError)}; replacement was not verified, and durable rollback failed: ${String(rollbackError)}`,
        );
        return;
      }
      fail(
        `Telegram monitor install failed: ${String(installError)}; replacement was not verified, so the prior binding was restored.`,
      );
    };

    if (loaded) {
      // A pre-existing service may still be executing its old command even if
      // install already replaced the unit file. Without active-process command
      // introspection, the old binding is the only defensible runtime identity.
      await restorePriorBinding();
      return;
    }

    // Service activation and command installation are separate facts. A failed
    // fresh bootstrap can leave its command on disk while reporting the unit as
    // unloaded; retain matching selectors because no older service can own them.
    const installedCommand = await service
      .readCommand(daemonEnv as NodeJS.ProcessEnv)
      .catch(() => null);
    if (
      installedCommandMatchesPlan({
        command: installedCommand,
        environment: plan.environment,
        programArguments: plan.programArguments,
        workingDirectory: plan.workingDirectory,
      })
    ) {
      fail(
        `Telegram monitor install failed after updating the service command: ${String(installError)}. The new binding was retained.`,
      );
      return;
    }

    if (installed === false) {
      await restorePriorBinding();
      return;
    }

    // With no pre-existing unit, a newly loaded command still proves a partial
    // install succeeded. An unavailable post-check keeps the historical,
    // conservative behavior because rolling back could split a new live unit.
    const observation =
      installed === true
        ? `the service became ${service.loadedText}`
        : `service state could not be checked: ${String(checkError)}`;
    fail(
      `Telegram monitor install failed after ${observation}: ${String(installError)}. The new binding was retained.`,
    );
    return;
  }

  let installed = true;
  try {
    installed = await service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv });
  } catch {
    // The install completed; retain the conservative historical response when
    // a post-install observation is unavailable.
    installed = true;
  }
  emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(service, installed),
    warnings: warnings.length ? warnings : undefined,
  });
}

export async function runTelegramMonitorServiceUninstall(
  opts: TelegramMonitorServiceLifecycleOptions = {},
) {
  return await runServiceUninstall({
    serviceNoun: "Telegram monitor",
    service: resolveTelegramMonitorService(),
    opts,
    stopBeforeUninstall: false,
    assertNotLoadedAfterUninstall: true,
    afterUninstall: async (env) => {
      // The binding changes selector defaults for all Telegram-user commands,
      // so its ownership ends with the monitor service that created it.
      await clearTelegramUserMonitorBinding(env as NodeJS.ProcessEnv);
    },
  });
}

export async function runTelegramMonitorServiceRestart(
  opts: TelegramMonitorServiceLifecycleOptions = {},
) {
  await runServiceRestart({
    serviceNoun: "Telegram monitor",
    service: resolveTelegramMonitorService(),
    renderStartHints: renderTelegramMonitorServiceStartHints,
    opts,
  });
}

export async function runTelegramMonitorServiceStop(
  opts: TelegramMonitorServiceLifecycleOptions = {},
) {
  return await runServiceStop({
    serviceNoun: "Telegram monitor",
    service: resolveTelegramMonitorService(),
    opts,
  });
}

export async function runTelegramMonitorServiceStatus(
  opts: TelegramMonitorServiceLifecycleOptions = {},
) {
  const json = Boolean(opts.json);
  const service = resolveTelegramMonitorService();
  const daemonEnv = resolveTelegramMonitorServiceCliEnv(process.env);
  let loadedUnavailable = false;
  let commandUnavailable = false;
  let runtimeUnavailable = false;
  let bindingUnavailable = false;
  const [loaded, command, runtime, cfg, binding] = await Promise.all([
    service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv }).catch(() => {
      loadedUnavailable = true;
      return false;
    }),
    service.readCommand(daemonEnv as NodeJS.ProcessEnv).catch(() => {
      commandUnavailable = true;
      return null;
    }),
    service.readRuntime(daemonEnv as NodeJS.ProcessEnv).catch((err): GatewayServiceRuntime => {
      runtimeUnavailable = true;
      return { status: "unknown", detail: String(err) };
    }),
    readBestEffortConfig(),
    summarizeTelegramUserMonitorBinding(daemonEnv as NodeJS.ProcessEnv).catch(() => {
      bindingUnavailable = true;
      return {
        configured: false,
        source: "unavailable" as const,
        envFile: { configured: false, present: false },
        session: { configured: false, present: false },
      };
    }),
  ]);
  const defaultHookUrl = resolveDefaultTelegramMonitorHookUrl({
    env: daemonEnv,
    port: resolveGatewayPort(cfg, daemonEnv as NodeJS.ProcessEnv),
  });

  const hookUrl = readMonitorArgument(command?.programArguments ?? [], "--hook-url");
  const monitorStorePath = readMonitorArgument(command?.programArguments ?? [], "--monitor-store");
  const cronStorePath = readMonitorArgument(command?.programArguments ?? [], "--cron-store");
  const pollIntervalMs =
    parseStrictPositiveInteger(
      readMonitorArgument(command?.programArguments ?? [], "--poll-interval-ms") ?? "1000",
    ) ?? 1000;
  let listenerHealthUnavailable = false;
  const listenerHealth = await readListenerHealth({
    pollIntervalMs,
    service: "telegram-user",
    storePath: resolveListenerHealthStorePath({
      env: daemonEnv as NodeJS.ProcessEnv,
      cronStorePath,
      monitorStorePath,
    }),
  }).catch(() => {
    listenerHealthUnavailable = true;
    return undefined;
  });
  const listenerOwnerMatches =
    runtime.pid === undefined || runtime.pid === listenerHealth?.record.owner.pid;
  const acceptance = {
    configured: command !== null,
    loaded,
    healthy:
      command !== null &&
      loaded &&
      runtime.status === "running" &&
      listenerHealth?.state === "healthy" &&
      listenerOwnerMatches,
    unavailable: {
      configured: commandUnavailable,
      loaded: loadedUnavailable,
      runtime: runtimeUnavailable,
      binding: bindingUnavailable,
      listenerHealth: listenerHealthUnavailable,
    },
    ownership: {
      profile: summarizeInstalledIdentity(command, daemonEnv, "OPENCLAW_PROFILE"),
      config: summarizeInstalledIdentity(command, daemonEnv, "OPENCLAW_CONFIG_PATH"),
      state: summarizeInstalledIdentity(command, daemonEnv, "OPENCLAW_STATE_DIR"),
      hook: { configured: Boolean(hookUrl), loopback: isLoopbackHookUrl(hookUrl) },
      listener: {
        pidMatches: listenerOwnerMatches,
      },
      selectors: {
        envFile: Boolean(readMonitorArgument(command?.programArguments ?? [], "--env-file")),
        session: Boolean(readMonitorArgument(command?.programArguments ?? [], "--session")),
        cronStore: Boolean(readMonitorArgument(command?.programArguments ?? [], "--cron-store")),
        cursorStore: Boolean(
          readMonitorArgument(command?.programArguments ?? [], "--cursor-store"),
        ),
        monitorStore: Boolean(
          readMonitorArgument(command?.programArguments ?? [], "--monitor-store"),
        ),
      },
    },
  };
  const payload = {
    service: {
      ...buildDaemonServiceSnapshot(service, loaded),
      command: json ? sanitizeServiceCommandForJson(command) : command,
      runtime,
      defaultHookUrl,
      binding,
      // Overlay the derived state so a frozen listener cannot appear as the
      // last persisted "healthy" state merely because it stopped writing.
      listenerHealth: listenerHealth
        ? { ...listenerHealth.record, state: listenerHealth.state }
        : { state: "unknown", unavailable: true },
      acceptance,
    },
  };

  if (json) {
    defaultRuntime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();
  const serviceStatus = loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
  defaultRuntime.log(
    `${label("Acceptance:")} ${infoText(`configured=${acceptance.configured} loaded=${acceptance.loaded} healthy=${acceptance.healthy} unavailable=${Object.values(acceptance.unavailable).some(Boolean)}`)}`,
  );
  defaultRuntime.log(
    `${label("Listener health:")} ${infoText(
      listenerHealth
        ? `state=${listenerHealth.state} ownerPid=${listenerHealth.record.owner.pid ?? "-"} pidMatch=${listenerOwnerMatches} lastCheck=${listenerHealth.record.lastSuccessfulCheckAtMs === null ? "never" : new Date(listenerHealth.record.lastSuccessfulCheckAtMs).toISOString()} lastRouted=${listenerHealth.record.lastRoutedEventAtMs === null ? "never" : new Date(listenerHealth.record.lastRoutedEventAtMs).toISOString()} failures=${listenerHealth.record.consecutiveFailures} error=${listenerHealth.record.lastError ?? "-"}`
        : "state=unknown ownerPid=- pidMatch=false lastCheck=never lastRouted=never failures=0 error=unavailable",
    )}`,
  );
  if (command?.programArguments?.length) {
    defaultRuntime.log(
      `${label("Command:")} ${infoText(redactTelegramMonitorSelectorArguments(command.programArguments).join(" "))}`,
    );
  }
  defaultRuntime.log(
    `${label("Binding:")} ${infoText(`${binding.source}; env-file configured=${binding.envFile.configured} present=${binding.envFile.present}; session configured=${binding.session.configured} present=${binding.session.present}`)}`,
  );
  if (command?.sourcePath) {
    defaultRuntime.log(`${label("Service file:")} ${infoText(command.sourcePath)}`);
  }
  if (command?.workingDirectory) {
    defaultRuntime.log(`${label("Working dir:")} ${infoText(command.workingDirectory)}`);
  }
  const runtimeLine = formatRuntimeStatus(runtime);
  if (runtimeLine) {
    const runtimeColor = resolveRuntimeStatusColor(runtime?.status);
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }
  if (!loaded) {
    defaultRuntime.log("");
    for (const hint of renderTelegramMonitorServiceStartHints()) {
      defaultRuntime.log(`${warnText("Start with:")} ${infoText(hint)}`);
    }
    return;
  }
  if (runtime?.missingUnit || runtime?.status === "stopped") {
    defaultRuntime.error(errorText("Service is loaded but not running."));
    for (const hint of buildTelegramMonitorRuntimeHints()) {
      defaultRuntime.error(errorText(hint));
    }
  }
}
