import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
import {
  formatWhatsAppMonitorServiceDescription,
  resolveWhatsAppMonitorLaunchAgentLabel,
} from "../daemon/constants.js";
import { resolveWhatsAppMonitorProgramArguments } from "../daemon/program-args.js";
import {
  buildWhatsAppMonitorServiceEnvironment,
  resolveGatewayRuntimeIdentityEnv,
} from "../daemon/service-env.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveLocalWhatsAppMonitorHookUrl } from "./whatsapp-monitor.js";

export type WhatsAppMonitorServiceInstallPlan = {
  description?: string;
  environment: Record<string, string | undefined>;
  programArguments: string[];
  workingDirectory?: string;
};

function readFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function resolveDefaultWhatsAppMonitorHookUrl(params: {
  env: Record<string, string | undefined>;
  port?: number;
}): string {
  const port = params.port ?? readFirstNonEmpty(params.env.OPENCLAW_GATEWAY_PORT) ?? "18789";
  return `http://127.0.0.1:${port}/hooks/monitor-event`;
}

export async function buildWhatsAppMonitorServiceInstallPlan(params: {
  cronStore?: string;
  cursorStore?: string;
  dbPath: string;
  env: Record<string, string | undefined>;
  hookUrl?: string;
  intervalMs: number;
  monitorStore?: string;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<WhatsAppMonitorServiceInstallPlan> {
  const daemonEnv = resolveGatewayRuntimeIdentityEnv(params.env);
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: daemonEnv,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const cfg = await readBestEffortConfig();
  const gatewayPort = resolveGatewayPort(cfg, daemonEnv as NodeJS.ProcessEnv);
  const hookUrl = resolveLocalWhatsAppMonitorHookUrl(
    params.hookUrl?.trim() ||
      resolveDefaultWhatsAppMonitorHookUrl({ env: daemonEnv, port: gatewayPort }),
  );
  const { programArguments, workingDirectory } = await resolveWhatsAppMonitorProgramArguments({
    cronStore: params.cronStore,
    cursorStore: params.cursorStore,
    dbPath: params.dbPath,
    hookUrl,
    intervalMs: params.intervalMs,
    monitorStore: params.monitorStore,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });

  await emitDaemonInstallRuntimeWarning({
    env: daemonEnv,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "WhatsApp monitor service runtime",
  });

  const environment = buildWhatsAppMonitorServiceEnvironment({ env: daemonEnv });
  const description = formatWhatsAppMonitorServiceDescription({
    profile: environment.OPENCLAW_PROFILE,
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return {
    description,
    environment: {
      ...environment,
      OPENCLAW_LAUNCHD_LABEL: resolveWhatsAppMonitorLaunchAgentLabel(environment.OPENCLAW_PROFILE),
    },
    programArguments,
    workingDirectory,
  };
}
