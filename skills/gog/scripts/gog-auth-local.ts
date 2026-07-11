import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Phase =
  | "starting"
  | "waiting_for_browser"
  | "authorizing"
  | "authorized"
  | "stopped"
  | "error";

type GogAuthDiagnosticKind =
  | "oauth_client_missing"
  | "oauth_test_user_missing"
  | "api_not_enabled"
  | "callback_missed"
  | "keychain_approval_needed"
  | "browser_handoff_failed"
  | "auth_unknown";

type SessionStatus = {
  sessionId: string;
  phase: Phase;
  message: string;
  sessionDir: string;
  email: string;
  services: string;
  client?: string;
  readonly?: boolean;
  forceConsent?: boolean;
  authUrl?: string;
  logPath: string;
  pid?: number | null;
  workerPid?: number | null;
  lockPid?: number | null;
  authorized?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string | null;
  diagnosticKind?: GogAuthDiagnosticKind | null;
  nextStep?: string | null;
  updatedAt: string;
};

type GogAuthAccount = {
  email?: string;
  services?: string[];
};

type GogAuthListOutput = {
  accounts?: GogAuthAccount[];
};

const __filename = fileURLToPath(import.meta.url);
const SESSIONS_ROOT = path.join(os.tmpdir(), "openclaw-gog-auth");
const STATUS_FILE = "status.json";
const LOG_FILE = "gog-auth.log";
const AUTH_LOCK_FILE = "active-auth.lock";
const MACOS_LOCKF_PATH = "/usr/bin/lockf";
export const DEFAULT_CONSUMER_GOOGLE_SERVICES = "gmail,calendar,drive,contacts,docs,sheets";
export const AUTH_KEYRING_OPEN_TIMEOUT = "10m";
export const VERIFICATION_KEYRING_OPEN_TIMEOUT = "15s";
const AUTH_URL_RE = /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/;

function usage() {
  console.error(`Usage:
  gog-auth-local.sh start --email <email> [--services <csv>] [--client <name>] [--readonly] [--force-consent] [--timeout <duration>] [--session <id>]
  gog-auth-local.sh status --session <id>
  gog-auth-local.sh wait --session <id> [--timeout-ms <ms>]
  gog-auth-local.sh reopen --session <id>
  gog-auth-local.sh stop --session <id>

Notes:
  - start launches gog auth add in the background on this Mac so the browser flow can open locally.
  - wait blocks until the auth session finishes and verifies the account with gog auth list.
  - reopen opens the stored Google consent URL again when the browser handoff was missed.
  - stop terminates the helper if the user abandons the OAuth screen.`);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(arg, true);
      continue;
    }
    flags.set(arg, next);
    index += 1;
  }
  return { command, flags };
}

function requireFlag(flags: Map<string, string | boolean>, name: string) {
  const value = flags.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalFlag(flags: Map<string, string | boolean>, name: string) {
  const value = flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolFlag(flags: Map<string, string | boolean>, name: string) {
  return flags.get(name) === true;
}

function sessionDirFor(sessionId: string) {
  return path.join(SESSIONS_ROOT, sessionId);
}

/**
 * Reserve a session namespace exactly once before any mutable files exist.
 * Atomic mkdir closes the same-session TOCTOU: only one concurrent start can
 * own the status/log paths, while lockf remains the global auth-worker lock.
 */
export async function reserveAuthSessionDirectory(rootDir: string, sessionId: string) {
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
  ) {
    throw new Error("Google auth session ID must be one path-safe name");
  }
  await fsp.mkdir(rootDir, { recursive: true });
  const sessionDir = path.join(rootDir, sessionId);
  try {
    await fsp.mkdir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Google auth session ${sessionId} already exists. Continue that session or choose a new session ID.`,
      );
    }
    throw error;
  }
  return sessionDir;
}

function statusPathFor(sessionDir: string) {
  return path.join(sessionDir, STATUS_FILE);
}

async function ensureSessionsRoot() {
  await fsp.mkdir(SESSIONS_ROOT, { recursive: true });
}

async function writeStatus(sessionDir: string, patch: Partial<SessionStatus>) {
  const statusPath = statusPathFor(sessionDir);
  let current: SessionStatus | null = null;
  try {
    current = JSON.parse(await fsp.readFile(statusPath, "utf8")) as SessionStatus;
  } catch {
    current = null;
  }
  const next: SessionStatus = {
    sessionId: patch.sessionId ?? current?.sessionId ?? path.basename(sessionDir),
    phase: patch.phase ?? current?.phase ?? "starting",
    message: patch.message ?? current?.message ?? "Starting Google auth helper…",
    sessionDir: patch.sessionDir ?? current?.sessionDir ?? sessionDir,
    email: patch.email ?? current?.email ?? "",
    services: patch.services ?? current?.services ?? "user",
    client: patch.client ?? current?.client,
    readonly: patch.readonly ?? current?.readonly,
    forceConsent: patch.forceConsent ?? current?.forceConsent,
    authUrl: patch.authUrl ?? current?.authUrl,
    logPath: patch.logPath ?? current?.logPath ?? path.join(sessionDir, LOG_FILE),
    pid: Object.hasOwn(patch, "pid") ? (patch.pid ?? null) : (current?.pid ?? null),
    workerPid: Object.hasOwn(patch, "workerPid")
      ? (patch.workerPid ?? null)
      : (current?.workerPid ?? null),
    lockPid: Object.hasOwn(patch, "lockPid") ? (patch.lockPid ?? null) : (current?.lockPid ?? null),
    authorized: patch.authorized ?? current?.authorized,
    exitCode: Object.hasOwn(patch, "exitCode")
      ? (patch.exitCode ?? null)
      : (current?.exitCode ?? null),
    signal: Object.hasOwn(patch, "signal") ? (patch.signal ?? null) : (current?.signal ?? null),
    error: Object.hasOwn(patch, "error") ? (patch.error ?? null) : (current?.error ?? null),
    diagnosticKind: Object.hasOwn(patch, "diagnosticKind")
      ? (patch.diagnosticKind ?? null)
      : (current?.diagnosticKind ?? null),
    nextStep: Object.hasOwn(patch, "nextStep")
      ? (patch.nextStep ?? null)
      : (current?.nextStep ?? null),
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(statusPath, JSON.stringify(next, null, 2));
  return next;
}

async function readStatus(sessionId: string) {
  const raw = await fsp.readFile(statusPathFor(sessionDirFor(sessionId)), "utf8");
  return JSON.parse(raw) as SessionStatus;
}

function parseDurationMs(raw: string | boolean | undefined, fallbackMs: number) {
  if (typeof raw !== "string" || !raw.trim()) {
    return fallbackMs;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const match = trimmed.match(/^(\d+)(ms|s|m)$/i);
  if (!match) {
    throw new Error(`Unsupported duration: ${raw}`);
  }
  const value = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit === "ms") {
    return value;
  }
  if (unit === "s") {
    return value * 1000;
  }
  if (unit === "m") {
    return value * 60_000;
  }
  throw new Error(`Unsupported duration unit: ${unit}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give interactive auth enough time for a human Keychain decision, while
 * keeping read-only verification short so a background probe cannot leave a
 * forgotten SecurityAgent dialog behind. A deliberate non-empty operator
 * override remains authoritative; whitespace is treated as unset.
 */
export function gogSubprocessEnv(
  purpose: "auth" | "verification",
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const override = source.GOG_KEYRING_OPEN_TIMEOUT?.trim();
  return {
    ...source,
    GOG_KEYRING_OPEN_TIMEOUT:
      override ||
      (purpose === "auth" ? AUTH_KEYRING_OPEN_TIMEOUT : VERIFICATION_KEYRING_OPEN_TIMEOUT),
  };
}

function defaultIsProcessRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a worker under macOS' kernel-backed advisory lock. `-k` is essential:
 * the lock file inode remains stable forever, so no stale-owner cleanup can
 * rename or delete a replacement owner's pathname. The kernel releases the
 * lock when lockf or its command exits, including crashes and forced stops.
 */
export function spawnWithAuthOperationLock(params: {
  lockPath: string;
  command: string;
  args: string[];
  options?: SpawnOptions;
}): ChildProcess {
  return spawnChild(
    MACOS_LOCKF_PATH,
    ["-s", "-t", "0", "-k", params.lockPath, params.command, ...params.args],
    params.options ?? {},
  ) as ChildProcess;
}

function combinedErrorText(params: {
  lastErrorText: string;
  stdoutLines: string[];
  stderrLines: string[];
}) {
  return [params.lastErrorText, ...params.stderrLines, ...params.stdoutLines]
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function textIncludesAny(haystack: string, needles: string[]) {
  return needles.some((needle) => haystack.includes(needle));
}

export function classifyGoogleAuthFailure(params: {
  combinedText: string;
  email: string;
  hasAuthUrl: boolean;
  exitedSuccessfullyWithoutVerification?: boolean;
}): {
  diagnosticKind: GogAuthDiagnosticKind;
  message: string;
  nextStep: string;
} {
  const combined = params.combinedText.trim();
  const normalized = combined.toLowerCase();

  if (
    textIncludesAny(normalized, [
      "no oauth client credentials",
      "client credentials not found",
      "missing client credentials",
      "auth credentials",
      "client_secret",
    ])
  ) {
    return {
      diagnosticKind: "oauth_client_missing",
      message: "Google auth is not configured with OAuth client credentials yet.",
      nextStep:
        "Load the Google OAuth client credentials for this runtime, then retry the Google connection.",
    };
  }

  if (
    textIncludesAny(normalized, [
      "access blocked",
      "error 403: access_denied",
      "the developer hasn't given you access",
      "app is not verified",
      "hasn't completed the google verification process",
      "is restricted to users within its organization",
      "not a test user",
      "tester isn't authorized",
    ])
  ) {
    return {
      diagnosticKind: "oauth_test_user_missing",
      message: `This Google account (${params.email}) is not allowed to use the current OAuth app yet.`,
      nextStep:
        "In Google Cloud, add this account as a test user or switch the OAuth app out of Testing, then retry.",
    };
  }

  if (
    textIncludesAny(normalized, [
      "api has not been used in project",
      "api is not enabled for the project",
      "enable it by visiting",
      "access not configured",
      "drive api",
      "calendar api",
      "gmail api",
      "docs api",
      "sheets api",
      "people api",
    ])
  ) {
    return {
      diagnosticKind: "api_not_enabled",
      message: "The required Google API is not enabled in the selected Google Cloud project.",
      nextStep: "Enable the needed Google API for this project, then retry the Google connection.",
    };
  }

  if (
    textIncludesAny(normalized, [
      "user interaction is not allowed",
      "securityagent",
      "keychain",
      "keyring open timeout",
      "keyring open timed out",
      "timed out waiting for keyring",
      "touch id",
      "passkey",
      "biometric",
      "errsecinteractionnotallowed",
    ])
  ) {
    return {
      diagnosticKind: "keychain_approval_needed",
      message: "macOS did not receive Keychain approval in time, so Google setup stopped safely.",
      nextStep:
        "Unlock this Mac, retry Google setup, then complete the single Keychain prompt with your Mac login password and choose Always Allow.",
    };
  }

  if (
    params.hasAuthUrl &&
    textIncludesAny(normalized, [
      "timeout",
      "timed out",
      "state mismatch",
      "invalid_grant",
      "connection refused",
      "callback",
      "redirect",
      "localhost",
    ])
  ) {
    return {
      diagnosticKind: "callback_missed",
      message:
        "The Google approval page opened, but OpenClaw lost the local callback handoff before auth could finish.",
      nextStep:
        "Reopen the Google approval flow and finish the consent step quickly in the same browser window.",
    };
  }

  if (
    textIncludesAny(normalized, [
      "opening browser",
      "could not open browser",
      "failed to open browser",
      "browser did not appear",
    ])
  ) {
    return {
      diagnosticKind: "browser_handoff_failed",
      message:
        "OpenClaw could not hand off the Google approval flow cleanly to the browser on this Mac.",
      nextStep:
        "Retry the Google connection. If the browser still does not appear, reopen the stored auth URL manually.",
    };
  }

  // A successful auth-add exit followed by failed verification is only a
  // callback fallback. Provider evidence above is more specific and must win,
  // especially a bounded Keychain verification timeout.
  if (params.exitedSuccessfullyWithoutVerification) {
    return {
      diagnosticKind: "callback_missed",
      message:
        `Google consent finished, but OpenClaw could not confirm the local callback for ${params.email}. ` +
        "This usually means the browser handoff expired or completed too late.",
      nextStep:
        "Reopen the Google approval flow and finish the consent step immediately in the same browser window.",
    };
  }

  return {
    diagnosticKind: "auth_unknown",
    message: `Google auth failed for ${params.email}.`,
    nextStep:
      combined ||
      "Retry the Google connection. If it fails again, inspect the helper log for the exact provider error.",
  };
}

function tryKill(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid: number | undefined) {
  if (!pid || !defaultIsProcessRunning(pid)) {
    return true;
  }
  tryKill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20 && defaultIsProcessRunning(pid); attempt += 1) {
    await sleep(50);
  }
  if (defaultIsProcessRunning(pid)) {
    // Stop is an explicit cancellation. Escalating after a short grace period
    // is safer than releasing the single-flight lock while an old gog process
    // can still display a Keychain prompt beside a replacement worker.
    tryKill(pid, "SIGKILL");
    for (let attempt = 0; attempt < 20 && defaultIsProcessRunning(pid); attempt += 1) {
      await sleep(50);
    }
  }
  return !defaultIsProcessRunning(pid);
}

async function stopProcessGroup(groupLeaderPid: number | undefined) {
  if (!groupLeaderPid || groupLeaderPid <= 0) {
    return true;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-groupLeaderPid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) {
    return true;
  }
  await sleep(100);
  // A failed startup handshake must not orphan the lockf command child. Kill
  // the detached process group, not only the lockf parent, before returning.
  signalGroup("SIGKILL");
  return true;
}

async function readAuthList() {
  const child = spawnChild("gog", ["auth", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: gogSubprocessEnv("verification"),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Promise<string>((resolve) => {
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stdout?.on("end", () => resolve(out));
    }),
    new Promise<string>((resolve) => {
      let out = "";
      child.stderr?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stderr?.on("end", () => resolve(out));
    }),
    new Promise<number | null>((resolve) => {
      child.on("close", (exitCode) => resolve(exitCode));
    }),
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `gog auth list exited ${String(code)}`);
  }
  return JSON.parse(stdout) as GogAuthListOutput;
}

function servicesSatisfied(requestedServicesCsv: string, accountServices: string[] | undefined) {
  const requested = requestedServicesCsv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0 || requested.includes("user") || requested.includes("all")) {
    return true;
  }
  const actual = new Set((accountServices ?? []).map((value) => value.trim()).filter(Boolean));
  return requested.every((service) => actual.has(service));
}

async function verifyAuthorizedAccount(email: string, services: string) {
  const authList = await readAuthList();
  return (
    authList.accounts?.some(
      (account) =>
        account.email?.trim().toLowerCase() === email.trim().toLowerCase() &&
        servicesSatisfied(services, account.services),
    ) ?? false
  );
}

async function commandStart(flags: Map<string, string | boolean>) {
  const email = requireFlag(flags, "--email");
  const services = optionalFlag(flags, "--services") ?? DEFAULT_CONSUMER_GOOGLE_SERVICES;
  const client = optionalFlag(flags, "--client");
  const sessionId = optionalFlag(flags, "--session") ?? randomUUID();
  const sessionDir = sessionDirFor(sessionId);
  const timeout = optionalFlag(flags, "--timeout") ?? "10m";
  const readonly = boolFlag(flags, "--readonly");
  const forceConsent = boolFlag(flags, "--force-consent");

  await ensureSessionsRoot();
  await reserveAuthSessionDirectory(SESSIONS_ROOT, sessionId);
  const logPath = path.join(sessionDir, LOG_FILE);
  await fsp.writeFile(logPath, "", "utf8");
  await writeStatus(sessionDir, {
    sessionId,
    phase: "starting",
    message: "Starting Google auth helper…",
    sessionDir,
    email,
    services,
    client,
    readonly,
    forceConsent,
    logPath,
    workerPid: null,
    lockPid: null,
  });

  // lockf executes the Node worker only after acquiring the persistent lock
  // inode. A losing concurrent start exits before it can spawn gog or display
  // a Keychain prompt.
  const workerArgs = [
    "--import",
    "tsx",
    __filename,
    "worker",
    "--session",
    sessionId,
    "--email",
    email,
    "--services",
    services,
    "--timeout",
    timeout,
  ];
  if (client) {
    workerArgs.push("--client", client);
  }
  if (readonly) {
    workerArgs.push("--readonly");
  }
  if (forceConsent) {
    workerArgs.push("--force-consent");
  }
  const worker = spawnWithAuthOperationLock({
    lockPath: path.join(SESSIONS_ROOT, AUTH_LOCK_FILE),
    command: process.execPath,
    args: workerArgs,
    options: {
      detached: true,
      stdio: "ignore",
    },
  });
  if (!worker.pid) {
    throw new Error("Google auth lock worker did not start");
  }
  await writeStatus(sessionDir, { lockPid: worker.pid });

  try {
    const status = await waitForAuthWorkerStart(sessionId, worker);
    worker.unref();
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    await stopProcessGroup(worker.pid);
    const reason = error instanceof Error ? error.message : String(error);
    const contended = reason.includes("already in progress");
    await writeStatus(sessionDir, {
      phase: "error",
      message: contended
        ? "Another Google setup is already in progress on this Mac."
        : "Google setup could not start safely on this Mac.",
      workerPid: null,
      lockPid: null,
      diagnosticKind: "auth_unknown",
      nextStep: contended
        ? "Continue or stop the existing Google setup before retrying."
        : "Retry Google setup. If this repeats, update or reinstall the Jarvis app.",
    });
    throw error;
  }
}

async function waitForAuthWorkerStart(sessionId: string, lockProcess: ChildProcess) {
  let spawnError: Error | null = null;
  lockProcess.once("error", (error) => {
    spawnError = error;
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (spawnError) {
      throw spawnError;
    }
    const status = await readStatus(sessionId);
    if (status.workerPid) {
      return status;
    }
    if (lockProcess.exitCode !== null) {
      throw new Error(
        lockProcess.exitCode === 75
          ? "Google setup is already in progress. Continue that setup instead of starting another."
          : `Google auth lock worker exited ${String(lockProcess.exitCode)}`,
      );
    }
    await sleep(50);
  }
  throw new Error("Google auth worker did not report ready state in time");
}

async function runWorker(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const email = requireFlag(flags, "--email");
  const services = optionalFlag(flags, "--services") ?? DEFAULT_CONSUMER_GOOGLE_SERVICES;
  const client = optionalFlag(flags, "--client");
  const timeout = optionalFlag(flags, "--timeout") ?? "10m";
  const readonly = boolFlag(flags, "--readonly");
  const forceConsent = boolFlag(flags, "--force-consent");
  const sessionDir = sessionDirFor(sessionId);
  const logPath = path.join(sessionDir, LOG_FILE);

  const args = ["auth", "add", email, "--services", services, "--timeout", timeout];
  if (client) {
    args.push("--client", client);
  }
  if (readonly) {
    args.push("--readonly");
  }
  if (forceConsent) {
    args.push("--force-consent");
  }

  // Keep a structured status file so the agent can truthfully say "I opened the
  // browser" and later poll for completion instead of guessing from one reply.
  const child = spawnChild("gog", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: gogSubprocessEnv("auth"),
  });
  let lastErrorText = "";
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let authUrl: string | undefined;
  let authorizationReady = false;

  await writeStatus(sessionDir, {
    phase: "waiting_for_browser",
    message: "Opening the Google consent flow in the default browser on this Mac…",
    pid: child.pid,
    workerPid: process.pid,
  });

  const consumeChunk = async (chunk: string, source: "stdout" | "stderr") => {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    await fsp.appendFile(logPath, chunk);
    for (const line of lines) {
      if (source === "stdout") {
        stdoutLines.push(line);
      } else {
        stderrLines.push(line);
      }
      if (!authorizationReady && line.includes("Opening browser for authorization")) {
        authorizationReady = true;
        await writeStatus(sessionDir, {
          phase: "waiting_for_browser",
          message:
            "I opened the Google consent flow in the default browser on this Mac. Google may require sign-in, Touch ID, passkey approval, or 2FA there before I can continue.",
        });
      }
      if (!authUrl && AUTH_URL_RE.test(line)) {
        authUrl = line;
        await writeStatus(sessionDir, {
          authUrl,
          message:
            "I opened the Google consent flow in the default browser on this Mac. If the browser did not appear, use the authUrl from this session. Google may still require a manual sign-in or biometric step in the browser.",
        });
        continue;
      }
      if (source === "stderr") {
        lastErrorText = line;
      }
    }
  };

  child.stdout?.on("data", (chunk) => {
    void consumeChunk(chunk.toString(), "stdout");
  });
  child.stderr?.on("data", (chunk) => {
    void consumeChunk(chunk.toString(), "stderr");
  });

  // After the browser handoff, the remaining wait is user-driven consent. Make
  // that explicit in session status instead of looking like the process hung.
  const authorizingTimer = setTimeout(() => {
    void writeStatus(sessionDir, {
      phase: "authorizing",
      message:
        "Google auth is waiting for the browser consent step to finish on this Mac. Complete any Google password, Touch ID, passkey, or 2FA prompt there and I will resume automatically.",
    });
  }, 2000);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(authorizingTimer);

  if (result.code === 0) {
    try {
      const authorized = await verifyAuthorizedAccount(email, services);
      if (!authorized) {
        const classified = classifyGoogleAuthFailure({
          combinedText: combinedErrorText({ lastErrorText, stdoutLines, stderrLines }),
          email,
          hasAuthUrl: Boolean(authUrl),
          exitedSuccessfullyWithoutVerification: true,
        });
        await writeStatus(sessionDir, {
          phase: "error",
          message: classified.message,
          authorized: false,
          exitCode: result.code,
          signal: result.signal,
          pid: null,
          workerPid: null,
          lockPid: null,
          error: classified.nextStep,
          diagnosticKind: classified.diagnosticKind,
          nextStep: classified.nextStep,
        });
        return 1;
      }
      await writeStatus(sessionDir, {
        phase: "authorized",
        message:
          `Google Workspace core is connected for ${email}. Verified with gog auth list ` +
          `(${services}).`,
        authorized: true,
        exitCode: result.code,
        signal: result.signal,
        pid: null,
        workerPid: null,
        lockPid: null,
        error: null,
        diagnosticKind: null,
        nextStep: null,
      });
      return 0;
    } catch (error) {
      const classified = classifyGoogleAuthFailure({
        combinedText:
          error instanceof Error
            ? error.message
            : combinedErrorText({ lastErrorText, stdoutLines, stderrLines }),
        email,
        hasAuthUrl: Boolean(authUrl),
        exitedSuccessfullyWithoutVerification: true,
      });
      await writeStatus(sessionDir, {
        phase: "error",
        message: classified.message,
        authorized: false,
        exitCode: result.code,
        signal: result.signal,
        pid: null,
        workerPid: null,
        lockPid: null,
        error: error instanceof Error ? error.message : String(error),
        diagnosticKind: classified.diagnosticKind,
        nextStep: classified.nextStep,
      });
      return 1;
    }
    return;
  }

  const stopped = result.signal === "SIGTERM" || result.signal === "SIGINT";
  const classified = stopped
    ? null
    : classifyGoogleAuthFailure({
        combinedText: combinedErrorText({ lastErrorText, stdoutLines, stderrLines }),
        email,
        hasAuthUrl: Boolean(authUrl),
      });
  await writeStatus(sessionDir, {
    phase: stopped ? "stopped" : "error",
    message: stopped
      ? "Stopped Google auth helper."
      : (classified?.message ?? `Google auth failed for ${email}.`),
    authorized: false,
    exitCode: result.code,
    signal: result.signal,
    pid: null,
    workerPid: null,
    lockPid: null,
    error: stopped
      ? null
      : (classified?.nextStep ?? (lastErrorText || `gog auth add exited ${String(result.code)}`)),
    diagnosticKind: stopped ? null : (classified?.diagnosticKind ?? "auth_unknown"),
    nextStep: stopped ? null : (classified?.nextStep ?? null),
  });
  return stopped ? 0 : 1;
}

async function commandStatus(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const status = await readStatus(sessionId);
  console.log(JSON.stringify(status, null, 2));
}

async function commandWait(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const timeoutMs = parseDurationMs(flags.get("--timeout-ms"), 10 * 60_000);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const status = await readStatus(sessionId);
    if (status.phase === "authorized" || status.phase === "error" || status.phase === "stopped") {
      console.log(JSON.stringify(status, null, 2));
      process.exit(status.phase === "authorized" ? 0 : 1);
    }
    if (Date.now() >= deadline) {
      const timeoutStatus = await writeStatus(sessionDirFor(sessionId), {
        phase: status.phase,
        message: `Google auth is still in progress for ${status.email}.`,
        nextStep: status.authUrl
          ? "Finish the Google approval in the browser. If that page expired or disappeared, reopen the saved auth URL and complete it immediately."
          : "Finish the Google approval in the browser on this Mac.",
      });
      console.log(JSON.stringify(timeoutStatus, null, 2));
      process.exit(2);
    }
    await sleep(1000);
  }
}

async function openAuthUrl(authUrl: string) {
  const openArgs =
    process.platform === "darwin"
      ? ["-a", "Google Chrome", authUrl]
      : process.platform === "win32"
        ? [authUrl]
        : [authUrl];
  const openCommand =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", authUrl] : openArgs;

  const child = spawnChild(openCommand, args, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const result = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(1));
  });
  return result === 0;
}

async function commandReopen(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const status = await readStatus(sessionId);
  const authUrl = status.authUrl?.trim();
  if (!authUrl) {
    throw new Error("No saved authUrl is available for this Google auth session");
  }
  const opened = await openAuthUrl(authUrl);
  const next = await writeStatus(sessionDirFor(sessionId), {
    phase: opened ? "waiting_for_browser" : status.phase,
    message: opened
      ? "Reopened the Google approval page in Google Chrome on this Mac. Finish the consent step immediately there."
      : "OpenClaw could not reopen the Google approval page automatically.",
    diagnosticKind: opened ? "callback_missed" : "browser_handoff_failed",
    nextStep: opened
      ? "Complete the Google approval in that browser window now so the local callback does not expire again."
      : `Open this URL manually in the browser on this Mac: ${authUrl}`,
  });
  console.log(JSON.stringify(next, null, 2));
  process.exit(opened ? 0 : 1);
}

async function commandStop(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const status = await readStatus(sessionId);
  // Stop the gog child first, then its supervising worker. Ownership is only
  // released once both have had a chance to exit, avoiding overlapping prompts.
  const killedChild = await stopProcess(status.pid ?? undefined);
  const killedWorker = await stopProcess(status.workerPid ?? undefined);
  const killedLock = await stopProcess(status.lockPid ?? undefined);
  if (!killedChild || !killedWorker || !killedLock) {
    throw new Error(
      "Google setup is still stopping. Wait a moment and retry stop before starting a new setup.",
    );
  }
  const next = await writeStatus(sessionDirFor(sessionId), {
    phase: "stopped",
    message:
      status.pid || status.workerPid
        ? "Stopped Google auth helper."
        : "Google auth helper was already stopped.",
    pid: null,
    workerPid: null,
    lockPid: null,
  });
  console.log(JSON.stringify(next, null, 2));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "start":
      await commandStart(flags);
      return;
    case "worker":
      process.exitCode = await runWorker(flags);
      return;
    case "status":
      await commandStatus(flags);
      return;
    case "wait":
      await commandWait(flags);
      return;
    case "reopen":
      await commandReopen(flags);
      return;
    case "stop":
      await commandStop(flags);
      return;
    case undefined:
    case "--help":
    case "-h":
      usage();
      process.exit(command ? 0 : 1);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

const isDirectCliEntry =
  process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectCliEntry) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
