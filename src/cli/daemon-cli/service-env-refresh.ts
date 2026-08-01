import path from "node:path";
import { runCommandWithTimeout } from "../../process/exec.js";
import { pathExists } from "../../utils.js";
import { resolveNodeRunner } from "../update-cli/shared.js";
import { runDaemonInstall } from "./install.js";

const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "CLAWDBOT_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "CLAWDBOT_CONFIG_PATH",
] as const;

function resolveGatewayInstallEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return [
    path.join(root, "dist", "entry.js"),
    path.join(root, "dist", "entry.mjs"),
    path.join(root, "dist", "index.js"),
    path.join(root, "dist", "index.mjs"),
  ];
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    if (rawValue.startsWith("~") || path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue)) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    // The update may replace its original working directory. Preserve the
    // invocation-relative meaning captured before mutation instead of
    // resolving a service path from the guarded child's package directory.
    resolvedEnv[key] = invocationCwd ? path.resolve(invocationCwd, rawValue) : rawValue;
  }
  return resolvedEnv;
}

/**
 * Rebuild the installed gateway service definition from the updated package.
 *
 * On macOS this function must run only after the gateway lifecycle lease has
 * been admitted: `gateway install --force` can bootout and bootstrap launchd.
 * Keeping the operation callable from the guarded restart child preserves the
 * update contract when the original update process does not own the lease.
 */
export async function refreshGatewayServiceEnv(params: {
  root?: string;
  jsonMode: boolean;
  invocationCwd?: string;
}): Promise<void> {
  const args = ["gateway", "install", "--force"];
  if (params.jsonMode) {
    args.push("--json");
  }

  for (const candidate of resolveGatewayInstallEntrypointCandidates(params.root)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const res = await runCommandWithTimeout([resolveNodeRunner(), candidate, ...args], {
      cwd: params.root,
      env: resolveServiceRefreshEnv(process.env, params.invocationCwd),
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `updated install refresh failed (${candidate}): ${formatCommandFailure(res.stdout, res.stderr)}`,
    );
  }

  await runDaemonInstall({ force: true, json: params.jsonMode || undefined });
}
