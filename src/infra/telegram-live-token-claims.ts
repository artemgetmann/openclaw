import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";

type ClaimedTelegramTokenIndex = Map<string, string[]>;

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

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvAssignmentLine(line: string, key: string): string | null {
  const match = line.match(new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[\\t ]*(.*)$`));
  if (!match) {
    return null;
  }
  return stripOuterQuotes(match[1].trim());
}

function readEnvAssignmentValue(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let lastValue: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parsed = parseEnvAssignmentLine(trimmed, key);
    if (parsed) {
      lastValue = parsed;
    }
  }
  return lastValue?.trim() || null;
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

function listFallbackWorktreePaths(repoRoot: string): string[] {
  const out = [repoRoot];
  const durableWorktreesDir = path.join(repoRoot, ".worktrees");
  if (!fs.existsSync(durableWorktreesDir) || !fs.statSync(durableWorktreesDir).isDirectory()) {
    return out;
  }

  for (const entry of fs.readdirSync(durableWorktreesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    out.push(path.join(durableWorktreesDir, entry.name));
  }
  return out;
}

function listKnownWorktreePaths(repoRoot: string): string[] {
  try {
    const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const worktrees = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => normalizePathForComparison(line.slice("worktree ".length)))
      .filter((candidate): candidate is string => Boolean(candidate));
    return normalizeTokenList(worktrees);
  } catch {
    return normalizeTokenList(listFallbackWorktreePaths(repoRoot));
  }
}

export function collectClaimedTelegramBotTokens(
  env: NodeJS.ProcessEnv = process.env,
): ClaimedTelegramTokenIndex {
  const repoRoot = resolveCanonicalMainRepoRoot(env);
  const claims: ClaimedTelegramTokenIndex = new Map();
  if (!repoRoot) {
    return claims;
  }

  // The telegram-live lane claims ownership via each worktree's `.env.local`.
  // Reading those claims gives startup a deterministic view of which tokens are
  // reserved for isolated live runtimes before any polling begins.
  for (const worktreePath of listKnownWorktreePaths(repoRoot)) {
    const token = readEnvAssignmentValue(
      path.join(worktreePath, ".env.local"),
      "TELEGRAM_BOT_TOKEN",
    );
    if (!token) {
      continue;
    }
    const existing = claims.get(token) ?? [];
    existing.push(worktreePath);
    claims.set(token, existing);
  }

  return claims;
}

export function isTelegramLiveRuntimeConfigPath(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalizedConfigPath = normalizePathForComparison(configPath);
  if (!normalizedConfigPath) {
    return false;
  }

  const stateRoot = normalizePathForComparison(
    env.OPENCLAW_TELEGRAM_LIVE_STATE_ROOT?.trim() ||
      path.join(
        env.HOME?.trim() || process.env.HOME?.trim() || os.homedir(),
        ".openclaw",
        "telegram-live-worktrees",
      ),
  );
  if (!stateRoot) {
    return false;
  }

  const relative = path.relative(stateRoot, normalizedConfigPath);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    path.basename(normalizedConfigPath) === "openclaw.telegram-live.json"
  );
}

export type ProtectedTelegramTokenConflict = {
  tokens: string[];
  claimPaths: string[];
};

export function detectProtectedTelegramTokenConflict(params: {
  config: OpenClawConfig;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}): ProtectedTelegramTokenConflict | null {
  const env = params.env ?? process.env;
  if (isTelegramLiveRuntimeConfigPath(params.configPath, env)) {
    return null;
  }

  const configuredTokens = extractTelegramBotTokensFromConfig(params.config);
  if (configuredTokens.length === 0) {
    return null;
  }

  const claimedTokens = collectClaimedTelegramBotTokens(env);
  const conflictingTokens: string[] = [];
  const claimPaths: string[] = [];

  for (const token of configuredTokens) {
    const claims = claimedTokens.get(token);
    if (!claims?.length) {
      continue;
    }
    conflictingTokens.push(token);
    claimPaths.push(...claims);
  }

  if (conflictingTokens.length === 0) {
    return null;
  }

  return {
    tokens: normalizeTokenList(conflictingTokens),
    claimPaths: normalizeTokenList(claimPaths),
  };
}
