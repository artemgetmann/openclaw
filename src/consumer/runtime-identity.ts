import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const CONSUMER_RUNTIME_ROOT_NAME = "OpenClaw" as const;
export const CONSUMER_STATE_DIR_NAME = ".openclaw" as const;
export const CONSUMER_CONFIG_FILE_NAME = "openclaw.json" as const;
export const CONSUMER_WORKSPACE_DIR_NAME = "workspace" as const;
export const CONSUMER_LOG_DIR_NAME = "logs" as const;
export const CONSUMER_PROFILE_PREFIX = "consumer" as const;
export const CONSUMER_LAUNCHD_LABEL_PREFIX = "ai.openclaw.consumer" as const;
export const CANONICAL_GATEWAY_LAUNCHD_LABEL = "ai.openclaw.gateway" as const;
export const CONSUMER_GATEWAY_BIND = "loopback" as const;
export const CANONICAL_GATEWAY_PORT = 18789 as const;
export const CONSUMER_GATEWAY_PORT_MIN = 20000 as const;
export const CONSUMER_GATEWAY_PORT_SPAN = 20000 as const;

export type ConsumerRuntimeIdentity = {
  normalizedId: string;
  runtimeRoot: string;
  stateDir: string;
  configPath: string;
  workspacePath: string;
  logDir: string;
  profile: string;
  launchdLabel: string;
  gatewayLaunchdLabel: string;
  defaultsPrefix: string;
  gatewayPort: number;
  gatewayBind: typeof CONSUMER_GATEWAY_BIND;
};

export function normalizeConsumerRuntimeId(raw?: string | null): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function inferConsumerRuntimeIdFromCheckout(params: {
  rootDir: string;
  absoluteGitDir?: string | null;
}): string {
  const absoluteGitDir = params.absoluteGitDir ?? readAbsoluteGitDir(params.rootDir);
  if (!absoluteGitDir?.includes("/worktrees/")) {
    return "";
  }

  // Worktree lanes should derive their runtime identity from the checkout name
  // so launch labels, state paths, and ports stay aligned even when callers
  // forget to pass an explicit instance id.
  return normalizeConsumerRuntimeId(path.basename(params.rootDir));
}

export function resolveConsumerRuntimeIdentity(
  params: {
    instanceId?: string | null;
    homeDir?: string;
  } = {},
): ConsumerRuntimeIdentity {
  const normalizedId = normalizeConsumerRuntimeId(params.instanceId);
  const homeDir = params.homeDir ?? os.homedir();
  const runtimeRoot = normalizedId
    ? path.join(
        homeDir,
        "Library",
        "Application Support",
        CONSUMER_RUNTIME_ROOT_NAME,
        "instances",
        normalizedId,
      )
    : path.join(homeDir, "Library", "Application Support", CONSUMER_RUNTIME_ROOT_NAME);
  const stateDir = path.join(runtimeRoot, CONSUMER_STATE_DIR_NAME);

  return {
    normalizedId,
    runtimeRoot,
    stateDir,
    configPath: path.join(stateDir, CONSUMER_CONFIG_FILE_NAME),
    workspacePath: path.join(stateDir, CONSUMER_WORKSPACE_DIR_NAME),
    logDir: path.join(stateDir, CONSUMER_LOG_DIR_NAME),
    profile: normalizedId ? `${CONSUMER_PROFILE_PREFIX}-${normalizedId}` : CONSUMER_PROFILE_PREFIX,
    launchdLabel: normalizedId
      ? `${CONSUMER_LAUNCHD_LABEL_PREFIX}.${normalizedId}`
      : CONSUMER_LAUNCHD_LABEL_PREFIX,
    gatewayLaunchdLabel: normalizedId
      ? `${CONSUMER_LAUNCHD_LABEL_PREFIX}.${normalizedId}.gateway`
      : CANONICAL_GATEWAY_LAUNCHD_LABEL,
    defaultsPrefix: normalizedId
      ? `openclaw.consumer.instances.${normalizedId}`
      : "openclaw.consumer",
    // No instance id means "the one real local OpenClaw app", so it must use
    // the canonical gateway identity that the rest of the product already
    // expects. Named consumer/tester/worktree lanes remain isolated below.
    gatewayPort: normalizedId ? hashConsumerGatewayPort(normalizedId) : CANONICAL_GATEWAY_PORT,
    gatewayBind: CONSUMER_GATEWAY_BIND,
  };
}

function readAbsoluteGitDir(rootDir: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function hashConsumerGatewayPort(normalizedId: string): number {
  // Keep the existing FNV-1a byte walk so previously assigned worktree ports do
  // not drift during the first consolidation slice.
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(normalizedId, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CONSUMER_GATEWAY_PORT_MIN + (hash % CONSUMER_GATEWAY_PORT_SPAN);
}
