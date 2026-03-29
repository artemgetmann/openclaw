import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "@lydell/node-pty";
import ptyModule from "@lydell/node-pty";
import { encodePngRgba, fillPixel } from "../../../src/media/png-encode.ts";

type Phase =
  | "starting"
  | "waiting_for_qr"
  | "qr_ready"
  | "authenticated"
  | "expired"
  | "stopped"
  | "error";

type SessionStatus = {
  sessionId: string;
  phase: Phase;
  message: string;
  sessionDir: string;
  storeDir: string;
  qrPath?: string;
  qrTextPath?: string;
  logPath: string;
  pid?: number;
  workerPid?: number;
  authenticated?: boolean;
  connected?: boolean;
  exitCode?: number | null;
  signal?: number | null;
  error?: string;
  updatedAt: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_ROOT = path.join(os.tmpdir(), "openclaw-wacli-auth");
const STATUS_FILE = "status.json";
const LOG_FILE = "wacli-auth.log";
const QR_FILE = "qr.png";
const QR_TEXT_FILE = "qr.txt";
const BLOCK_CHARS = new Set(["█", "▀", "▄", " "]);
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ptySpawn: typeof ptyModule.spawn =
  (ptyModule as unknown as { spawn?: typeof ptyModule.spawn }).spawn ?? ptyModule.spawn;

function usage() {
  console.error(`Usage:
  wacli-auth-local.sh start [--session <id>] [--store <dir>] [--idle-exit <duration>] [--wait-ms <ms>] [--follow]
  wacli-auth-local.sh status --session <id>
  wacli-auth-local.sh wait --session <id> [--timeout-ms <ms>]
  wacli-auth-local.sh stop --session <id>

Notes:
  - start runs wacli auth in an isolated temp store and returns a PNG path for the QR.
  - wait checks whether authentication completed after the QR was scanned.
  - stop terminates the isolated auth worker and leaves your main ~/.wacli untouched.`);
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

function requireSessionId(flags: Map<string, string | boolean>) {
  const sessionId = flags.get("--session");
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("--session is required");
  }
  return sessionId.trim();
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
    message: patch.message ?? current?.message ?? "Starting WhatsApp CLI auth helper…",
    sessionDir: patch.sessionDir ?? current?.sessionDir ?? sessionDir,
    storeDir: patch.storeDir ?? current?.storeDir ?? path.join(sessionDir, "store"),
    qrPath: patch.qrPath ?? current?.qrPath,
    qrTextPath: patch.qrTextPath ?? current?.qrTextPath,
    logPath: patch.logPath ?? current?.logPath ?? path.join(sessionDir, LOG_FILE),
    pid: patch.pid ?? current?.pid,
    workerPid: patch.workerPid ?? current?.workerPid,
    authenticated: patch.authenticated ?? current?.authenticated,
    connected: patch.connected ?? current?.connected,
    exitCode: patch.exitCode ?? current?.exitCode,
    signal: patch.signal ?? current?.signal,
    error: patch.error ?? current?.error,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(statusPath, JSON.stringify(next, null, 2));
  return next;
}

async function readStatus(sessionId: string) {
  const sessionDir = sessionDirFor(sessionId);
  const statusPath = statusPathFor(sessionDir);
  const raw = await fsp.readFile(statusPath, "utf8");
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
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
}

function sanitizeChunk(input: string) {
  return input.replace(/\r/g, "\n").replace(ANSI_RE, "");
}

function isQrLine(line: string) {
  const trimmed = line.trimEnd();
  if (trimmed.length < 20) {
    return false;
  }
  for (const char of trimmed) {
    if (!BLOCK_CHARS.has(char)) {
      return false;
    }
  }
  return true;
}

function extractQrLines(rawLog: string): string[] | null {
  const lines = sanitizeChunk(rawLog)
    .split("\n")
    .map((line) => line.replace(/\r/g, ""));
  let sawMarker = false;
  const qrLines: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (!sawMarker) {
      if (line.includes("Scan this QR code with WhatsApp")) {
        sawMarker = true;
      }
      continue;
    }
    if (!line.trim()) {
      if (qrLines.length === 0) {
        continue;
      }
      blankRun += 1;
      // PTY output commonly inserts spacer lines between QR rows; ignore short
      // blank runs instead of treating them as the end of the QR block.
      if (blankRun <= 2) {
        continue;
      }
      break;
    }
    blankRun = 0;
    if (isQrLine(line)) {
      qrLines.push(line.trimEnd());
      continue;
    }
    if (qrLines.length > 0) {
      break;
    }
  }
  return qrLines.length >= 10 ? qrLines : null;
}

function moduleBitsForChar(char: string): [boolean, boolean] {
  switch (char) {
    case "█":
      return [true, true];
    case "▀":
      return [true, false];
    case "▄":
      return [false, true];
    default:
      return [false, false];
  }
}

async function renderQrBlockPng(qrLines: string[], outputPath: string) {
  const width = Math.max(...qrLines.map((line) => line.length));
  const moduleRows: boolean[][] = [];
  for (const rawLine of qrLines) {
    const padded = rawLine.padEnd(width, " ");
    const topRow: boolean[] = [];
    const bottomRow: boolean[] = [];
    for (const char of padded) {
      const [top, bottom] = moduleBitsForChar(char);
      topRow.push(top);
      bottomRow.push(bottom);
    }
    moduleRows.push(topRow, bottomRow);
  }

  const scale = 8;
  const margin = 4;
  const outputWidth = (width + margin * 2) * scale;
  const outputHeight = (moduleRows.length + margin * 2) * scale;
  const rgba = Buffer.alloc(outputWidth * outputHeight * 4, 255);

  for (let row = 0; row < moduleRows.length; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!moduleRows[row]?.[col]) {
        continue;
      }
      const startX = (col + margin) * scale;
      const startY = (row + margin) * scale;
      for (let y = 0; y < scale; y += 1) {
        const pixelY = startY + y;
        for (let x = 0; x < scale; x += 1) {
          const pixelX = startX + x;
          fillPixel(rgba, pixelX, pixelY, outputWidth, 0, 0, 0, 255);
        }
      }
    }
  }

  const png = encodePngRgba(rgba, outputWidth, outputHeight);
  await fsp.writeFile(outputPath, png);
}

async function readAuthStatus(storeDir: string) {
  const child = spawnChild("wacli", ["--store", storeDir, "auth", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
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
    new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
  ]);
  if (exitCode !== 0) {
    return {
      authenticated: false,
      error: stderr.trim() || `wacli auth status exited with ${String(exitCode)}`,
    };
  }
  try {
    const parsed = JSON.parse(stdout) as { data?: { authenticated?: boolean } };
    return { authenticated: parsed.data?.authenticated === true };
  } catch (error) {
    return { authenticated: false, error: String(error) };
  }
}

async function waitForPhase(
  sessionId: string,
  opts: { timeoutMs: number; acceptable: Phase[] },
): Promise<SessionStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const status = await readStatus(sessionId);
    if (opts.acceptable.includes(status.phase)) {
      return status;
    }
    if (Date.now() >= deadline) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function startCommand(flags: Map<string, string | boolean>) {
  await ensureSessionsRoot();
  const sessionId =
    (typeof flags.get("--session") === "string" ? String(flags.get("--session")) : "").trim() ||
    randomUUID();
  const sessionDir = sessionDirFor(sessionId);
  const storeDir =
    (typeof flags.get("--store") === "string" ? String(flags.get("--store")) : "").trim() ||
    path.join(sessionDir, "store");
  const idleExit =
    typeof flags.get("--idle-exit") === "string" ? String(flags.get("--idle-exit")) : "120s";
  const waitMs = parseDurationMs(flags.get("--wait-ms"), 15_000);
  const follow = flags.get("--follow") === true;

  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.mkdir(storeDir, { recursive: true });
  const logPath = path.join(sessionDir, LOG_FILE);
  await writeStatus(sessionDir, {
    sessionId,
    phase: "starting",
    message: "Starting isolated WhatsApp CLI auth…",
    sessionDir,
    storeDir,
    logPath,
  });

  const child = spawnChild(
    process.execPath,
    [
      "--import",
      "tsx",
      __filename,
      "worker",
      "--session",
      sessionId,
      "--store",
      storeDir,
      "--idle-exit",
      idleExit,
      ...(follow ? ["--follow"] : []),
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();

  await writeStatus(sessionDir, {
    workerPid: child.pid,
    message: "Waiting for WhatsApp QR…",
  });

  const status = await waitForPhase(sessionId, {
    timeoutMs: waitMs,
    acceptable: ["qr_ready", "authenticated", "error"],
  });
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.phase === "error" ? 1 : 0);
}

async function statusCommand(flags: Map<string, string | boolean>) {
  const sessionId = requireSessionId(flags);
  const status = await readStatus(sessionId);
  const auth = await readAuthStatus(status.storeDir);
  if (auth.authenticated) {
    status.authenticated = true;
    if (status.phase !== "authenticated") {
      status.phase = "authenticated";
      status.message = "WhatsApp CLI authentication completed.";
    }
  } else if (auth.error && !status.error) {
    status.error = auth.error;
  }
  console.log(JSON.stringify(status, null, 2));
}

async function waitCommand(flags: Map<string, string | boolean>) {
  const sessionId = requireSessionId(flags);
  const timeoutMs = parseDurationMs(flags.get("--timeout-ms"), 120_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await readStatus(sessionId);
    const auth = await readAuthStatus(status.storeDir);
    if (auth.authenticated) {
      const next = await writeStatus(status.sessionDir, {
        phase: "authenticated",
        message: "WhatsApp CLI authentication completed.",
        authenticated: true,
      });
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    if (status.phase === "error" || status.phase === "expired" || status.phase === "stopped") {
      console.log(JSON.stringify(status, null, 2));
      process.exit(status.phase === "error" ? 1 : 0);
    }
    if (Date.now() >= deadline) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function stopCommand(flags: Map<string, string | boolean>) {
  const sessionId = requireSessionId(flags);
  const status = await readStatus(sessionId);
  const pid = status.workerPid ?? status.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore dead processes
    }
  }
  const next = await writeStatus(status.sessionDir, {
    phase: "stopped",
    message: "Stopped isolated WhatsApp CLI auth helper.",
  });
  console.log(JSON.stringify(next, null, 2));
}

async function workerCommand(flags: Map<string, string | boolean>) {
  const sessionId = requireSessionId(flags);
  const sessionDir = sessionDirFor(sessionId);
  const storeDir =
    (typeof flags.get("--store") === "string" ? String(flags.get("--store")) : "").trim() ||
    path.join(sessionDir, "store");
  const idleExit =
    typeof flags.get("--idle-exit") === "string" ? String(flags.get("--idle-exit")) : "120s";
  const follow = flags.get("--follow") === true;
  const logPath = path.join(sessionDir, LOG_FILE);
  const qrPath = path.join(sessionDir, QR_FILE);
  const qrTextPath = path.join(sessionDir, QR_TEXT_FILE);

  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.mkdir(storeDir, { recursive: true });
  await fsp.writeFile(logPath, "", "utf8");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const ptyProcess: IPty = ptySpawn(
    "wacli",
    ["--store", storeDir, "auth", "--idle-exit", idleExit, ...(follow ? ["--follow"] : [])],
    {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      name: process.env.TERM ?? "xterm-256color",
      cols: 200,
      rows: 80,
    },
  );

  await writeStatus(sessionDir, {
    phase: "waiting_for_qr",
    message: "Waiting for WhatsApp QR…",
    pid: ptyProcess.pid,
    workerPid: process.pid,
    qrPath,
    qrTextPath,
    logPath,
    sessionDir,
    storeDir,
  });

  let fullLog = "";
  let qrWritten = false;
  const maybeWriteQr = async () => {
    if (qrWritten) {
      return;
    }
    const qrLines = extractQrLines(fullLog);
    if (!qrLines) {
      return;
    }
    qrWritten = true;
    await fsp.writeFile(qrTextPath, `${qrLines.join("\n")}\n`, "utf8");
    await renderQrBlockPng(qrLines, qrPath);
    await writeStatus(sessionDir, {
      phase: "qr_ready",
      message: "Scan this QR in WhatsApp → Linked Devices.",
      qrPath,
      qrTextPath,
    });
  };

  ptyProcess.onData((chunk) => {
    const sanitized = sanitizeChunk(chunk);
    fullLog += sanitized;
    logStream.write(sanitized);
    void maybeWriteQr();
  });

  const exitEvent = await new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    ptyProcess.onExit((event) => resolve(event));
  });

  logStream.end();
  const auth = await readAuthStatus(storeDir);
  if (auth.authenticated) {
    await writeStatus(sessionDir, {
      phase: "authenticated",
      message: "WhatsApp CLI authentication completed.",
      authenticated: true,
      exitCode: exitEvent.exitCode ?? null,
      signal: exitEvent.signal ?? null,
    });
    return;
  }
  if (qrWritten) {
    await writeStatus(sessionDir, {
      phase: "expired",
      message: "QR expired before authentication completed. Start a new pairing session.",
      exitCode: exitEvent.exitCode ?? null,
      signal: exitEvent.signal ?? null,
      error: auth.error,
    });
    return;
  }
  await writeStatus(sessionDir, {
    phase: "error",
    message: "Failed to generate a WhatsApp CLI QR.",
    exitCode: exitEvent.exitCode ?? null,
    signal: exitEvent.signal ?? null,
    error:
      auth.error ?? `wacli auth exited before a QR was captured (${String(exitEvent.exitCode)})`,
  });
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "start":
      await startCommand(flags);
      return;
    case "status":
      await statusCommand(flags);
      return;
    case "wait":
      await waitCommand(flags);
      return;
    case "stop":
      await stopCommand(flags);
      return;
    case "worker":
      await workerCommand(flags);
      return;
    case "--help":
    case "-h":
    case undefined:
      usage();
      process.exit(command ? 0 : 1);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

await main();
