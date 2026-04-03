import fs from "node:fs";
import path from "node:path";

// Keep defaults to OS-managed immutable bins only.
// User/package-manager bins must be opted in via tools.exec.safeBinTrustedDirs.
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];

type TrustedSafeBinDirsParams = {
  baseDirs?: readonly string[];
  extraDirs?: readonly string[];
};

type TrustedSafeBinPathParams = {
  resolvedPath: string;
  trustedDirs?: ReadonlySet<string>;
};

type TrustedSafeBinCache = {
  key: string;
  dirs: Set<string>;
};

export type WritableTrustedSafeBinDir = {
  dir: string;
  groupWritable: boolean;
  worldWritable: boolean;
};

export type SuspiciousTrustedSafeBinDirHit = {
  dir: string;
  reason: string;
};

let trustedSafeBinCache: TrustedSafeBinCache | null = null;

function normalizeTrustedDir(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

export function normalizeTrustedSafeBinDirs(entries?: readonly string[] | null): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

export function classifySuspiciousTrustedSafeBinDir(
  value: string,
): SuspiciousTrustedSafeBinDirHit | null {
  const dir = normalizeTrustedDir(value);
  if (!dir) {
    return null;
  }
  const normalized = dir.replace(/\\/g, "/").toLowerCase();

  // Consumer runtimes are isolated on purpose. Founder/main trusting a consumer
  // Application Support cleanroom silently points exec at the wrong wrapper set.
  if (normalized.includes("/library/application support/openclaw consumer/")) {
    return {
      dir,
      reason: "consumer runtime cleanroom directory",
    };
  }

  // Worktree-local runtime bins are durable only for that lane. Trusting them
  // from another runtime creates stale exec policy that looks valid but misses
  // at runtime when the active wrapper set lives elsewhere.
  if (normalized.includes("/.worktrees/")) {
    return {
      dir,
      reason: "worktree-scoped runtime directory",
    };
  }

  return null;
}

function resolveTrustedSafeBinDirs(entries: readonly string[]): string[] {
  const resolved = entries
    .map((entry) => normalizeTrustedDir(entry))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(resolved)).toSorted();
}

function buildTrustedSafeBinCacheKey(entries: readonly string[]): string {
  return resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("\u0001");
}

export function buildTrustedSafeBinDirs(params: TrustedSafeBinDirsParams = {}): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  // Trust is explicit only. Do not derive from PATH, which is user/environment controlled.
  return new Set(
    resolveTrustedSafeBinDirs([
      ...normalizeTrustedSafeBinDirs(baseDirs),
      ...normalizeTrustedSafeBinDirs(extraDirs),
    ]),
  );
}

export function getTrustedSafeBinDirs(
  params: {
    baseDirs?: readonly string[];
    extraDirs?: readonly string[];
    refresh?: boolean;
  } = {},
): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  const key = buildTrustedSafeBinCacheKey([...baseDirs, ...extraDirs]);

  if (!params.refresh && trustedSafeBinCache?.key === key) {
    return trustedSafeBinCache.dirs;
  }

  const dirs = buildTrustedSafeBinDirs({
    baseDirs,
    extraDirs,
  });
  trustedSafeBinCache = { key, dirs };
  return dirs;
}

export function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): boolean {
  const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
  const resolvedDir = path.dirname(path.resolve(params.resolvedPath));
  return trustedDirs.has(resolvedDir);
}

export function listWritableExplicitTrustedSafeBinDirs(
  entries?: readonly string[] | null,
): WritableTrustedSafeBinDir[] {
  if (process.platform === "win32") {
    return [];
  }
  const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries));
  const hits: WritableTrustedSafeBinDir[] = [];
  for (const dir of resolved) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const mode = stat.mode & 0o777;
    const groupWritable = (mode & 0o020) !== 0;
    const worldWritable = (mode & 0o002) !== 0;
    if (!groupWritable && !worldWritable) {
      continue;
    }
    hits.push({ dir, groupWritable, worldWritable });
  }
  return hits;
}
