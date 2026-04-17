import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";

function normalizeTokenList(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizePathForComparison(targetPath: string | null | undefined): string | null {
  const trimmed = targetPath?.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function execText(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseLaunchctlPid(output: string): number | null {
  const rawPid =
    output.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1] ??
    output.match(/^\s*"pid"\s*=\s*(\d+)\s*$/m)?.[1] ??
    "";
  const pid = Number.parseInt(rawPid, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function resolveCanonicalSharedGatewayLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_CANONICAL_SHARED_GATEWAY_LABEL?.trim() || "ai.openclaw.gateway";
}

export function isCanonicalSharedGatewayActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const canonicalMainRepoRoot = resolveCanonicalMainRepoRoot(env);
  if (!canonicalMainRepoRoot || typeof process.getuid !== "function") {
    return false;
  }

  // Only count the shared runtime as active when launchd still points at the
  // canonical main checkout. A loaded-but-detached label should not reserve bots.
  const launchctlTarget = `gui/${process.getuid()}/${resolveCanonicalSharedGatewayLabel(env)}`;
  const launchState = execText("launchctl", ["print", launchctlTarget], env);
  const pid = parseLaunchctlPid(launchState);
  if (!launchState || pid === null) {
    return false;
  }

  const expectedRuntime = path.join(canonicalMainRepoRoot, "dist", "index.js");
  const expectedEntrypoint = path.join(canonicalMainRepoRoot, "openclaw.mjs");
  if (!launchState.includes(expectedRuntime) && !launchState.includes(expectedEntrypoint)) {
    return false;
  }

  const command = execText("ps", ["-o", "command=", "-p", String(pid)], env);
  return Boolean(
    command &&
    (command.includes(expectedRuntime) ||
      command.includes(expectedEntrypoint) ||
      command.includes(" gateway run") ||
      command.includes("openclaw-gateway")),
  );
}

export function extractTelegramBotTokensFromConfig(
  config: OpenClawConfig,
  opts: {
    includeDisabledAccounts?: boolean;
  } = {},
): string[] {
  const tokens: string[] = [];
  const telegram =
    config.channels && typeof config.channels === "object" && config.channels.telegram
      ? config.channels.telegram
      : null;

  if (telegram && typeof telegram === "object") {
    if (typeof telegram.botToken === "string" && telegram.botToken.trim()) {
      tokens.push(telegram.botToken.trim());
    }

    const accounts =
      telegram.accounts && typeof telegram.accounts === "object" ? telegram.accounts : {};
    for (const entry of Object.values(accounts)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      // Disabled canonical accounts are not started by the shared gateway, so
      // their tokens should not be treated as actively owned.
      if (!opts.includeDisabledAccounts && "enabled" in entry && entry.enabled === false) {
        continue;
      }
      if (typeof entry.botToken === "string" && entry.botToken.trim()) {
        tokens.push(entry.botToken.trim());
      }
    }
  }

  return normalizeTokenList(tokens);
}

export function resolveCanonicalMainRepoRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME?.trim() || process.env.HOME?.trim() || os.homedir();
  const candidates = [
    env.OPENCLAW_MAIN_REPO?.trim(),
    home ? path.join(home, "Programming_Projects", "openclaw") : "",
    home ? path.join(home, "Projects", "openclaw") : "",
  ]
    .filter(Boolean)
    .map((candidate) => normalizePathForComparison(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, ".git")) ||
      fs.existsSync(path.join(candidate, "package.json"))
    ) {
      return candidate;
    }
  }

  return null;
}

export function resolveCanonicalSharedGatewayConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const home = env.HOME?.trim() || process.env.HOME?.trim() || os.homedir();
  const explicit =
    env.OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH?.trim() ||
    env.OPENCLAW_SHARED_GATEWAY_CONFIG_PATH?.trim();
  const candidates = [explicit, home ? path.join(home, ".openclaw", "openclaw.json") : ""]
    .filter(Boolean)
    .map((candidate) => normalizePathForComparison(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? null;
}

export function isCanonicalSharedGatewayConfigPath(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalizedConfigPath = normalizePathForComparison(configPath);
  const canonicalConfigPath = resolveCanonicalSharedGatewayConfigPath(env);
  return Boolean(
    normalizedConfigPath && canonicalConfigPath && normalizedConfigPath === canonicalConfigPath,
  );
}

function readCanonicalSharedGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig | null {
  const configPath = resolveCanonicalSharedGatewayConfigPath(env);
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
  } catch {
    return null;
  }
}

export function collectProtectedCanonicalTelegramBotTokens(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isCanonicalSharedGatewayActive(env)) {
    return [];
  }

  const canonicalConfig = readCanonicalSharedGatewayConfig(env);
  if (!canonicalConfig) {
    return [];
  }

  return extractTelegramBotTokensFromConfig(canonicalConfig);
}

export type ProtectedTelegramTokenConflict = {
  tokens: string[];
  protectedBy: string;
};

export function detectProtectedTelegramTokenConflict(params: {
  config: OpenClawConfig;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}): ProtectedTelegramTokenConflict | null {
  const env = params.env ?? process.env;
  if (isCanonicalSharedGatewayConfigPath(params.configPath, env)) {
    return null;
  }

  const configuredTokens = extractTelegramBotTokensFromConfig(params.config);
  if (configuredTokens.length === 0) {
    return null;
  }

  const protectedTokens = collectProtectedCanonicalTelegramBotTokens(env);
  if (protectedTokens.length === 0) {
    return null;
  }

  const conflictingTokens = configuredTokens.filter((token) => protectedTokens.includes(token));
  if (conflictingTokens.length === 0) {
    return null;
  }

  return {
    tokens: normalizeTokenList(conflictingTokens),
    protectedBy:
      resolveCanonicalSharedGatewayConfigPath(env) ??
      path.join(
        env.HOME?.trim() || process.env.HOME?.trim() || os.homedir(),
        ".openclaw",
        "openclaw.json",
      ),
  };
}
