import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export type MacLaunchAgentDisableMarkerInfo = {
  path: string;
  metadata?: {
    disabledAt?: string;
    source?: string;
    reason?: string;
    stateDir?: string;
    worktree?: string;
    bundlePath?: string;
    instanceID?: string;
    pid?: number;
  };
};

function resolveMacLaunchAgentDisableStateDir(deps?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = deps?.env ?? process.env;
  const homeDir = deps?.homeDir ?? resolveHomeDir();
  return resolveStateDir(env, () => homeDir);
}

function readMarkerMetadata(
  markerPath: string,
  readFileSync: (path: string, encoding: BufferEncoding) => string,
): MacLaunchAgentDisableMarkerInfo["metadata"] | undefined {
  let raw = "";
  try {
    raw = readFileSync(markerPath, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const readString = (key: string) => {
      const value = parsed[key];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    };
    const pidValue = parsed.pid;
    const pid =
      typeof pidValue === "number" && Number.isFinite(pidValue) ? Math.trunc(pidValue) : undefined;
    return {
      disabledAt: readString("disabledAt"),
      source: readString("source"),
      reason: readString("reason"),
      stateDir: readString("stateDir"),
      worktree: readString("worktree"),
      bundlePath: readString("bundlePath"),
      instanceID: readString("instanceID"),
      pid,
    };
  } catch {
    return undefined;
  }
}

export function readMacLaunchAgentDisableMarker(deps?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
}): MacLaunchAgentDisableMarkerInfo | null {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }
  const markerPath = path.join(
    resolveMacLaunchAgentDisableStateDir({
      env: deps?.env,
      homeDir: deps?.homeDir,
    }),
    "disable-launchagent",
  );
  const existsSync = deps?.existsSync ?? fs.existsSync;
  if (!existsSync(markerPath)) {
    return null;
  }

  const readFileSync = deps?.readFileSync ?? fs.readFileSync;
  return {
    path: markerPath,
    metadata: readMarkerMetadata(markerPath, readFileSync),
  };
}

export function resolveMacLaunchAgentDisableMarkerPath(deps?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  existsSync?: (path: string) => boolean;
}): string | null {
  return (
    readMacLaunchAgentDisableMarker({
      platform: deps?.platform,
      env: deps?.env,
      homeDir: deps?.homeDir,
      existsSync: deps?.existsSync,
    })?.path ?? null
  );
}

export function formatMacLaunchAgentDisableMarkerNote(
  marker: MacLaunchAgentDisableMarkerInfo,
): string {
  const displayMarkerPath = shortenHomePath(marker.path);
  const lines = [`- LaunchAgent writes are disabled via ${displayMarkerPath}.`];
  if (marker.metadata?.source || marker.metadata?.reason) {
    const detail = [marker.metadata.source, marker.metadata.reason].filter(Boolean).join(" · ");
    lines.push(`- Provenance: ${detail}.`);
  }
  if (marker.metadata?.disabledAt) {
    lines.push(`- Set at: ${marker.metadata.disabledAt}.`);
  }
  if (marker.metadata?.worktree) {
    lines.push(`- Worktree: ${shortenHomePath(marker.metadata.worktree)}.`);
  } else if (marker.metadata?.bundlePath) {
    lines.push(`- Bundle: ${shortenHomePath(marker.metadata.bundlePath)}.`);
  }
  if (marker.metadata?.stateDir) {
    lines.push(`- Scope: ${shortenHomePath(marker.metadata.stateDir)}.`);
  }
  lines.push("- To restore default behavior:");
  lines.push(`  rm ${displayMarkerPath}`);
  return lines.join("\n");
}

export async function noteMacLaunchAgentOverrides(deps?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  noteFn?: typeof note;
}) {
  const marker = readMacLaunchAgentDisableMarker({
    platform: deps?.platform,
    env: deps?.env,
    homeDir: deps?.homeDir,
    existsSync: deps?.existsSync,
    readFileSync: deps?.readFileSync,
  });
  if (!marker) {
    return;
  }

  (deps?.noteFn ?? note)(formatMacLaunchAgentDisableMarkerNote(marker), "Gateway (macOS)");
}

async function launchctlGetenv(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("/bin/launchctl", ["getenv", name], { encoding: "utf8" });
    const value = String(result.stdout ?? "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasConfigGatewayCreds(cfg: OpenClawConfig): boolean {
  const localPassword = cfg.gateway?.auth?.password;
  const remoteToken = cfg.gateway?.remote?.token;
  const remotePassword = cfg.gateway?.remote?.password;
  return Boolean(
    hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults) ||
    hasConfiguredSecretInput(localPassword, cfg.secrets?.defaults) ||
    hasConfiguredSecretInput(remoteToken, cfg.secrets?.defaults) ||
    hasConfiguredSecretInput(remotePassword, cfg.secrets?.defaults),
  );
}

export async function noteMacLaunchctlGatewayEnvOverrides(
  cfg: OpenClawConfig,
  deps?: {
    platform?: NodeJS.Platform;
    getenv?: (name: string) => Promise<string | undefined>;
    noteFn?: typeof note;
  },
) {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return;
  }
  if (!hasConfigGatewayCreds(cfg)) {
    return;
  }

  const getenv = deps?.getenv ?? launchctlGetenv;
  const deprecatedLaunchctlEntries = [
    ["CLAWDBOT_GATEWAY_TOKEN", await getenv("CLAWDBOT_GATEWAY_TOKEN")],
    ["CLAWDBOT_GATEWAY_PASSWORD", await getenv("CLAWDBOT_GATEWAY_PASSWORD")],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  if (deprecatedLaunchctlEntries.length > 0) {
    const lines = [
      "- Deprecated launchctl environment variables detected (ignored).",
      ...deprecatedLaunchctlEntries.map(
        ([key]) =>
          `- \`${key}\` is set; use \`OPENCLAW_${key.slice(key.indexOf("_") + 1)}\` instead.`,
      ),
    ];
    (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
  }

  const tokenEntries = [
    ["OPENCLAW_GATEWAY_TOKEN", await getenv("OPENCLAW_GATEWAY_TOKEN")],
  ] as const;
  const passwordEntries = [
    ["OPENCLAW_GATEWAY_PASSWORD", await getenv("OPENCLAW_GATEWAY_PASSWORD")],
  ] as const;
  const tokenEntry = tokenEntries.find(([, value]) => value?.trim());
  const passwordEntry = passwordEntries.find(([, value]) => value?.trim());
  const envToken = tokenEntry?.[1]?.trim() ?? "";
  const envPassword = passwordEntry?.[1]?.trim() ?? "";
  const envTokenKey = tokenEntry?.[0];
  const envPasswordKey = passwordEntry?.[0];
  if (!envToken && !envPassword) {
    return;
  }

  const lines = [
    "- launchctl environment overrides detected (can cause confusing unauthorized errors).",
    envToken && envTokenKey
      ? `- \`${envTokenKey}\` is set; it overrides config tokens.`
      : undefined,
    envPassword
      ? `- \`${envPasswordKey ?? "OPENCLAW_GATEWAY_PASSWORD"}\` is set; it overrides config passwords.`
      : undefined,
    "- Clear overrides and restart the app/gateway:",
    envTokenKey ? `  launchctl unsetenv ${envTokenKey}` : undefined,
    envPasswordKey ? `  launchctl unsetenv ${envPasswordKey}` : undefined,
  ].filter((line): line is string => Boolean(line));

  (deps?.noteFn ?? note)(lines.join("\n"), "Gateway (macOS)");
}

export function noteDeprecatedLegacyEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  deps?: { noteFn?: typeof note },
) {
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith("CLAWDBOT_") && value?.trim())
    .map(([key]) => key);
  if (entries.length === 0) {
    return;
  }

  const lines = [
    "- Deprecated legacy environment variables detected (ignored).",
    "- Use OPENCLAW_* equivalents instead:",
    ...entries.map((key) => {
      const suffix = key.slice(key.indexOf("_") + 1);
      return `  ${key} -> OPENCLAW_${suffix}`;
    }),
  ];
  (deps?.noteFn ?? note)(lines.join("\n"), "Environment");
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTmpCompileCachePath(cachePath: string): boolean {
  const normalized = cachePath.trim().replace(/\/+$/, "");
  return (
    normalized === "/tmp" ||
    normalized.startsWith("/tmp/") ||
    normalized === "/private/tmp" ||
    normalized.startsWith("/private/tmp/")
  );
}

export function noteStartupOptimizationHints(
  env: NodeJS.ProcessEnv = process.env,
  deps?: {
    platform?: NodeJS.Platform;
    arch?: string;
    totalMemBytes?: number;
    noteFn?: typeof note;
  },
) {
  const platform = deps?.platform ?? process.platform;
  if (platform === "win32") {
    return;
  }
  const arch = deps?.arch ?? os.arch();
  const totalMemBytes = deps?.totalMemBytes ?? os.totalmem();
  const isArmHost = arch === "arm" || arch === "arm64";
  const isLowMemoryLinux =
    platform === "linux" && totalMemBytes > 0 && totalMemBytes <= 8 * 1024 ** 3;
  const isStartupTuneTarget = platform === "linux" && (isArmHost || isLowMemoryLinux);
  if (!isStartupTuneTarget) {
    return;
  }

  const noteFn = deps?.noteFn ?? note;
  const compileCache = env.NODE_COMPILE_CACHE?.trim() ?? "";
  const disableCompileCache = env.NODE_DISABLE_COMPILE_CACHE?.trim() ?? "";
  const noRespawn = env.OPENCLAW_NO_RESPAWN?.trim() ?? "";
  const lines: string[] = [];

  if (!compileCache) {
    lines.push(
      "- NODE_COMPILE_CACHE is not set; repeated CLI runs can be slower on small hosts (Pi/VM).",
    );
  } else if (isTmpCompileCachePath(compileCache)) {
    lines.push(
      "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
    );
  }

  if (isTruthyEnvValue(disableCompileCache)) {
    lines.push("- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.");
  }

  if (noRespawn !== "1") {
    lines.push(
      "- OPENCLAW_NO_RESPAWN is not set to 1; set it to avoid extra startup overhead from self-respawn.",
    );
  }

  if (lines.length === 0) {
    return;
  }

  const suggestions = [
    "- Suggested env for low-power hosts:",
    "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
    "  mkdir -p /var/tmp/openclaw-compile-cache",
    "  export OPENCLAW_NO_RESPAWN=1",
    isTruthyEnvValue(disableCompileCache) ? "  unset NODE_DISABLE_COMPILE_CACHE" : undefined,
  ].filter((line): line is string => Boolean(line));

  noteFn([...lines, ...suggestions].join("\n"), "Startup optimization");
}
