import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import ptyModule from "@lydell/node-pty";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_ROOT = path.join(os.tmpdir(), "openclaw-wacli-auth");
const STATUS_FILE = "status.json";
const LOG_FILE = "wacli-auth.log";
const QR_FILE = "qr.png";
const QR_TEXT_FILE = "qr.txt";
const BLOCK_CHARS = new Set(["█", "▀", "▄", " "]);
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ptySpawn = ptyModule.spawn ?? ptyModule.spawn;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function fillPixel(buf, x, y, width, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width) return;
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx + 3 >= buf.length) return;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function encodePngRgba(buffer, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function usage() {
  console.error(`Usage:
  wacli-auth-local.sh start [--session <id>] [--store <dir>] [--idle-exit <duration>] [--wait-ms <ms>] [--follow]
  wacli-auth-local.sh status --session <id>
  wacli-auth-local.sh wait --session <id> [--timeout-ms <ms>]
  wacli-auth-local.sh stop --session <id>`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
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

function requireSessionId(flags) {
  const sessionId = flags.get("--session");
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("--session is required");
  return sessionId.trim();
}

function sessionDirFor(sessionId) {
  return path.join(SESSIONS_ROOT, sessionId);
}
function statusPathFor(sessionDir) {
  return path.join(sessionDir, STATUS_FILE);
}
async function ensureSessionsRoot() {
  await fsp.mkdir(SESSIONS_ROOT, { recursive: true });
}

async function writeStatus(sessionDir, patch) {
  const statusPath = statusPathFor(sessionDir);
  let current = null;
  try {
    current = JSON.parse(await fsp.readFile(statusPath, "utf8"));
  } catch {}
  const next = {
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

async function readStatus(sessionId) {
  return JSON.parse(await fsp.readFile(statusPathFor(sessionDirFor(sessionId)), "utf8"));
}

function parseDurationMs(raw, fallbackMs) {
  if (typeof raw !== "string" || !raw.trim()) return fallbackMs;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const match = trimmed.match(/^(\d+)(ms|s|m)$/i);
  if (!match) throw new Error(`Unsupported duration: ${raw}`);
  const value = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60000;
  throw new Error(`Unsupported duration unit: ${unit}`);
}

function sanitizeChunk(input) {
  return input.replace(/\r/g, "\n").replace(ANSI_RE, "");
}
function isQrLine(line) {
  const trimmed = line.trimEnd();
  if (trimmed.length < 20) return false;
  for (const char of trimmed) if (!BLOCK_CHARS.has(char)) return false;
  return true;
}

function extractQrLines(rawLog) {
  const lines = sanitizeChunk(rawLog)
    .split("\n")
    .map((line) => line.replace(/\r/g, ""));
  let sawMarker = false;
  const qrLines = [];
  let blankRun = 0;
  for (const line of lines) {
    if (!sawMarker) {
      if (line.includes("Scan this QR code with WhatsApp")) sawMarker = true;
      continue;
    }
    if (!line.trim()) {
      if (qrLines.length === 0) continue;
      blankRun += 1;
      if (blankRun <= 2) continue;
      break;
    }
    blankRun = 0;
    if (isQrLine(line)) {
      qrLines.push(line.trimEnd());
      continue;
    }
    if (qrLines.length > 0) break;
  }
  if (qrLines.length < 10) return null;
  const widthCounts = new Map();
  for (const line of qrLines) widthCounts.set(line.length, (widthCounts.get(line.length) ?? 0) + 1);
  const dominantWidth =
    [...widthCounts.entries()].sort((l, r) => r[1] - l[1] || r[0] - l[0])[0]?.[0] ?? 0;
  const normalized = qrLines.filter((line) => Math.abs(line.length - dominantWidth) <= 1);
  return normalized.length >= 10 ? normalized : qrLines;
}

function isSolidBorder(line, allowed) {
  return [...line].every((char) => allowed.has(char));
}
function looksLikeCompleteQr(qrLines) {
  if (qrLines.length < 20) return false;
  const firstLine = qrLines[0] ?? "";
  const secondLine = qrLines[1] ?? "";
  const lastLine = qrLines.at(-1) ?? "";
  return (
    isSolidBorder(firstLine, new Set(["█"])) &&
    isSolidBorder(secondLine, new Set(["█"])) &&
    (isSolidBorder(lastLine, new Set(["█"])) || isSolidBorder(lastLine, new Set(["▀"])))
  );
}

function blockCellForChar(char) {
  switch (char) {
    case "█":
      return { top: true, bottom: true };
    case "▀":
      return { top: true, bottom: false };
    case "▄":
      return { top: false, bottom: true };
    default:
      return { top: false, bottom: false };
  }
}

async function renderQrBlockPng(qrLines, outputPath) {
  const width = Math.max(...qrLines.map((line) => line.length));
  const cellWidth = 8,
    cellHeight = 16,
    marginCells = 4;
  const outputWidth = (width + marginCells * 2) * cellWidth;
  const outputHeight = (qrLines.length + marginCells * 2) * cellHeight;
  const rgba = Buffer.alloc(outputWidth * outputHeight * 4, 255);
  for (let row = 0; row < qrLines.length; row += 1) {
    const padded = (qrLines[row] ?? "").padEnd(width, " ");
    for (let col = 0; col < width; col += 1) {
      const cell = blockCellForChar(padded[col] ?? " ");
      if (!cell.top && !cell.bottom) continue;
      const startX = (col + marginCells) * cellWidth;
      const startY = (row + marginCells) * cellHeight;
      for (let y = 0; y < cellHeight; y += 1) {
        const inTopHalf = y < cellHeight / 2;
        if ((inTopHalf && !cell.top) || (!inTopHalf && !cell.bottom)) continue;
        const pixelY = startY + y;
        for (let x = 0; x < cellWidth; x += 1)
          fillPixel(rgba, startX + x, pixelY, outputWidth, 0, 0, 0, 255);
      }
    }
  }
  await fsp.writeFile(outputPath, encodePngRgba(rgba, outputWidth, outputHeight));
}

async function readAuthStatus(storeDir) {
  const child = spawnChild("wacli", ["--store", storeDir, "auth", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Promise((resolve) => {
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stdout?.on("end", () => resolve(out));
    }),
    new Promise((resolve) => {
      let out = "";
      child.stderr?.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stderr?.on("end", () => resolve(out));
    }),
    new Promise((resolve) => child.on("exit", (code) => resolve(code))),
  ]);
  if (exitCode !== 0)
    return {
      authenticated: false,
      error: stderr.trim() || `wacli auth status exited with ${String(exitCode)}`,
    };
  try {
    const parsed = JSON.parse(stdout);
    return { authenticated: parsed.data?.authenticated === true };
  } catch (error) {
    return { authenticated: false, error: String(error) };
  }
}

async function waitForPhase(sessionId, opts) {
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const status = await readStatus(sessionId);
    if (opts.acceptable.includes(status.phase)) return status;
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function startCommand(flags) {
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
  const waitMs = parseDurationMs(flags.get("--wait-ms"), 15000);
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
    { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  await writeStatus(sessionDir, { workerPid: child.pid, message: "Waiting for WhatsApp QR…" });
  const status = await waitForPhase(sessionId, {
    timeoutMs: waitMs,
    acceptable: ["qr_ready", "authenticated", "error"],
  });
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.phase === "error" ? 1 : 0);
}

async function statusCommand(flags) {
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

async function waitCommand(flags) {
  const sessionId = requireSessionId(flags);
  const timeoutMs = parseDurationMs(flags.get("--timeout-ms"), 120000);
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

async function stopCommand(flags) {
  const sessionId = requireSessionId(flags);
  const status = await readStatus(sessionId);
  const pid = status.workerPid ?? status.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const next = await writeStatus(status.sessionDir, {
    phase: "stopped",
    message: "Stopped isolated WhatsApp CLI auth helper.",
  });
  console.log(JSON.stringify(next, null, 2));
}

async function workerCommand(flags) {
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
  const ptyProcess = ptySpawn(
    "wacli",
    ["--store", storeDir, "auth", "--idle-exit", idleExit, ...(follow ? ["--follow"] : [])],
    {
      cwd: process.cwd(),
      env: process.env,
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
    if (qrWritten) return;
    const qrLines = extractQrLines(fullLog);
    if (!qrLines) return;
    if (!looksLikeCompleteQr(qrLines)) return;
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
  const exitEvent = await new Promise((resolve) => {
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
