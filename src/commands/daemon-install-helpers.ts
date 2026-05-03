import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
  resolveGatewayLaunchAgentLabel,
} from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import {
  buildServiceEnvironment,
  resolveGatewayRuntimeIdentityEnv,
} from "../daemon/service-env.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";

export type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

function isDefaultSharedGatewayServiceEnv(
  environment: Record<string, string | undefined>,
): boolean {
  return (
    environment.OPENCLAW_LAUNCHD_LABEL === GATEWAY_LAUNCH_AGENT_LABEL ||
    environment.OPENCLAW_SYSTEMD_UNIT === `${GATEWAY_SYSTEMD_SERVICE_NAME}.service` ||
    environment.OPENCLAW_WINDOWS_TASK_NAME === GATEWAY_WINDOWS_TASK_NAME
  );
}

function resolveRepoRootFromGatewayProgram(params: {
  programArguments: string[];
  workingDirectory?: string;
}): string | undefined {
  if (params.workingDirectory?.trim()) {
    return params.workingDirectory.trim();
  }

  // Repo-backed installs run the built CLI as <repo>/dist/index.js. Persisting
  // the repo root lets runtime ownership checks distinguish canonical main from
  // a random package/global install without depending on the caller's shell env.
  for (const arg of params.programArguments) {
    const match = /^(.*)[/\\]dist[/\\][^/\\]+\.m?js$/.exec(arg);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
  /** Config stays available for call-site parity; install env must not persist config.env. */
  config?: OpenClawConfig;
}): Promise<GatewayInstallPlan> {
  const daemonEnv = resolveGatewayRuntimeIdentityEnv(params.env);
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: daemonEnv,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.port,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });
  await emitDaemonInstallRuntimeWarning({
    env: daemonEnv,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Gateway runtime",
  });
  const serviceEnvironment = buildServiceEnvironment({
    env: daemonEnv,
    port: params.port,
    launchdLabel:
      process.platform === "darwin"
        ? daemonEnv.OPENCLAW_LAUNCHD_LABEL?.trim() ||
          resolveGatewayLaunchAgentLabel(daemonEnv.OPENCLAW_PROFILE)
        : undefined,
  });
  if (isDefaultSharedGatewayServiceEnv(serviceEnvironment)) {
    serviceEnvironment.OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH ??=
      serviceEnvironment.OPENCLAW_CONFIG_PATH;
    serviceEnvironment.OPENCLAW_MAIN_REPO ??= resolveRepoRootFromGatewayProgram({
      programArguments,
      workingDirectory,
    });
  }

  // Persist only daemon-owned env here. Provider keys/tokens and config.env are
  // loaded again at runtime through config/secrets resolution; freezing them
  // into launchd/systemd would let stale secrets survive normal restarts until
  // the service is explicitly reinstalled.
  const environment: Record<string, string | undefined> = {};
  Object.assign(environment, serviceEnvironment);

  return { programArguments, workingDirectory, environment };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
