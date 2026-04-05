import { spawn as spawnChild } from "node:child_process";
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
  authorized?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string | null;
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
const AUTH_URL_RE = /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/;

function usage() {
  console.error(`Usage:
  gog-auth-local.sh start --email <email> [--services <csv>] [--client <name>] [--readonly] [--force-consent] [--timeout <duration>] [--session <id>]
  gog-auth-local.sh status --session <id>
  gog-auth-local.sh wait --session <id> [--timeout-ms <ms>]
  gog-auth-local.sh stop --session <id>

Notes:
  - start launches gog auth add in the background on this Mac so the browser flow can open locally.
  - wait blocks until the auth session finishes and verifies the account with gog auth list.
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
    authorized: patch.authorized ?? current?.authorized,
    exitCode: Object.hasOwn(patch, "exitCode")
      ? (patch.exitCode ?? null)
      : (current?.exitCode ?? null),
    signal: Object.hasOwn(patch, "signal") ? (patch.signal ?? null) : (current?.signal ?? null),
    error: Object.hasOwn(patch, "error") ? (patch.error ?? null) : (current?.error ?? null),
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

async function readAuthList() {
  const child = spawnChild("gog", ["auth", "list", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
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
  const services = optionalFlag(flags, "--services") ?? "user";
  const client = optionalFlag(flags, "--client");
  const sessionId = optionalFlag(flags, "--session") ?? randomUUID();
  const sessionDir = sessionDirFor(sessionId);
  const timeout = optionalFlag(flags, "--timeout") ?? "10m";
  const readonly = boolFlag(flags, "--readonly");
  const forceConsent = boolFlag(flags, "--force-consent");

  await ensureSessionsRoot();
  await fsp.mkdir(sessionDir, { recursive: true });
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
    workerPid: process.pid,
  });

  // Launch a detached worker so the bot can keep chatting while the human
  // finishes the Google consent screen in the local browser.
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
  const worker = spawnChild(process.execPath, workerArgs, {
    detached: true,
    stdio: "ignore",
  });
  worker.unref();

  const status = await writeStatus(sessionDir, {
    phase: "waiting_for_browser",
    message: "Starting Google auth in the background. The default browser should open on this Mac.",
    workerPid: worker.pid,
  });
  console.log(JSON.stringify(status, null, 2));
}

async function commandWorker(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const email = requireFlag(flags, "--email");
  const services = optionalFlag(flags, "--services") ?? "user";
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
  });
  let lastErrorText = "";
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
      await writeStatus(sessionDir, {
        phase: authorized ? "authorized" : "error",
        message: authorized
          ? `Google is connected for ${email}. Verified with gog auth list.`
          : `gog auth add exited successfully, but ${email} did not appear in gog auth list.`,
        authorized,
        exitCode: result.code,
        signal: result.signal,
        pid: null,
        error: authorized ? null : "verification failed",
      });
      process.exit(authorized ? 0 : 1);
    } catch (error) {
      await writeStatus(sessionDir, {
        phase: "error",
        message: `Google auth finished, but verification failed for ${email}.`,
        authorized: false,
        exitCode: result.code,
        signal: result.signal,
        pid: null,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
    return;
  }

  const stopped = result.signal === "SIGTERM" || result.signal === "SIGINT";
  await writeStatus(sessionDir, {
    phase: stopped ? "stopped" : "error",
    message: stopped
      ? "Stopped Google auth helper."
      : `Google auth failed for ${email}. Check the helper log for details.`,
    authorized: false,
    exitCode: result.code,
    signal: result.signal,
    pid: null,
    error: stopped ? null : lastErrorText || `gog auth add exited ${String(result.code)}`,
  });
  process.exit(stopped ? 0 : 1);
}

async function commandStatus(flags: Map<string, string | boolean>) {
  const status = await readStatus(requireFlag(flags, "--session"));
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
      });
      console.log(JSON.stringify(timeoutStatus, null, 2));
      process.exit(2);
    }
    await sleep(1000);
  }
}

async function commandStop(flags: Map<string, string | boolean>) {
  const sessionId = requireFlag(flags, "--session");
  const status = await readStatus(sessionId);
  const killedChild = tryKill(status.pid);
  const killedWorker = tryKill(status.workerPid);
  const next = await writeStatus(sessionDirFor(sessionId), {
    phase: "stopped",
    message:
      killedChild || killedWorker
        ? "Stopped Google auth helper."
        : "Google auth helper was already stopped.",
    pid: null,
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
      await commandWorker(flags);
      return;
    case "status":
      await commandStatus(flags);
      return;
    case "wait":
      await commandWait(flags);
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
