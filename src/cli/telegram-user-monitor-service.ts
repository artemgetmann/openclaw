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
import { defaultRuntime } from "../runtime.js";
import { colorize } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import {
  runServiceRestart,
  runServiceStop,
  runServiceUninstall,
} from "./daemon-cli/lifecycle-core.js";
import { buildDaemonServiceSnapshot, installDaemonServiceAndEmit } from "./daemon-cli/response.js";
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
  if (!command?.environment) {
    return command;
  }
  const safeEnvironment = filterDaemonEnv(command.environment);
  return {
    ...command,
    environment: Object.keys(safeEnvironment).length > 0 ? safeEnvironment : undefined,
  };
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
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Telegram monitor service check failed: ${String(err)}`);
    return;
  }
  if (loaded && !opts.force) {
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

  const plan = await buildTelegramMonitorServiceInstallPlan({
    cronStore: opts.cronStore,
    cursorStore: opts.cursorStore,
    env: process.env,
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

  await installDaemonServiceAndEmit({
    serviceNoun: "Telegram monitor",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        env: process.env,
        stdout,
        programArguments: plan.programArguments,
        workingDirectory: plan.workingDirectory,
        environment: plan.environment,
        description: plan.description,
      });
    },
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
    assertNotLoadedAfterUninstall: false,
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
  const [loaded, command, runtime, cfg] = await Promise.all([
    service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv }).catch(() => false),
    service.readCommand(daemonEnv as NodeJS.ProcessEnv).catch(() => null),
    service
      .readRuntime(daemonEnv as NodeJS.ProcessEnv)
      .catch((err): GatewayServiceRuntime => ({ status: "unknown", detail: String(err) })),
    readBestEffortConfig(),
  ]);
  const defaultHookUrl = resolveDefaultTelegramMonitorHookUrl({
    env: daemonEnv,
    port: resolveGatewayPort(cfg, daemonEnv as NodeJS.ProcessEnv),
  });

  const payload = {
    service: {
      ...buildDaemonServiceSnapshot(service, loaded),
      command: json ? sanitizeServiceCommandForJson(command) : command,
      runtime,
      defaultHookUrl,
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
  if (command?.programArguments?.length) {
    defaultRuntime.log(`${label("Command:")} ${infoText(command.programArguments.join(" "))}`);
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
