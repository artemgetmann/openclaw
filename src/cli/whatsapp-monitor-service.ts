import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import {
  buildWhatsAppMonitorServiceInstallPlan,
  resolveDefaultWhatsAppMonitorHookUrl,
} from "../commands/whatsapp-monitor-service-install-helpers.js";
import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
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
  if (!command?.environment) {
    return command;
  }
  const safeEnvironment = filterDaemonEnv(command.environment);
  return {
    ...command,
    environment: Object.keys(safeEnvironment).length > 0 ? safeEnvironment : undefined,
  };
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
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`WhatsApp monitor service check failed: ${String(err)}`);
    return;
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
    env: process.env,
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

  await installDaemonServiceAndEmit({
    serviceNoun: "WhatsApp monitor",
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

export async function runWhatsAppMonitorServiceUninstall(
  opts: WhatsAppMonitorServiceLifecycleOptions = {},
) {
  return await runServiceUninstall({
    serviceNoun: "WhatsApp monitor",
    service: resolveWhatsAppMonitorService(),
    opts,
    stopBeforeUninstall: false,
    assertNotLoadedAfterUninstall: false,
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
  const [loaded, command, runtime, cfg] = await Promise.all([
    service.isLoaded({ env: daemonEnv as NodeJS.ProcessEnv }).catch(() => false),
    service.readCommand(daemonEnv as NodeJS.ProcessEnv).catch(() => null),
    service
      .readRuntime(daemonEnv as NodeJS.ProcessEnv)
      .catch((err): GatewayServiceRuntime => ({ status: "unknown", detail: String(err) })),
    readBestEffortConfig(),
  ]);
  const defaultHookUrl = resolveDefaultWhatsAppMonitorHookUrl({
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
