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

export function extractTelegramBotTokensFromConfig(config: OpenClawConfig): string[] {
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
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
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
