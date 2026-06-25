import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";

export type JarvisWorkspacePointerMigrationResult = {
  config: OpenClawConfig;
  changes: string[];
};

function normalizeHomeCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveUserHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string {
  // These migration paths are macOS user-home paths. OPENCLAW_HOME points at the
  // app runtime root in packaged Jarvis, so using it here would create a bogus
  // nested "Application Support/Jarvis/Library/Application Support/..." path.
  const envHome = normalizeHomeCandidate(env.HOME) ?? normalizeHomeCandidate(env.USERPROFILE);
  if (envHome) {
    return path.resolve(envHome);
  }
  try {
    return path.resolve(homedir());
  } catch {
    return path.resolve(process.cwd());
  }
}

function appSupportPath(home: string, appName: "OpenClaw" | "Jarvis", stateDir: string): string {
  return path.join(home, "Library", "Application Support", appName, stateDir, "workspace");
}

function expandHome(input: string, home: string): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function normalizeForComparison(input: string, home: string): string {
  return path.resolve(expandHome(input.trim(), home));
}

function isJarvisConfigPath(params: { configPath: string; home: string }): boolean {
  const expected = path.join(
    params.home,
    "Library",
    "Application Support",
    "Jarvis",
    ".jarvis",
    "openclaw.json",
  );
  return normalizeForComparison(params.configPath, params.home) === path.resolve(expected);
}

function shouldRepairJarvisWorkspacePointers(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
}): boolean {
  if (isJarvisConfigPath({ configPath: params.configPath, home: params.home })) {
    return true;
  }

  const stateDir = params.env.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    return false;
  }

  const jarvisStateDir = path.join(
    params.home,
    "Library",
    "Application Support",
    "Jarvis",
    ".jarvis",
  );
  return normalizeForComparison(stateDir, params.home) === path.resolve(jarvisStateDir);
}

export function migrateJarvisWorkspacePointers(params: {
  config: OpenClawConfig;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): JarvisWorkspacePointerMigrationResult {
  const env = params.env ?? process.env;
  const home = resolveUserHomeDir(env, params.homedir ?? os.homedir);
  if (
    !shouldRepairJarvisWorkspacePointers({
      configPath: params.configPath,
      env,
      home,
    })
  ) {
    return { config: params.config, changes: [] };
  }

  const legacyWorkspace = appSupportPath(home, "OpenClaw", ".openclaw");
  const canonicalWorkspace = appSupportPath(home, "Jarvis", ".jarvis");
  const normalizedLegacyWorkspace = normalizeForComparison(legacyWorkspace, home);
  const changes: string[] = [];
  let next: OpenClawConfig | null = null;

  const ensureNext = (): OpenClawConfig => {
    next ??= structuredClone(params.config);
    return next;
  };

  const shouldReplace = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    normalizeForComparison(candidate, home) === normalizedLegacyWorkspace;

  if (shouldReplace(params.config.agents?.defaults?.workspace)) {
    const writable = ensureNext();
    writable.agents = {
      ...writable.agents,
      defaults: {
        ...writable.agents?.defaults,
        workspace: canonicalWorkspace,
      },
    };
    changes.push(`agents.defaults.workspace: ${legacyWorkspace} -> ${canonicalWorkspace}`);
  }

  const list = params.config.agents?.list;
  if (Array.isArray(list)) {
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (!entry || typeof entry !== "object" || !shouldReplace(entry.workspace)) {
        continue;
      }
      const writable = ensureNext();
      const writableList = Array.isArray(writable.agents?.list) ? [...writable.agents.list] : [];
      writableList[index] = {
        ...entry,
        workspace: canonicalWorkspace,
      };
      writable.agents = {
        ...writable.agents,
        list: writableList,
      };
      const label =
        typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : String(index);
      changes.push(`agents.list[${label}].workspace: ${legacyWorkspace} -> ${canonicalWorkspace}`);
    }
  }

  return {
    config: next ?? params.config,
    changes,
  };
}
