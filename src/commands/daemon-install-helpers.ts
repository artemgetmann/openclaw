import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.js";
import { CONSUMER_PROFILE_PREFIX } from "../consumer/runtime-identity.js";
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

const LAUNCHD_PATH_FALLBACK = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function isConsumerGatewayServiceEnv(environment: Record<string, string | undefined>): boolean {
  const profile = environment.OPENCLAW_PROFILE?.trim().toLowerCase();
  return (
    profile === CONSUMER_PROFILE_PREFIX ||
    Boolean(profile?.startsWith(`${CONSUMER_PROFILE_PREFIX}-`))
  );
}

function addUniquePathEntry(entries: string[], seen: Set<string>, entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed || seen.has(trimmed)) {
    return;
  }
  entries.push(trimmed);
  seen.add(trimmed);
}

export function buildConsumerGatewayLaunchdPath(params: {
  environment: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): string | undefined {
  const platform = params.platform ?? process.platform;
  if (platform !== "darwin" || !isConsumerGatewayServiceEnv(params.environment)) {
    return undefined;
  }

  const stateDir = params.environment.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    return undefined;
  }

  const entries: string[] = [];
  const seen = new Set<string>();
  // Consumer app installs carry a bundled Node under the runtime state dir.
  // launchd does not run through the user's shell startup files, so this bin
  // directory must be first for subprocesses that resolve node/npm/npx by PATH.
  addUniquePathEntry(entries, seen, path.posix.join(stateDir, "tools", "node", "bin"));
  for (const entry of params.environment.PATH?.split(path.posix.delimiter) ?? []) {
    addUniquePathEntry(entries, seen, entry);
  }
  for (const entry of LAUNCHD_PATH_FALLBACK) {
    addUniquePathEntry(entries, seen, entry);
  }

  return entries.join(path.posix.delimiter);
}

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

function normalizeMainRepoRootForDefaultSharedInstall(
  repoRoot: string | undefined,
): string | undefined {
  const trimmed = repoRoot?.trim();
  if (!trimmed) {
    return undefined;
  }

  // Repo-owned feature lanes live at <mainRepo>/.worktrees/<lane>. The default
  // shared service must remember <mainRepo>, never the temporary lane, or later
  // runtime ownership checks will bless the wrong checkout as canonical.
  return trimmed.replace(/[\\/]\.worktrees[\\/].*$/, "");
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  platform?: NodeJS.Platform;
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
    platform: params.platform,
    launchdLabel:
      (params.platform ?? process.platform) === "darwin"
        ? daemonEnv.OPENCLAW_LAUNCHD_LABEL?.trim() ||
          resolveGatewayLaunchAgentLabel(daemonEnv.OPENCLAW_PROFILE)
        : undefined,
  });
  if (isDefaultSharedGatewayServiceEnv(serviceEnvironment)) {
    serviceEnvironment.OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH ??=
      serviceEnvironment.OPENCLAW_CONFIG_PATH;
    const resolvedMainRepo = normalizeMainRepoRootForDefaultSharedInstall(
      serviceEnvironment.OPENCLAW_MAIN_REPO ??
        resolveRepoRootFromGatewayProgram({
          programArguments,
          workingDirectory,
        }),
    );
    if (resolvedMainRepo) {
      serviceEnvironment.OPENCLAW_MAIN_REPO = resolvedMainRepo;
    }
  }

  // Persist only daemon-owned env here. Provider keys/tokens and config.env are
  // loaded again at runtime through config/secrets resolution; freezing them
  // into launchd/systemd would let stale secrets survive normal restarts until
  // the service is explicitly reinstalled.
  const environment: Record<string, string | undefined> = {};
  Object.assign(environment, serviceEnvironment);
  const consumerLaunchdPath = buildConsumerGatewayLaunchdPath({
    environment,
    platform: params.platform,
  });
  if (consumerLaunchdPath) {
    environment.PATH = consumerLaunchdPath;
  }

  return { programArguments, workingDirectory, environment };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
