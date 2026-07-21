import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayRuntimeIdentityEnv } from "../daemon/service-env.js";
import {
  normalizeTelegramUserMonitorSelector,
  readTelegramUserMonitorBinding,
} from "./monitor-service-binding.js";
import type {
  TelegramUserAuthStatus,
  TelegramUserBackendMeta,
  TelegramUserBackendError,
  TelegramUserBackendOptions,
  TelegramUserDownloadResult,
  TelegramUserInboxResult,
  TelegramUserLoginResult,
  TelegramUserLogoutResult,
  TelegramUserMarkReadResult,
  TelegramUserMarkUnreadResult,
  TelegramUserPrecheck,
  TelegramUserReadResult,
  TelegramUserSendResult,
  TelegramUserTopicCreateResult,
  TelegramUserTopicDeleteResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const telegramUserBackendTimeoutMs = 60_000;
const telegramUserReadOnlyBackendCommands = new Set(["status", "precheck", "read", "inbox"]);

const telegramUserToolingFiles = [
  "requirements.txt",
  "telethon_cli.py",
  "telethon_compat.py",
] as const;

function hasTelegramUserTooling(candidate: string): boolean {
  const toolingDir = path.join(candidate, "scripts", "telegram-e2e");
  return telegramUserToolingFiles.every((fileName) =>
    fsSync.existsSync(path.join(toolingDir, fileName)),
  );
}

export function resolveTelegramUserToolingRoot(
  params: {
    cwd?: string;
    importDir?: string;
  } = {},
): string {
  const cwd = params.cwd ?? process.cwd();
  const importDir = params.importDir ?? path.dirname(fileURLToPath(import.meta.url));
  const directCandidates = [
    // Package/runtime layout: openclaw.mjs + dist/ + scripts/ live together.
    path.resolve(importDir, ".."),
    // Source/test layouts may execute from dist/ or transpiled subdirectories.
    path.resolve(importDir, "..", ".."),
    path.resolve(importDir, "..", "..", ".."),
    // The caller's working directory is a compatibility fallback. It must not
    // beat the runtime that loaded this module, or installed apps can pick up
    // stale Telegram tooling from whatever checkout the shell happens to be in.
    cwd,
  ];

  for (const candidate of new Set(directCandidates.map((entry) => path.resolve(entry)))) {
    if (hasTelegramUserTooling(candidate)) {
      return candidate;
    }
  }

  let current = path.resolve(cwd);
  while (true) {
    if (hasTelegramUserTooling(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error("Could not locate Telegram user tooling assets.");
}

const toolingRoot = resolveTelegramUserToolingRoot();
const telegramE2eDir = path.join(toolingRoot, "scripts", "telegram-e2e");
const backendScriptPath = path.join(telegramE2eDir, "telethon_cli.py");
const requirementsPath = path.join(telegramE2eDir, "requirements.txt");
const repoLocalEnvFilePath = path.join(telegramE2eDir, ".env.local");
const repoLocalSessionPath = path.join(telegramE2eDir, "tmp", "userbot.session");
const repoLocalSessionSelectorPath = path.join(telegramE2eDir, "tmp", "userbot.session.path");
function resolveTelegramUserMachineDir(env: NodeJS.ProcessEnv): string {
  return path.join(readNonEmpty(env.HOME) ?? os.homedir(), ".openclaw", "telegram-user");
}

function resolveTelegramUserMachineSessionPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveTelegramUserMachineDir(env), "userbot.session");
}

function resolveTelegramUserMachineLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveTelegramUserMachineDir(env), "userbot.session.openclaw.lock");
}

type TelegramUserSessionSource =
  | "explicit"
  | "monitor-binding"
  | "env-file"
  | "process-env"
  | "legacy-repo"
  | "machine-default"
  | "state-default";

function readRepoLocalSessionSelector(): string | undefined {
  if (!fsSync.existsSync(repoLocalSessionSelectorPath)) {
    return undefined;
  }
  const selected = fsSync.readFileSync(repoLocalSessionSelectorPath, "utf8").trim();
  if (!selected || !path.isAbsolute(selected)) {
    throw new Error(
      "E_INVALID_SESSION_SELECTOR: worktree Telegram session selector must contain one absolute path.",
    );
  }
  return path.resolve(selected);
}

function isRecognizedLegacySession(value: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (
    normalized === "scripts/telegram-e2e/tmp/userbot.session" ||
    normalized === "scripts/telegram-e2e/userbot.session"
  ) {
    return true;
  }
  if (!path.isAbsolute(value)) {
    return false;
  }
  const stateDefault = path.join(resolveStateDir(env), "telegram-user", "userbot.session");
  const mainRepo = readNonEmpty(env.OPENCLAW_MAIN_REPO);
  const knownAbsolutePaths = [
    repoLocalSessionPath,
    path.join(telegramE2eDir, "userbot.session"),
    stateDefault,
    path.join(
      readNonEmpty(env.HOME) ?? os.homedir(),
      "Library",
      "Application Support",
      "Jarvis",
      ".jarvis",
      "telegram-user",
      "userbot.session",
    ),
    ...(mainRepo
      ? [
          path.join(mainRepo, "scripts", "telegram-e2e", "tmp", "userbot.session"),
          path.join(mainRepo, "scripts", "telegram-e2e", "userbot.session"),
        ]
      : []),
  ];
  return knownAbsolutePaths.some((candidate) => path.resolve(candidate) === path.resolve(value));
}

function assertNoImplicitSessionAmbiguity(candidates: Array<{ path: string; source: string }>) {
  const unique = new Map<string, string[]>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    unique.set(resolved, [...(unique.get(resolved) ?? []), candidate.source]);
  }
  if (unique.size <= 1) {
    return;
  }
  const sources = [...unique.values()].flat().join(",");
  throw new Error(
    `E_AMBIGUOUS_SESSION: divergent implicit Telegram session owners exist (${sources}). Set an absolute --session or USERBOT_SESSION.`,
  );
}

function dedupeImplicitSessionCandidates(
  candidates: Array<{ path: string; source: string }>,
): Array<{ path: string; source: string }> {
  const unique = new Map<string, { path: string; source: string }>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    const existing = unique.get(resolved);
    unique.set(resolved, {
      path: resolved,
      source: existing ? `${existing.source}+${candidate.source}` : candidate.source,
    });
  }
  return [...unique.values()];
}

function resolveTelegramUserDefaultPaths(
  env: NodeJS.ProcessEnv,
  options: {
    canonicalSession?: string | null;
    checkSessionAmbiguity?: boolean;
  } = {},
) {
  const telegramUserStateDir = path.join(resolveStateDir(env), "telegram-user");
  const preferRepoLocalCompat = env.OPENCLAW_TELEGRAM_USER_REPO_LOCAL_COMPAT === "1";
  const explicitCanonicalSession =
    readNonEmpty(options.canonicalSession) ??
    readNonEmpty(env.OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION);
  if (explicitCanonicalSession && !path.isAbsolute(explicitCanonicalSession)) {
    throw new Error("OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION must be an absolute path.");
  }
  const repoSessionSelector = readRepoLocalSessionSelector();
  const machineSession = resolveTelegramUserMachineSessionPath(env);
  const selectedMachineSession = explicitCanonicalSession ?? repoSessionSelector ?? machineSession;
  const stateLegacySession = path.join(telegramUserStateDir, "userbot.session");
  const implicitCandidates = dedupeImplicitSessionCandidates(
    explicitCanonicalSession
      ? [{ path: explicitCanonicalSession, source: "explicit-canonical" }]
      : repoSessionSelector
        ? [
            // A persisted selector is an ownership claim even before its SQLite
            // database exists. Keep it authoritative over state-local legacy,
            // but still detect a later-created machine default as a competing
            // owner instead of silently following a stale selector forever.
            { path: repoSessionSelector, source: "repo-selector" },
            ...(fsSync.existsSync(machineSession)
              ? [{ path: machineSession, source: "machine" }]
              : []),
          ]
        : [
            ...(fsSync.existsSync(machineSession)
              ? [{ path: machineSession, source: "machine" }]
              : []),
            ...(fsSync.existsSync(stateLegacySession)
              ? [{ path: stateLegacySession, source: "state-legacy" }]
              : []),
            ...(preferRepoLocalCompat && fsSync.existsSync(repoLocalSessionPath)
              ? [{ path: repoLocalSessionPath, source: "legacy-repo" }]
              : []),
          ],
  );
  if (options.checkSessionAmbiguity !== false) {
    assertNoImplicitSessionAmbiguity(implicitCandidates);
  }
  // With only one historical owner on disk, keep using that database without
  // copying it. Once more than one owner exists, the ambiguity guard above
  // refuses to guess which mutable SQLite history is authoritative.
  const soleExistingOwner =
    implicitCandidates.length === 1 ? implicitCandidates[0]?.path : undefined;
  return {
    telegramUserStateDir,
    defaultEnvFilePath:
      preferRepoLocalCompat && fsSync.existsSync(repoLocalEnvFilePath)
        ? repoLocalEnvFilePath
        : path.join(telegramUserStateDir, ".env.local"),
    defaultSessionPath: soleExistingOwner ?? selectedMachineSession,
  };
}

// Mutable tooling must follow the same canonical profile identity as selector
// bindings; otherwise one command can mix a raw profile venv with canonical
// credentials and session state.
const backendRuntimeEnv = resolveGatewayRuntimeIdentityEnv(process.env) as NodeJS.ProcessEnv;
const { telegramUserStateDir, defaultEnvFilePath, defaultSessionPath } =
  resolveTelegramUserDefaultPaths(backendRuntimeEnv, { checkSessionAmbiguity: false });
const loginPasswordEnvKey = "OPENCLAW_TELEGRAM_USER_LOGIN_PASSWORD";

type PythonInvocation = {
  argsPrefix: string[];
  command: string;
};

type BackendCallOptions = TelegramUserBackendOptions & {
  args: string[];
  envOverrides?: Record<string, string | undefined>;
};

type BackendEnvBuild = {
  env: NodeJS.ProcessEnv;
  meta: TelegramUserBackendMeta;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
};

const minTelethonVersion: ParsedVersion = { major: 1, minor: 43, patch: 1 };

function resolveVenvPythonPath(): string {
  if (process.platform === "win32") {
    return path.join(telegramUserStateDir, ".venv", "Scripts", "python.exe");
  }
  return path.join(telegramUserStateDir, ".venv", "bin", "python");
}

function parseVersion(raw: string): ParsedVersion | null {
  const trimmed = raw.trim().replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeastVersion(actual: ParsedVersion, minimum: ParsedVersion): boolean {
  if (actual.major !== minimum.major) {
    return actual.major > minimum.major;
  }
  if (actual.minor !== minimum.minor) {
    return actual.minor > minimum.minor;
  }
  return actual.patch >= minimum.patch;
}

async function readTelethonVersion(pythonPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      pythonPath,
      ["-c", "import telethon; print(getattr(telethon, '__version__', '0.0.0'))"],
      { timeout: 8_000 },
    );
    const version = stdout.trim();
    return version || null;
  } catch {
    return null;
  }
}

async function hasCompatibleTelethon(pythonPath: string): Promise<boolean> {
  const versionText = await readTelethonVersion(pythonPath);
  const parsed = versionText ? parseVersion(versionText) : null;
  return parsed !== null && isAtLeastVersion(parsed, minTelethonVersion);
}

function sanitizeBackendText(raw: string, env: NodeJS.ProcessEnv): string {
  let text = raw;
  for (const secret of [
    env.TELEGRAM_API_HASH,
    env.TELEGRAM_BOT_TOKEN,
    env.TG_BOT_TOKEN,
    env.OPENCLAW_TELEGRAM_USER_API_HASH,
    env[loginPasswordEnvKey],
  ]) {
    if (secret) {
      text = text.split(secret).join("<redacted>");
    }
  }
  return text.trim();
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadScopedEnvFile(
  envFilePath: string | null | undefined,
): Promise<Record<string, string>> {
  if (!envFilePath) {
    return {};
  }
  if (!(await fileExists(envFilePath))) {
    return {};
  }
  const raw = await fs.readFile(envFilePath, "utf8");
  const parsed = dotenv.parse(raw);
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

async function detectSystemPython(): Promise<PythonInvocation> {
  const candidates: PythonInvocation[] =
    process.platform === "win32"
      ? [
          { command: "py", argsPrefix: ["-3"] },
          { command: "python", argsPrefix: [] },
        ]
      : [
          { command: "python3", argsPrefix: [] },
          { command: "python", argsPrefix: [] },
        ];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.command, [...candidate.argsPrefix, "-c", "import sys"], {
        timeout: 8_000,
      });
      return candidate;
    } catch {
      // Try the next interpreter candidate.
    }
  }

  throw new Error("Python 3 is required for Telegram user E2E tooling.");
}

async function ensureTelethonPython(): Promise<string> {
  const venvPython = resolveVenvPythonPath();
  if (await fileExists(venvPython)) {
    if (await hasCompatibleTelethon(venvPython)) {
      return venvPython;
    }
    // Import-only health checks let stale Telethon builds survive forever.
    // Rebuild/upgrade the venv when the installed release is too old for the
    // current Telegram session schema.
  }

  const python = await detectSystemPython();
  const venvDir = path.join(telegramUserStateDir, ".venv");
  await fs.mkdir(telegramUserStateDir, { recursive: true });
  await execFileAsync(python.command, [...python.argsPrefix, "-m", "venv", venvDir], {
    timeout: 60_000,
  });
  await execFileAsync(
    venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
    {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (!(await hasCompatibleTelethon(venvPython))) {
    throw new Error("Telegram user tooling bootstrap installed an incompatible Telethon version.");
  }
  return venvPython;
}

function resolveTelegramCredSource(
  loadedEnv: Record<string, string>,
  key: "TELEGRAM_API_ID" | "TELEGRAM_API_HASH",
): TelegramUserBackendMeta["api_id_source"] {
  if ((loadedEnv[key] ?? "").trim()) {
    return "env-file";
  }
  if ((process.env[key] ?? "").trim()) {
    return "process-env";
  }
  return "missing";
}

function readNonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveTelegramUserSessionPath(params: {
  boundSession?: string | null;
  canonicalSession?: string | null;
  env?: NodeJS.ProcessEnv;
  explicitSession?: string | null;
  loadedEnv?: Record<string, string>;
}): string {
  return resolveTelegramUserSessionSelection(params).sessionPath;
}

export function resolveTelegramUserSessionSelection(params: {
  boundSession?: string | null;
  canonicalSession?: string | null;
  env?: NodeJS.ProcessEnv;
  explicitSession?: string | null;
  loadedEnv?: Record<string, string>;
}): { sessionPath: string; source: TelegramUserSessionSource } {
  const env = params.env ?? process.env;
  const candidates: Array<{
    raw: string | undefined;
    source: TelegramUserSessionSource;
  }> = [
    { raw: readNonEmpty(params.explicitSession), source: "explicit" },
    { raw: readNonEmpty(params.boundSession), source: "monitor-binding" },
    { raw: readNonEmpty(params.loadedEnv?.USERBOT_SESSION), source: "env-file" },
    { raw: readNonEmpty(env.USERBOT_SESSION), source: "process-env" },
    { raw: readNonEmpty(env.OPENCLAW_TELEGRAM_USER_SESSION), source: "process-env" },
  ];
  for (const candidate of candidates) {
    if (!candidate.raw) {
      continue;
    }
    // Only the two repo-relative spellings shipped by the legacy harness are
    // migrated. Any other relative selector would recreate cwd-dependent
    // worktree ownership, so separate accounts and hermetic tests must opt into
    // an unambiguous absolute path.
    const shouldMigrateLegacy =
      candidate.source !== "explicit" &&
      candidate.source !== "monitor-binding" &&
      isRecognizedLegacySession(candidate.raw, env);
    if (!shouldMigrateLegacy) {
      if (!path.isAbsolute(candidate.raw)) {
        throw new Error(
          `E_INVALID_SESSION_SELECTOR: ${candidate.source} Telegram session selector must be absolute.`,
        );
      }
      // Explicit selectors and arbitrary absolute env/process selectors are
      // authoritative. Return before touching implicit legacy candidates so a
      // divergent old database cannot make an explicit recovery command fail.
      return { sessionPath: path.resolve(candidate.raw), source: candidate.source };
    }

    // Recognized legacy values deliberately re-enter default resolution: they
    // are migration aliases, not separate-account overrides, and therefore must
    // fail closed when more than one historical owner exists.
    const { defaultSessionPath: runtimeDefaultSessionPath } = resolveTelegramUserDefaultPaths(env, {
      canonicalSession: params.canonicalSession,
    });
    const canonicalSession =
      readNonEmpty(params.canonicalSession) ??
      readNonEmpty(env.OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION) ??
      readRepoLocalSessionSelector() ??
      runtimeDefaultSessionPath;
    if (!path.isAbsolute(canonicalSession)) {
      throw new Error(
        `E_INVALID_SESSION_SELECTOR: ${candidate.source} Telegram session selector must be absolute.`,
      );
    }
    return { sessionPath: path.resolve(canonicalSession), source: candidate.source };
  }
  // Runtime identity normalization can replace a raw profile state directory
  // with canonical consumer app state. Only the truly implicit fallback reaches
  // this ambiguity check; every authoritative selector has already returned.
  const { defaultSessionPath: runtimeDefaultSessionPath } = resolveTelegramUserDefaultPaths(env, {
    canonicalSession: params.canonicalSession,
  });
  const runtimeStateSessionPath = path.join(
    resolveStateDir(env),
    "telegram-user",
    "userbot.session",
  );
  const source: TelegramUserSessionSource =
    path.resolve(runtimeDefaultSessionPath) === path.resolve(repoLocalSessionPath)
      ? "legacy-repo"
      : path.resolve(runtimeDefaultSessionPath) === path.resolve(runtimeStateSessionPath) &&
          path.resolve(runtimeDefaultSessionPath) !==
            path.resolve(resolveTelegramUserMachineSessionPath(env))
        ? "state-default"
        : "machine-default";
  return { sessionPath: path.resolve(runtimeDefaultSessionPath), source };
}

type TelegramUserBackendSelection = {
  envFilePath: string;
  loadedEnv: Record<string, string>;
  sessionPath: string;
  sessionSelection: {
    sessionPath: string;
    source: TelegramUserSessionSource;
  };
};

async function resolveTelegramUserBackendSelection(
  options: TelegramUserBackendOptions,
): Promise<TelegramUserBackendSelection> {
  const explicitEnvFile = normalizeTelegramUserMonitorSelector(options.envFile);
  // Service installation canonicalizes consumer profiles into their app-owned
  // state roots. Backend calls must use the same identity or they silently read
  // a different binding file from the raw shell profile state.
  const runtimeEnv = resolveGatewayRuntimeIdentityEnv(process.env) as NodeJS.ProcessEnv;
  // An explicit env file is a complete credential context. Do not even read a
  // damaged persisted binding first: it cannot influence this invocation and
  // must not make an explicit recovery command unusable.
  const binding = explicitEnvFile ? null : await readTelegramUserMonitorBinding(runtimeEnv);
  // Env-file discovery is independent from session ownership. Delay the
  // implicit-session ambiguity check until after --session/binding/env selectors
  // have had a chance to win in resolveTelegramUserSessionSelection.
  const { defaultEnvFilePath: runtimeDefaultEnvFilePath } = resolveTelegramUserDefaultPaths(
    runtimeEnv,
    { checkSessionAmbiguity: false },
  );
  const envFilePath = explicitEnvFile ?? binding?.envFile ?? runtimeDefaultEnvFilePath;
  const loadedEnv = await loadScopedEnvFile(envFilePath);
  const sessionSelection = resolveTelegramUserSessionSelection({
    explicitSession: options.session,
    // An explicit env file selects a complete credential context. Its
    // USERBOT_SESSION (or the normal fallback) must not inherit a stale session
    // from a different monitor-service binding.
    boundSession: explicitEnvFile ? undefined : binding?.session,
    env: runtimeEnv,
    loadedEnv,
  });
  return { envFilePath, loadedEnv, sessionPath: sessionSelection.sessionPath, sessionSelection };
}

export async function resolveTelegramUserBackendSelectors(
  options: TelegramUserBackendOptions,
): Promise<{ envFilePath: string; sessionPath: string }> {
  const { envFilePath, sessionPath } = await resolveTelegramUserBackendSelection(options);
  return { envFilePath, sessionPath };
}

export function resolveTelegramUserLockSelection(params: {
  env?: NodeJS.ProcessEnv;
  loadedEnv?: Record<string, string>;
}): { lockPath: string; scope: "explicit" | "machine" } {
  const env = params.env ?? process.env;
  // A managed process pin must beat copied/local credential files. Otherwise a
  // stale env-file override can silently split callers that the runtime intended
  // to serialize on one canonical lock.
  const explicitLockPath =
    readNonEmpty(env.OPENCLAW_TELEGRAM_USER_LOCK_PATH) ??
    readNonEmpty(params.loadedEnv?.OPENCLAW_TELEGRAM_USER_LOCK_PATH);
  if (explicitLockPath && !path.isAbsolute(explicitLockPath)) {
    throw new Error("E_INVALID_LOCK_SELECTOR: Telegram user lock override must be absolute.");
  }
  const machineLockPath = path.resolve(resolveTelegramUserMachineLockPath(env));
  const lockPath = path.resolve(explicitLockPath ?? machineLockPath);
  return {
    lockPath,
    // Managed runtimes commonly export the canonical path explicitly. Report
    // the effective ownership scope, not merely whether a selector was present.
    scope: lockPath === machineLockPath ? "machine" : "explicit",
  };
}

async function buildBackendEnv(options: TelegramUserBackendOptions): Promise<BackendEnvBuild> {
  // Credential values and USERBOT_SESSION must come from one file snapshot.
  // Re-reading after selector resolution could pair credentials from a replaced
  // env file with the previous account's resolved session path.
  const { envFilePath, loadedEnv, sessionPath, sessionSelection } =
    await resolveTelegramUserBackendSelection(options);
  const lockSelection = resolveTelegramUserLockSelection({
    env: process.env,
    loadedEnv,
  });
  return {
    env: {
      ...process.env,
      ...loadedEnv,
      OPENCLAW_TELEGRAM_USER_ENV_FILE: envFilePath,
      OPENCLAW_TELEGRAM_USER_LOCK_PATH: lockSelection.lockPath,
      OPENCLAW_TELEGRAM_USER_SESSION: sessionPath,
    },
    meta: {
      api_hash_source: resolveTelegramCredSource(loadedEnv, "TELEGRAM_API_HASH"),
      api_id_source: resolveTelegramCredSource(loadedEnv, "TELEGRAM_API_ID"),
      env_file: envFilePath,
      lock_scope: lockSelection.scope,
      session_source: sessionSelection.source,
      session_path: sessionPath,
    },
  };
}

function applyEnvOverrides(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  if (!overrides) {
    return env;
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      merged[key] = value;
      continue;
    }
    delete merged[key];
  }
  return merged;
}

function parseBackendJson<T>(raw: string, fallbackMessage: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

function parseBackendError(
  stderr: string,
  env: NodeJS.ProcessEnv,
  meta: TelegramUserBackendMeta,
): Error {
  const sanitized = sanitizeBackendText(stderr, env);
  if (!sanitized) {
    return new Error("Telegram user backend failed without diagnostic output.");
  }
  try {
    const parsed = JSON.parse(sanitized) as { error?: TelegramUserBackendError };
    if (parsed?.error?.message) {
      const details =
        parsed.error.code === "E_MISSING_CREDS"
          ? ` env_file=${meta.env_file} session=${meta.session_path} api_id_source=${meta.api_id_source} api_hash_source=${meta.api_hash_source}`
          : "";
      return new Error(`${parsed.error.code}: ${parsed.error.message}${details}`);
    }
  } catch {
    // Fall back to the raw sanitized stderr.
  }
  return new Error(sanitized);
}

function readExecErrorStderr(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) {
    return "";
  }
  const stderr = error.stderr;
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8");
  }
  return "";
}

/**
 * Preserve timeout semantics that Node's execFile reports out-of-band instead
 * of on stderr. Without this branch a timed-out Telegram command collapses to
 * "failed without diagnostic output", and agents cannot distinguish a safe
 * read retry from a send that Telegram may already have accepted.
 */
export function parseTelegramUserBackendExecError(
  error: unknown,
  params: {
    command: string;
    env: NodeJS.ProcessEnv;
    meta: TelegramUserBackendMeta;
    timeoutMs: number;
  },
): Error {
  const processError = error && typeof error === "object" ? error : undefined;
  const killed = processError && "killed" in processError ? processError.killed === true : false;
  const signal = processError && "signal" in processError ? processError.signal : undefined;
  const code = processError && "code" in processError ? processError.code : undefined;
  const timedOut = code === "ETIMEDOUT" || (killed && signal === "SIGTERM");

  if (timedOut) {
    // Only commands that cannot create duplicate messages, topics, auth
    // challenges, or local state changes are safe to repeat automatically.
    const retryGuidance = telegramUserReadOnlyBackendCommands.has(params.command)
      ? " The operation did not return a result and may be retried."
      : params.command === "send"
        ? " Telegram delivery state is unknown; read the target chat before retrying to avoid a duplicate message."
        : " The operation may have changed Telegram or local state; current state is unknown. Inspect current state before retrying.";
    return new Error(
      `E_BACKEND_TIMEOUT: Telegram user backend exceeded ${params.timeoutMs}ms.${retryGuidance}`,
    );
  }

  return parseBackendError(readExecErrorStderr(error), params.env, params.meta);
}

async function runBackendCommand<T>(options: BackendCallOptions): Promise<T> {
  const python = await ensureTelethonPython();
  const { env: baseEnv, meta } = await buildBackendEnv(options);
  const env = applyEnvOverrides(baseEnv, options.envOverrides);
  try {
    const { stdout } = await execFileAsync(python, [backendScriptPath, ...options.args], {
      cwd: toolingRoot,
      env,
      timeout: telegramUserBackendTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const sanitizedStdout = sanitizeBackendText(stdout, env);
    const parsed = parseBackendJson<T & { backend_meta?: TelegramUserBackendMeta }>(
      sanitizedStdout,
      "Telegram user backend returned invalid JSON output.",
    );
    parsed.backend_meta ??= meta;
    return parsed;
  } catch (error) {
    throw parseTelegramUserBackendExecError(error, {
      command: options.args[0] ?? "unknown",
      env,
      meta,
      timeoutMs: telegramUserBackendTimeoutMs,
    });
  }
}

function pushOptionalNumberArg(args: string[], flag: string, value: number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    args.push(flag, String(Math.trunc(value)));
  }
}

function pushOptionalStringArg(args: string[], flag: string, value: string | null | undefined) {
  if (typeof value === "string" && value.trim()) {
    args.push(flag, value);
  }
}

export function getTelegramUserDefaults() {
  return {
    backendScriptPath,
    defaultEnvFilePath,
    defaultSessionPath,
    telegramUserStateDir,
    telegramE2eDir,
  };
}

export async function runTelegramUserPrecheck(
  params: {
    chat?: string | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserPrecheck> {
  const args = ["precheck"];
  pushOptionalStringArg(args, "--chat", params.chat);
  return runBackendCommand<TelegramUserPrecheck>({
    ...params,
    args,
  });
}

export async function runTelegramUserStatus(
  params: {
    chat?: string | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserAuthStatus> {
  const args = ["status"];
  pushOptionalStringArg(args, "--chat", params.chat);
  return runBackendCommand<TelegramUserAuthStatus>({
    ...params,
    args,
  });
}

export async function runTelegramUserLogin(
  params: {
    code?: string | null;
    password?: string | null;
    phone: string;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserLoginResult> {
  const args = ["login", "--phone", params.phone];
  pushOptionalStringArg(args, "--code", params.code);
  return runBackendCommand<TelegramUserLoginResult>({
    ...params,
    args,
    envOverrides: {
      [loginPasswordEnvKey]: params.password ?? undefined,
    },
  });
}

export async function runTelegramUserLogout(
  params: TelegramUserBackendOptions,
): Promise<TelegramUserLogoutResult> {
  const args = ["logout"];
  return runBackendCommand<TelegramUserLogoutResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserSend(
  params: {
    caption?: string | null;
    chat: string;
    media?: string | null;
    message?: string | null;
    replyTo?: number | null;
    voice?: boolean | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserSendResult> {
  const args = ["send", "--chat", params.chat];
  pushOptionalStringArg(args, "--message", params.message);
  pushOptionalStringArg(args, "--media", params.media);
  pushOptionalStringArg(args, "--caption", params.caption);
  pushOptionalNumberArg(args, "--reply-to", params.replyTo);
  if (params.voice) {
    args.push("--voice");
  }
  return runBackendCommand<TelegramUserSendResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserTopicCreate(
  params: {
    chat: string;
    title: string;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserTopicCreateResult> {
  const args = ["topic-create", "--chat", params.chat, "--title", params.title];
  return runBackendCommand<TelegramUserTopicCreateResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserTopicDelete(
  params: {
    chat: string;
    topicAnchor: number;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserTopicDeleteResult> {
  const args = [
    "topic-delete",
    "--chat",
    params.chat,
    "--topic-anchor",
    String(params.topicAnchor),
  ];
  return runBackendCommand<TelegramUserTopicDeleteResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserRead(
  params: {
    afterId?: number | null;
    beforeId?: number | null;
    chat: string;
    contains?: string | null;
    limit?: number | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserReadResult> {
  const args = ["read", "--chat", params.chat];
  pushOptionalNumberArg(args, "--limit", params.limit);
  pushOptionalNumberArg(args, "--after-id", params.afterId);
  pushOptionalNumberArg(args, "--before-id", params.beforeId);
  pushOptionalStringArg(args, "--contains", params.contains);
  return runBackendCommand<TelegramUserReadResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserMarkRead(
  params: {
    chat: string;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserMarkReadResult> {
  return runBackendCommand<TelegramUserMarkReadResult>({
    ...params,
    args: ["mark-read", "--chat", params.chat],
  });
}

export async function runTelegramUserMarkUnread(
  params: {
    chat: string;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserMarkUnreadResult> {
  return runBackendCommand<TelegramUserMarkUnreadResult>({
    ...params,
    args: ["mark-unread", "--chat", params.chat],
  });
}

export async function runTelegramUserDownload(
  params: {
    chat: string;
    messageId: number;
    output: string;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserDownloadResult> {
  const args = ["download", "--chat", params.chat, "--message-id", String(params.messageId)];
  pushOptionalStringArg(args, "--output", params.output);
  return runBackendCommand<TelegramUserDownloadResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserInbox(
  params: {
    contains?: string | null;
    dmOnly?: boolean | null;
    limit?: number | null;
    unreadOnly?: boolean | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserInboxResult> {
  const args = ["inbox"];
  pushOptionalNumberArg(args, "--limit", params.limit);
  pushOptionalStringArg(args, "--contains", params.contains);
  if (params.unreadOnly) {
    args.push("--unread");
  }
  if (params.dmOnly) {
    args.push("--dm-only");
  }
  return runBackendCommand<TelegramUserInboxResult>({
    ...params,
    args,
  });
}

export function getTelegramUserDefaultPollIntervalMs(): number {
  return 1_000;
}

export function getTelegramUserDefaultWaitTimeoutMs(): number {
  return 45_000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
