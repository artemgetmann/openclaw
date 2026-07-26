import path from "node:path";
import { createConfigIO, resolveGatewayPort } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveCronStorePath } from "../cron/store.js";
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

export async function readWhatsAppMonitorConfigForEnv(env: Record<string, string | undefined>) {
  // Service identity normalization can select a consumer/profile config that
  // differs from the caller's process.env. Read through an isolated config IO
  // instance so cron.store and gateway.port come from the service we install.
  const configIO = createConfigIO({ env: env as NodeJS.ProcessEnv });
  const snapshot = await configIO.readConfigFileSnapshot();
  return snapshot.valid ? configIO.loadConfigReadOnly() : snapshot.config;
}

export function resolveWhatsAppMonitorCronStorePath(params: {
  configuredStore?: string;
  env: Record<string, string | undefined>;
  explicitStore?: string;
}): string {
  const explicitStore = readFirstNonEmpty(params.explicitStore, params.configuredStore);
  if (explicitStore) {
    return resolveCronStorePath(explicitStore);
  }

  // The gateway keeps monitor records beside its cron store. Derive the
  // default from the normalized service environment instead of module-level
  // CONFIG_DIR so consumer/profile installs cannot inherit the caller's store.
  return path.join(resolveStateDir(params.env as NodeJS.ProcessEnv), "cron", "jobs.json");
}

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
  const cfg = await readWhatsAppMonitorConfigForEnv(daemonEnv);
  const gatewayPort = resolveGatewayPort(cfg, daemonEnv as NodeJS.ProcessEnv);
  const cronStore = resolveWhatsAppMonitorCronStorePath({
    configuredStore: cfg.cron?.store,
    env: daemonEnv,
    explicitStore: params.cronStore,
  });
  const hookUrl = resolveLocalWhatsAppMonitorHookUrl(
    params.hookUrl?.trim() ||
      resolveDefaultWhatsAppMonitorHookUrl({ env: daemonEnv, port: gatewayPort }),
  );
  const { programArguments, workingDirectory } = await resolveWhatsAppMonitorProgramArguments({
    cronStore,
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
