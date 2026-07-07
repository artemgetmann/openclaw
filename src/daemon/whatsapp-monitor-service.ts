import {
  WHATSAPP_MONITOR_SERVICE_KIND,
  WHATSAPP_MONITOR_SERVICE_MARKER,
  WHATSAPP_MONITOR_WINDOWS_TASK_SCRIPT_NAME,
  resolveWhatsAppMonitorLaunchAgentLabel,
  resolveWhatsAppMonitorSystemdServiceName,
  resolveWhatsAppMonitorWindowsTaskName,
} from "./constants.js";
import { resolveGatewayRuntimeIdentityEnv } from "./service-env.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

function withWhatsAppMonitorServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const runtimeEnv = resolveGatewayRuntimeIdentityEnv(env);
  const profile = runtimeEnv.OPENCLAW_PROFILE;
  return {
    ...runtimeEnv,
    OPENCLAW_LAUNCHD_LABEL: resolveWhatsAppMonitorLaunchAgentLabel(profile),
    OPENCLAW_SYSTEMD_UNIT: resolveWhatsAppMonitorSystemdServiceName(profile),
    OPENCLAW_WINDOWS_TASK_NAME: resolveWhatsAppMonitorWindowsTaskName(profile),
    OPENCLAW_TASK_SCRIPT_NAME: WHATSAPP_MONITOR_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_LOG_PREFIX: "whatsapp-monitor",
    OPENCLAW_SERVICE_MARKER: WHATSAPP_MONITOR_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: WHATSAPP_MONITOR_SERVICE_KIND,
  };
}

function withWhatsAppMonitorInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  const serviceEnv = withWhatsAppMonitorServiceEnv(args.env);
  const profile = args.environment?.OPENCLAW_PROFILE ?? serviceEnv.OPENCLAW_PROFILE;
  return {
    ...args,
    env: serviceEnv,
    environment: {
      ...args.environment,
      OPENCLAW_LAUNCHD_LABEL: resolveWhatsAppMonitorLaunchAgentLabel(profile),
      OPENCLAW_SYSTEMD_UNIT: resolveWhatsAppMonitorSystemdServiceName(profile),
      OPENCLAW_WINDOWS_TASK_NAME: resolveWhatsAppMonitorWindowsTaskName(profile),
      OPENCLAW_TASK_SCRIPT_NAME: WHATSAPP_MONITOR_WINDOWS_TASK_SCRIPT_NAME,
      OPENCLAW_LOG_PREFIX: "whatsapp-monitor",
      OPENCLAW_SERVICE_MARKER: WHATSAPP_MONITOR_SERVICE_MARKER,
      OPENCLAW_SERVICE_KIND: WHATSAPP_MONITOR_SERVICE_KIND,
    },
  };
}

export function resolveWhatsAppMonitorService(): GatewayService {
  if (process.platform === "win32") {
    throw new Error(
      "WhatsApp monitor service is not supported on Windows yet; run `openclaw whatsapp-monitor poll --watch` under your own supervisor.",
    );
  }
  const base = resolveGatewayService();
  return {
    ...base,
    install: async (args) => base.install(withWhatsAppMonitorInstallEnv(args)),
    uninstall: async (args) =>
      base.uninstall({ ...args, env: withWhatsAppMonitorServiceEnv(args.env) }),
    stop: async (args) =>
      base.stop({ ...args, env: withWhatsAppMonitorServiceEnv(args.env ?? {}) }),
    restart: async (args) =>
      base.restart({ ...args, env: withWhatsAppMonitorServiceEnv(args.env ?? {}) }),
    isLoaded: async (args) => base.isLoaded({ env: withWhatsAppMonitorServiceEnv(args.env ?? {}) }),
    readCommand: (env) => base.readCommand(withWhatsAppMonitorServiceEnv(env)),
    readRuntime: (env) => base.readRuntime(withWhatsAppMonitorServiceEnv(env)),
  };
}
