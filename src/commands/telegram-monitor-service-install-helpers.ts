import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
import {
  formatTelegramMonitorServiceDescription,
  resolveTelegramMonitorLaunchAgentLabel,
} from "../daemon/constants.js";
import { resolveTelegramMonitorProgramArguments } from "../daemon/program-args.js";
import {
  buildTelegramMonitorServiceEnvironment,
  resolveGatewayRuntimeIdentityEnv,
} from "../daemon/service-env.js";
import { resolveLocalTelegramMonitorHookUrl } from "../telegram-user/monitor-hook-url.js";
import {
  normalizeTelegramUserMonitorSelector,
  type TelegramUserMonitorBindingWrite,
} from "../telegram-user/monitor-service-binding.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type TelegramMonitorServiceInstallPlan = {
  binding: TelegramUserMonitorBindingWrite;
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

export function resolveDefaultTelegramMonitorHookUrl(params: {
  env: Record<string, string | undefined>;
  port?: number;
}): string {
  const port = params.port ?? readFirstNonEmpty(params.env.OPENCLAW_GATEWAY_PORT) ?? "18789";
  return `http://127.0.0.1:${port}/hooks/telegram-user-monitor-event`;
}

export async function buildTelegramMonitorServiceInstallPlan(params: {
  cronStore?: string;
  cursorStore?: string;
  env: Record<string, string | undefined>;
  envFile?: string;
  hookUrl?: string;
  intervalMs: number;
  limit?: number;
  monitorStore?: string;
  session?: string;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<TelegramMonitorServiceInstallPlan> {
  const daemonEnv = resolveGatewayRuntimeIdentityEnv(params.env);
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: daemonEnv,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const cfg = await readBestEffortConfig();
  const gatewayPort = resolveGatewayPort(cfg, daemonEnv as NodeJS.ProcessEnv);
  const hookUrl = resolveLocalTelegramMonitorHookUrl(
    params.hookUrl?.trim() ||
      resolveDefaultTelegramMonitorHookUrl({ env: daemonEnv, port: gatewayPort }),
  );
  // Resolve selectors once in the installer's working directory. LaunchAgents
  // may run from a different directory, so the poller and durable CLI binding
  // must both receive the exact same absolute paths.
  const envFile = normalizeTelegramUserMonitorSelector(params.envFile);
  const session = normalizeTelegramUserMonitorSelector(params.session);
  const { programArguments, workingDirectory } = await resolveTelegramMonitorProgramArguments({
    cronStore: params.cronStore,
    cursorStore: params.cursorStore,
    envFile,
    hookUrl,
    intervalMs: params.intervalMs,
    limit: params.limit,
    monitorStore: params.monitorStore,
    session,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });

  await emitDaemonInstallRuntimeWarning({
    env: daemonEnv,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Telegram monitor service runtime",
  });

  const environment = buildTelegramMonitorServiceEnvironment({ env: daemonEnv });
  const description = formatTelegramMonitorServiceDescription({
    profile: environment.OPENCLAW_PROFILE,
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return {
    binding: {
      env: daemonEnv as NodeJS.ProcessEnv,
      envFile,
      session,
    },
    description,
    environment: {
      ...environment,
      OPENCLAW_LAUNCHD_LABEL: resolveTelegramMonitorLaunchAgentLabel(environment.OPENCLAW_PROFILE),
    },
    programArguments,
    workingDirectory,
  };
}
