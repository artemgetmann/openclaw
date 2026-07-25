import fs from "node:fs/promises";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import {
  buildWhatsAppMonitorServiceInstallPlan,
  readWhatsAppMonitorConfigForEnv,
  resolveDefaultWhatsAppMonitorHookUrl,
  resolveWhatsAppMonitorCronStorePath,
} from "../commands/whatsapp-monitor-service-install-helpers.js";
import { resolveLocalWhatsAppMonitorHookUrl } from "../commands/whatsapp-monitor.js";
import { resolveGatewayPort } from "../config/config.js";
import {
  resolveWhatsAppMonitorLaunchAgentLabel,
  resolveWhatsAppMonitorSystemdServiceName,
  resolveWhatsAppMonitorWindowsTaskName,
} from "../daemon/constants.js";
import {
  buildPlatformRuntimeLogHints,
  buildPlatformServiceStartHints,
} from "../daemon/runtime-hints.js";
import { resolveGatewayRuntimeIdentityEnv } from "../daemon/service-env.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../daemon/service.js";
import { resolveWhatsAppMonitorService } from "../daemon/whatsapp-monitor-service.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { readListenerHealth, resolveListenerHealthStorePath } from "../monitor/listener-health.js";
import { resolveMonitorStorePath } from "../monitor/store.js";
import { defaultRuntime } from "../runtime.js";
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

type WhatsAppMonitorServiceInstallOptions = {
  cronStore?: string;
  cursorStore?: string;
  dbPath?: string;
  force?: boolean;
  hookUrl?: string;
  json?: boolean;
  monitorStore?: string;
  pollIntervalMs?: string | number;
  runtime?: string;
};

type WhatsAppMonitorServiceLifecycleOptions = {
  json?: boolean;
};

function readPositiveIntegerOption(value: unknown, flag: string): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`WhatsApp monitor service requires ${flag} to be a positive integer.`);
  }
  const parsed = parseStrictPositiveInteger(typeof value === "number" ? value.toString() : value);
  if (parsed === undefined) {
    throw new Error(`WhatsApp monitor service requires ${flag} to be a positive integer.`);
  }
  return parsed;
}

function readRequiredStringOption(value: unknown, flag: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`WhatsApp monitor service requires ${flag}.`);
  }
  return value.trim();
}

function resolveWhatsAppMonitorServiceCliEnv(env: NodeJS.ProcessEnv = process.env) {
  return resolveGatewayRuntimeIdentityEnv(env);
}

function renderWhatsAppMonitorServiceStartHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const daemonEnv = resolveWhatsAppMonitorServiceCliEnv(env);
  const profile = daemonEnv.OPENCLAW_PROFILE;
  return buildPlatformServiceStartHints({
    installCommand: formatCliCommand(
      "openclaw whatsapp-monitor monitor-service install --db-path /path/to/wacli.db",
    ),
    startCommand: formatCliCommand(
      "openclaw whatsapp-monitor monitor-service install --db-path /path/to/wacli.db --force",
    ),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveWhatsAppMonitorLaunchAgentLabel(profile)}.plist`,
    systemdServiceName: resolveWhatsAppMonitorSystemdServiceName(profile),
    windowsTaskName: resolveWhatsAppMonitorWindowsTaskName(profile),
  });
}

function buildWhatsAppMonitorRuntimeHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const daemonEnv = resolveWhatsAppMonitorServiceCliEnv(env);
  const profile = daemonEnv.OPENCLAW_PROFILE;
  return buildPlatformRuntimeLogHints({
    env: { ...daemonEnv, OPENCLAW_LOG_PREFIX: daemonEnv.OPENCLAW_LOG_PREFIX ?? "whatsapp-monitor" },
    systemdServiceName: resolveWhatsAppMonitorSystemdServiceName(profile),
    windowsTaskName: resolveWhatsAppMonitorWindowsTaskName(profile),
  });
}

function sanitizeServiceCommandForJson(
  command: GatewayServiceCommandConfig | null,
): GatewayServiceCommandConfig | null {
  if (!command) {
    return command;
  }
  const safeEnvironment = command.environment ? filterDaemonEnv(command.environment) : undefined;
  return {
    ...command,
    programArguments: redactWhatsAppMonitorSelectorArguments(command.programArguments),
    environment:
      safeEnvironment && Object.keys(safeEnvironment).length > 0 ? safeEnvironment : undefined,
  };
}

function redactWhatsAppMonitorSelectorArguments(args: string[]): string[] {
  const redacted = [...args];
  const pathFlags = new Set(["--db-path", "--cron-store", "--cursor-store", "--monitor-store"]);
  for (let index = 0; index < redacted.length; index += 1) {
    if (pathFlags.has(redacted[index] ?? "") && index + 1 < redacted.length) {
      redacted[index + 1] = "<configured>";
      index += 1;
    }
  }
  return redacted;
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
    resolveLocalWhatsAppMonitorHookUrl(value);
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
  service: ReturnType<typeof resolveWhatsAppMonitorService>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  // Restore the durable unit, not merely the currently running process. This
  // keeps a failed forced replacement from taking effect on the next restart.
  await params.service.install({
    env: params.env,
    stdout: params.stdout,
    programArguments: params.command.programArguments,
    workingDirectory: params.command.workingDirectory,
    environment: params.command.environment,
  });
}

export async function runWhatsAppMonitorServiceInstall(opts: WhatsAppMonitorServiceInstallOptions) {
  const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
  if (failIfNixDaemonInstallMode(fail)) {
    return;
  }

  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  let dbPath: string;
  let intervalMs: number;
  try {
    dbPath = readRequiredStringOption(opts.dbPath, "--db-path");
    intervalMs =
      readPositiveIntegerOption(opts.pollIntervalMs ?? "1000", "--poll-interval-ms") ?? 1000;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const service = resolveWhatsAppMonitorService();
  const daemonEnv = resolveWhatsAppMonitorServiceCliEnv(process.env);
  let loaded = false;
  let previousCommand: GatewayServiceCommandConfig | null = null;
  try {
    loaded = await service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv });
  } catch (err) {
    fail(`WhatsApp monitor service check failed: ${String(err)}`);
    return;
  }

  if (opts.force) {
    try {
      previousCommand = await service.readCommand(daemonEnv as NodeJS.ProcessEnv);
      if (loaded && !previousCommand) {
        fail(
          "WhatsApp monitor replacement refused: unable to capture the installed service command.",
        );
        return;
      }
      if (previousCommand) {
        await assertRestorableInstalledCommand(previousCommand);
      }
    } catch (err) {
      fail(`WhatsApp monitor replacement readiness check failed: ${String(err)}`);
      return;
    }
  }
  if (loaded && !opts.force) {
    emit({
      ok: true,
      result: "already-installed",
      message: `WhatsApp monitor service already ${service.loadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`WhatsApp monitor service already ${service.loadedText}.`);
      defaultRuntime.log(
        `Reinstall with: ${formatCliCommand("openclaw whatsapp-monitor monitor-service install --db-path /path/to/wacli.db --force")}`,
      );
    }
    return;
  }

  const plan = await buildWhatsAppMonitorServiceInstallPlan({
    cronStore: opts.cronStore,
    cursorStore: opts.cursorStore,
    dbPath,
    env: daemonEnv,
    hookUrl: opts.hookUrl,
    intervalMs,
    monitorStore: opts.monitorStore,
    runtime: runtimeRaw,
    warn: (message) => {
      if (json) {
        warnings.push(message);
      } else {
        defaultRuntime.log(message);
      }
    },
  });

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
    if (previousCommand) {
      try {
        await restoreInstalledCommand({
          command: previousCommand,
          env: daemonEnv as NodeJS.ProcessEnv,
          service,
          stdout,
        });
      } catch (rollbackError) {
        fail(
          `WhatsApp monitor install failed: ${String(installError)}; durable rollback failed: ${String(rollbackError)}`,
        );
        return;
      }
      fail(
        `WhatsApp monitor install failed: ${String(installError)}; the prior durable service command was restored.`,
      );
      return;
    }
    fail(`WhatsApp monitor install failed: ${String(installError)}`);
    return;
  }

  let installed = true;
  try {
    installed = await service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv });
  } catch {
    installed = true;
  }
  emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(service, installed),
    warnings: warnings.length ? warnings : undefined,
  });
}

export async function runWhatsAppMonitorServiceUninstall(
  opts: WhatsAppMonitorServiceLifecycleOptions = {},
) {
  return await runServiceUninstall({
    serviceNoun: "WhatsApp monitor",
    service: resolveWhatsAppMonitorService(),
    opts,
    stopBeforeUninstall: false,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runWhatsAppMonitorServiceRestart(
  opts: WhatsAppMonitorServiceLifecycleOptions = {},
) {
  await runServiceRestart({
    serviceNoun: "WhatsApp monitor",
    service: resolveWhatsAppMonitorService(),
    renderStartHints: renderWhatsAppMonitorServiceStartHints,
    opts,
  });
}

export async function runWhatsAppMonitorServiceStop(
  opts: WhatsAppMonitorServiceLifecycleOptions = {},
) {
  return await runServiceStop({
    serviceNoun: "WhatsApp monitor",
    service: resolveWhatsAppMonitorService(),
    opts,
  });
}

export async function runWhatsAppMonitorServiceStatus(
  opts: WhatsAppMonitorServiceLifecycleOptions = {},
) {
  const json = Boolean(opts.json);
  const service = resolveWhatsAppMonitorService();
  const daemonEnv = resolveWhatsAppMonitorServiceCliEnv(process.env);
  let loadedUnavailable = false;
  let commandUnavailable = false;
  let runtimeUnavailable = false;
  const [loaded, command, runtime, cfg] = await Promise.all([
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
    readWhatsAppMonitorConfigForEnv(daemonEnv),
  ]);
  const defaultHookUrl = resolveDefaultWhatsAppMonitorHookUrl({
    env: daemonEnv,
    port: resolveGatewayPort(cfg, daemonEnv as NodeJS.ProcessEnv),
  });

  const hookUrl = readMonitorArgument(command?.programArguments ?? [], "--hook-url");
  const monitorStorePath = readMonitorArgument(command?.programArguments ?? [], "--monitor-store");
  const cronStorePath = readMonitorArgument(command?.programArguments ?? [], "--cron-store");
  const expectedCronStorePath = resolveWhatsAppMonitorCronStorePath({
    configuredStore: cfg.cron?.store,
    env: daemonEnv,
  });
  const expectedMonitorStorePath = resolveMonitorStorePath({
    cronStorePath: expectedCronStorePath,
  });
  const selectedMonitorStorePath = monitorStorePath
    ? resolveMonitorStorePath({ storePath: monitorStorePath })
    : cronStorePath
      ? resolveMonitorStorePath({ cronStorePath })
      : undefined;
  const pollIntervalMs =
    parseStrictPositiveInteger(
      readMonitorArgument(command?.programArguments ?? [], "--poll-interval-ms") ?? "1000",
    ) ?? 1000;
  let listenerHealthUnavailable = false;
  const listenerHealth = await readListenerHealth({
    pollIntervalMs,
    service: "whatsapp",
    storePath: resolveListenerHealthStorePath({
      env: daemonEnv as NodeJS.ProcessEnv,
      cronStorePath,
      monitorStorePath,
    }),
  }).catch(() => {
    listenerHealthUnavailable = true;
    return undefined;
  });
  const listenerOwnerPid = listenerHealth?.record.owner.pid;
  // Missing evidence cannot prove that the running service owns this listener heartbeat.
  const listenerOwnerMatches =
    runtime.pid !== undefined && listenerOwnerPid !== undefined && runtime.pid === listenerOwnerPid;
  const profileOwnership = summarizeInstalledIdentity(command, daemonEnv, "OPENCLAW_PROFILE");
  const configOwnership = summarizeInstalledIdentity(command, daemonEnv, "OPENCLAW_CONFIG_PATH");
  const stateOwnership = summarizeInstalledIdentity(command, daemonEnv, "OPENCLAW_STATE_DIR");
  const hookOwnership = { configured: Boolean(hookUrl), loopback: isLoopbackHookUrl(hookUrl) };
  const selectorOwnership = {
    configured: selectedMonitorStorePath !== undefined,
    matches:
      selectedMonitorStorePath !== undefined &&
      selectedMonitorStorePath === expectedMonitorStorePath,
    dbPath: Boolean(readMonitorArgument(command?.programArguments ?? [], "--db-path")),
    cronStore: Boolean(cronStorePath),
    cursorStore: Boolean(readMonitorArgument(command?.programArguments ?? [], "--cursor-store")),
    monitorStore: Boolean(monitorStorePath),
  };
  const acceptance = {
    configured: command !== null,
    loaded,
    healthy:
      command !== null &&
      loaded &&
      runtime.status === "running" &&
      listenerHealth?.state === "healthy" &&
      listenerOwnerMatches &&
      profileOwnership.matches &&
      configOwnership.matches &&
      stateOwnership.matches &&
      hookOwnership.loopback &&
      selectorOwnership.matches &&
      selectorOwnership.dbPath,
    unavailable: {
      configured: commandUnavailable,
      loaded: loadedUnavailable,
      runtime: runtimeUnavailable,
      listenerHealth: listenerHealthUnavailable,
    },
    ownership: {
      profile: profileOwnership,
      config: configOwnership,
      state: stateOwnership,
      hook: hookOwnership,
      listener: {
        pidMatches: listenerOwnerMatches,
      },
      selectors: selectorOwnership,
    },
  };
  const payload = {
    service: {
      ...buildDaemonServiceSnapshot(service, loaded),
      command: json ? sanitizeServiceCommandForJson(command) : command,
      runtime,
      defaultHookUrl,
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
      `${label("Command:")} ${infoText(redactWhatsAppMonitorSelectorArguments(command.programArguments).join(" "))}`,
    );
  }
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
    for (const hint of renderWhatsAppMonitorServiceStartHints()) {
      defaultRuntime.log(`${warnText("Start with:")} ${infoText(hint)}`);
    }
    return;
  }
  if (runtime?.missingUnit || runtime?.status === "stopped") {
    defaultRuntime.error(errorText("Service is loaded but not running."));
    for (const hint of buildWhatsAppMonitorRuntimeHints()) {
      defaultRuntime.error(errorText(hint));
    }
  }
}
