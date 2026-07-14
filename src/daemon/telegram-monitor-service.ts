import fs from "node:fs/promises";
import {
  TELEGRAM_MONITOR_SERVICE_KIND,
  TELEGRAM_MONITOR_SERVICE_MARKER,
  TELEGRAM_MONITOR_WINDOWS_TASK_SCRIPT_NAME,
  resolveTelegramMonitorLaunchAgentLabel,
  resolveTelegramMonitorSystemdServiceName,
  resolveTelegramMonitorWindowsTaskName,
} from "./constants.js";
import { resolveGatewayRuntimeIdentityEnv } from "./service-env.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

function withTelegramMonitorServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const runtimeEnv = resolveGatewayRuntimeIdentityEnv(env);
  const profile = runtimeEnv.OPENCLAW_PROFILE;
  return {
    ...runtimeEnv,
    OPENCLAW_LAUNCHD_LABEL: resolveTelegramMonitorLaunchAgentLabel(profile),
    OPENCLAW_SYSTEMD_UNIT: resolveTelegramMonitorSystemdServiceName(profile),
    OPENCLAW_WINDOWS_TASK_NAME: resolveTelegramMonitorWindowsTaskName(profile),
    OPENCLAW_TASK_SCRIPT_NAME: TELEGRAM_MONITOR_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_LOG_PREFIX: "telegram-monitor",
    OPENCLAW_SERVICE_MARKER: TELEGRAM_MONITOR_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: TELEGRAM_MONITOR_SERVICE_KIND,
  };
}

function withTelegramMonitorInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  const serviceEnv = withTelegramMonitorServiceEnv(args.env);
  const profile = args.environment?.OPENCLAW_PROFILE ?? serviceEnv.OPENCLAW_PROFILE;
  return {
    ...args,
    env: serviceEnv,
    environment: {
      ...args.environment,
      OPENCLAW_LAUNCHD_LABEL: resolveTelegramMonitorLaunchAgentLabel(profile),
      OPENCLAW_SYSTEMD_UNIT: resolveTelegramMonitorSystemdServiceName(profile),
      OPENCLAW_WINDOWS_TASK_NAME: resolveTelegramMonitorWindowsTaskName(profile),
      OPENCLAW_TASK_SCRIPT_NAME: TELEGRAM_MONITOR_WINDOWS_TASK_SCRIPT_NAME,
      OPENCLAW_LOG_PREFIX: "telegram-monitor",
      OPENCLAW_SERVICE_MARKER: TELEGRAM_MONITOR_SERVICE_MARKER,
      OPENCLAW_SERVICE_KIND: TELEGRAM_MONITOR_SERVICE_KIND,
    },
  };
}

async function removeResidualTelegramMonitorCommand(
  base: GatewayService,
  env: Record<string, string | undefined>,
): Promise<void> {
  const residual = await base.readCommand(env);
  if (!residual?.sourcePath) {
    return;
  }
  // launchd moves plists to Trash. A pre-existing Trash destination can make
  // that move fail while bootout still succeeds, leaving restart persistence
  // behind. The source path comes from the profile-scoped base service read.
  await fs.rm(residual.sourcePath, { force: true });
  if (await base.readCommand(env)) {
    throw new Error(`Telegram monitor durable service command remains at ${residual.sourcePath}`);
  }
}

export function resolveTelegramMonitorService(): GatewayService {
  if (process.platform === "win32") {
    throw new Error(
      "Telegram monitor service is not supported on Windows yet; run `openclaw telegram-user monitor-poll --watch` under your own supervisor.",
    );
  }
  const base = resolveGatewayService();
  return {
    ...base,
    install: async (args) => base.install(withTelegramMonitorInstallEnv(args)),
    uninstall: async (args) => {
      const env = withTelegramMonitorServiceEnv(args.env);
      await base.uninstall({ ...args, env });
      await removeResidualTelegramMonitorCommand(base, env);
    },
    stop: async (args) =>
      base.stop({ ...args, env: withTelegramMonitorServiceEnv(args.env ?? {}) }),
    restart: async (args) =>
      base.restart({ ...args, env: withTelegramMonitorServiceEnv(args.env ?? {}) }),
    isLoaded: async (args) => base.isLoaded({ env: withTelegramMonitorServiceEnv(args.env ?? {}) }),
    readCommand: (env) => base.readCommand(withTelegramMonitorServiceEnv(env)),
    readRuntime: (env) => base.readRuntime(withTelegramMonitorServiceEnv(env)),
  };
}
