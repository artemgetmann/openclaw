import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { resolveCommitHash } from "./git-commit.js";
import { resolveGitHeadPath } from "./git-root.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";

export type RuntimeFingerprint = {
  branch: string;
  worktree: string;
  stateDir: string;
  configPath: string;
  serviceLabel: string;
  runtimePackageVersion?: string;
  appProductVersion?: string;
  launchServiceVersion?: string;
  runtimeCommit?: string;
  runtimeSource?:
    | "sacred-main-checkout"
    | "jarvis-managed-bundle"
    | "isolated-test-worktree"
    | "source-checkout"
    | "unknown";
  guiCapabilities?: {
    guiControl: boolean;
    guiBenchmarkNativeApps: boolean;
    trustedLocalDefault: boolean;
  };
  openClawVersion?: string;
};

export function resolveRuntimeFingerprint(
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
    platform?: NodeJS.Platform;
    serviceLabel?: string;
  } = {},
): RuntimeFingerprint {
  const env = params.env ?? process.env;
  const cwd = path.resolve(params.cwd ?? process.cwd());
  // Anchor identity to the package root when we are inside a git worktree so
  // status/startup output stays stable even if a subcommand runs from `src/`.
  const worktree =
    resolveOpenClawPackageRootSync({
      cwd,
      moduleUrl: params.moduleUrl,
    }) ?? cwd;
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const runtimePackageVersion = resolveRuntimeServiceVersion(
    { ...env, OPENCLAW_VERSION: undefined, OPENCLAW_SERVICE_VERSION: undefined },
    "unknown",
  );

  return {
    branch: resolveBranchName(worktree),
    worktree,
    stateDir,
    configPath,
    serviceLabel: params.serviceLabel ?? resolveGatewayServiceLabel(env, params.platform),
    runtimePackageVersion,
    appProductVersion: resolveAppProductVersion(env),
    launchServiceVersion: firstNonEmpty(env.OPENCLAW_SERVICE_VERSION),
    runtimeCommit:
      resolveCommitHash({ cwd: worktree, env, moduleUrl: params.moduleUrl }) ?? undefined,
    runtimeSource: classifyRuntimeSource({ worktree, env }),
    guiCapabilities: resolveRuntimeGuiCapabilities(worktree),
    openClawVersion: resolveRuntimeServiceVersion(env),
  };
}

function resolveRuntimeGuiCapabilities(worktree: string): RuntimeFingerprint["guiCapabilities"] {
  return {
    guiControl: runtimeFileExists(worktree, [
      "src/agents/tools/gui-control-tool.ts",
      "dist/agents/tools/gui-control-tool.js",
    ]),
    guiBenchmarkNativeApps: runtimeFileContains(
      worktree,
      ["src/gui-control/benchmark.ts"],
      ["native-apps"],
    ),
    trustedLocalDefault: runtimeFileContains(
      worktree,
      ["src/gui-control/policy.ts"],
      ["const DEFAULT_GUI_TASK_POLICY", 'taskId: "trusted_local_gui_control"'],
    ),
  };
}

function runtimeFileExists(worktree: string, relativePaths: string[]): boolean {
  return relativePaths.some((relativePath) => fs.existsSync(path.join(worktree, relativePath)));
}

function runtimeFileContains(
  worktree: string,
  relativePaths: string[],
  needles: string[],
): boolean {
  return relativePaths.some((relativePath) => {
    try {
      const text = fs.readFileSync(path.join(worktree, relativePath), "utf8");
      // Runtime capability flags should be proof from the fingerprinted runtime
      // root, not claims about whichever CLI checkout happened to ask status.
      return needles.every((needle) => text.includes(needle));
    } catch {
      return false;
    }
  });
}

export function formatRuntimeFingerprint(
  fingerprint: RuntimeFingerprint,
  formatPath: (value: string) => string = (value) => value,
): string {
  return [
    `branch=${fingerprint.branch}`,
    `worktree=${formatPath(fingerprint.worktree)}`,
    `stateDir=${formatPath(fingerprint.stateDir)}`,
    `configPath=${formatPath(fingerprint.configPath)}`,
    `serviceLabel=${fingerprint.serviceLabel}`,
    fingerprint.appProductVersion ? `appProductVersion=${fingerprint.appProductVersion}` : "",
    fingerprint.launchServiceVersion
      ? `launchServiceVersion=${fingerprint.launchServiceVersion}`
      : "",
    fingerprint.runtimePackageVersion
      ? `runtimePackageVersion=${fingerprint.runtimePackageVersion}`
      : "",
    fingerprint.runtimeCommit ? `runtimeCommit=${fingerprint.runtimeCommit}` : "",
    fingerprint.runtimeSource ? `runtimeSource=${fingerprint.runtimeSource}` : "",
    fingerprint.guiCapabilities
      ? `guiControl=${fingerprint.guiCapabilities.guiControl ? "yes" : "no"}`
      : "",
    fingerprint.guiCapabilities
      ? `guiBenchmark.nativeApps=${fingerprint.guiCapabilities.guiBenchmarkNativeApps ? "yes" : "no"}`
      : "",
    fingerprint.guiCapabilities
      ? `trustedLocalDefault=${fingerprint.guiCapabilities.trustedLocalDefault ? "yes" : "no"}`
      : "",
    fingerprint.openClawVersion ? `openClawVersion=${fingerprint.openClawVersion}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveAppProductVersion(env: NodeJS.ProcessEnv): string | undefined {
  return firstNonEmpty(env.OPENCLAW_APP_VERSION, env.OPENCLAW_PRODUCT_VERSION);
}

function classifyRuntimeSource(params: {
  worktree: string;
  env: NodeJS.ProcessEnv;
}): RuntimeFingerprint["runtimeSource"] {
  const normalizedWorktree = path.resolve(params.worktree);
  const home = params.env.HOME || process.env.HOME || "";
  const sacredMain = home ? path.join(home, "Programming_Projects", "openclaw") : "";
  if (sacredMain && normalizedWorktree === path.resolve(sacredMain)) {
    return "sacred-main-checkout";
  }
  if (
    normalizedWorktree.includes(
      `${path.sep}Library${path.sep}Application Support${path.sep}Jarvis${path.sep}`,
    ) ||
    normalizedWorktree.includes(`${path.sep}.jarvis${path.sep}lib${path.sep}openclaw-bundled`)
  ) {
    return "jarvis-managed-bundle";
  }
  if (normalizedWorktree.includes(`${path.sep}.worktrees${path.sep}`)) {
    return "isolated-test-worktree";
  }
  return normalizedWorktree ? "source-checkout" : "unknown";
}

function resolveBranchName(searchDir: string): string {
  const headPath = resolveGitHeadPath(searchDir);
  if (!headPath) {
    return "unknown";
  }

  try {
    const head = fs.readFileSync(headPath, "utf-8").trim();
    if (!head) {
      return "unknown";
    }
    // Detached checkouts still matter for diagnostics; keep the explicit HEAD
    // marker instead of inventing a branch name from a commit hash.
    if (!head.startsWith("ref:")) {
      return "HEAD";
    }

    const ref = head.replace(/^ref:\s*/i, "").trim();
    const headBranch = ref.match(/^refs\/heads\/(.+)$/)?.[1]?.trim();
    return headBranch || "HEAD";
  } catch {
    return "unknown";
  }
}

function resolveGatewayServiceLabel(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicitLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (explicitLabel) {
    return explicitLabel;
  }
  const profile = env.OPENCLAW_PROFILE;
  if (platform === "darwin") {
    return resolveGatewayLaunchAgentLabel(profile);
  }
  if (platform === "win32") {
    return resolveGatewayWindowsTaskName(profile);
  }
  return `${resolveGatewaySystemdServiceName(profile)}.service`;
}
