import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Command = "status" | "ensure" | "stop";

type Flags = {
  command: Command;
  json: boolean;
  storeDir: string;
  settleMs: number;
  graceMs: number;
  timeoutMs: number;
  tailLines: number;
};

type OwnerFiles = {
  pidPath: string;
  logPath: string;
};

type OwnerPidFile = {
  pid: number;
  startedAt: string;
  storeDir: string;
  command: string[];
  host: string;
};

type LifecycleEvent = "connected" | "disconnected" | "reconnecting" | "stopping" | "unknown";

type LiveStatus = {
  ok: boolean;
  action: Command;
  storeDir: string;
  pidFile: string;
  logFile: string;
  ownerRunning: boolean;
  ownerPid?: number;
  ownerCommandMatches: boolean;
  lockInfo?: string;
  lockPid?: number;
  lockHeldByOwner: boolean;
  lastLifecycleEvent?: LifecycleEvent;
  connected: boolean;
  logTail: string[];
  message: string;
};

function usage() {
  console.error(`Usage:
  wacli-live.sh status [--json] [--store <dir>] [--tail-lines <n>]
  wacli-live.sh ensure [--json] [--store <dir>] [--settle-ms <ms>] [--tail-lines <n>]
  wacli-live.sh stop [--json] [--store <dir>] [--grace-ms <ms>] [--tail-lines <n>]

Notes:
  - Owns one long-lived 'wacli sync --follow --json' process per store.
  - Uses a PID file plus the wacli LOCK file and sync log to infer live state.
  - This exists because 'wacli doctor' reports connected=false while another
    sync owner holds the store lock, which is useless for OpenClaw health checks.`);
}

function defaultStoreDir() {
  return path.join(os.homedir(), ".wacli");
}

function parsePositiveInt(raw: string, flag: string) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag}: ${raw}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Flags {
  const [commandRaw, ...rest] = argv;
  if (!commandRaw || commandRaw === "-h" || commandRaw === "--help") {
    usage();
    process.exit(0);
  }
  if (!["status", "ensure", "stop"].includes(commandRaw)) {
    throw new Error(`Unknown command: ${commandRaw}`);
  }

  const flags: Flags = {
    command: commandRaw as Command,
    json: false,
    storeDir: defaultStoreDir(),
    settleMs: 15_000,
    graceMs: 5_000,
    timeoutMs: 2_000,
    tailLines: 40,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--json":
        flags.json = true;
        break;
      case "--store": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--store requires a value");
        }
        flags.storeDir = path.resolve(next);
        index += 1;
        break;
      }
      case "--settle-ms": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--settle-ms requires a value");
        }
        flags.settleMs = parsePositiveInt(next, "--settle-ms");
        index += 1;
        break;
      }
      case "--grace-ms": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--grace-ms requires a value");
        }
        flags.graceMs = parsePositiveInt(next, "--grace-ms");
        index += 1;
        break;
      }
      case "--timeout-ms": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--timeout-ms requires a value");
        }
        flags.timeoutMs = parsePositiveInt(next, "--timeout-ms");
        index += 1;
        break;
      }
      case "--tail-lines": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--tail-lines requires a value");
        }
        flags.tailLines = parsePositiveInt(next, "--tail-lines");
        index += 1;
        break;
      }
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return flags;
}

function resolveOwnerFiles(storeDir: string): OwnerFiles {
  return {
    pidPath: path.join(storeDir, "openclaw-sync-owner.json"),
    logPath: path.join(storeDir, "openclaw-sync.log"),
  };
}

async function readPidFile(pidPath: string): Promise<OwnerPidFile | undefined> {
  try {
    const raw = await fsp.readFile(pidPath, "utf8");
    return JSON.parse(raw) as OwnerPidFile;
  } catch {
    return undefined;
  }
}

async function writePidFile(pidPath: string, payload: OwnerPidFile) {
  await fsp.writeFile(pidPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readLockInfo(storeDir: string): Promise<{ raw?: string; pid?: number }> {
  try {
    const raw = (await fsp.readFile(path.join(storeDir, "LOCK"), "utf8")).trim();
    const pidMatch = raw.match(/pid=(\d+)/);
    return {
      raw: raw || undefined,
      pid: pidMatch ? Number.parseInt(pidMatch[1] ?? "", 10) : undefined,
    };
  } catch {
    return {};
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runShortCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function commandMatchesExpected(pid: number) {
  const result = await runShortCommand("ps", ["-o", "command=", "-p", String(pid)], 1_500);
  const command = result.stdout.trim();
  return command.includes("wacli sync --follow --json");
}

async function readLogTail(logPath: string, tailLines: number): Promise<string[]> {
  try {
    const raw = await fsp.readFile(logPath, "utf8");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-tailLines);
  } catch {
    return [];
  }
}

function inferLifecycleEvent(lines: string[]): LifecycleEvent | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.includes("Connected.")) {
      return "connected";
    }
    if (line.includes("Disconnected.")) {
      return "disconnected";
    }
    if (line.includes("Reconnecting...")) {
      return "reconnecting";
    }
    if (line.includes("Stopping sync.")) {
      return "stopping";
    }
  }
  return undefined;
}

async function collectStatus(flags: Flags): Promise<LiveStatus> {
  const files = resolveOwnerFiles(flags.storeDir);
  const pidFile = await readPidFile(files.pidPath);
  const ownerPid = pidFile?.pid;
  const ownerRunning = typeof ownerPid === "number" && ownerPid > 0 && processExists(ownerPid);
  const ownerCommandMatches =
    ownerRunning && ownerPid ? await commandMatchesExpected(ownerPid) : false;
  const lockInfo = await readLockInfo(flags.storeDir);
  const logTail = await readLogTail(files.logPath, flags.tailLines);
  const lastLifecycleEvent = inferLifecycleEvent(logTail);
  const lockHeldByOwner =
    ownerRunning &&
    ownerCommandMatches &&
    typeof ownerPid === "number" &&
    typeof lockInfo.pid === "number" &&
    ownerPid === lockInfo.pid;
  const connected =
    ownerRunning && ownerCommandMatches && lockHeldByOwner && lastLifecycleEvent === "connected";

  let message = "No OpenClaw wacli sync owner is running.";
  if (connected) {
    message = "OpenClaw wacli sync owner is running and reported a live connection.";
  } else if (ownerRunning && ownerCommandMatches) {
    message = "OpenClaw wacli sync owner is running, but live connection is not yet confirmed.";
  } else if (ownerRunning) {
    message =
      "A process with the recorded PID is alive, but it no longer looks like wacli sync --follow.";
  }

  return {
    ok: true,
    action: flags.command,
    storeDir: flags.storeDir,
    pidFile: files.pidPath,
    logFile: files.logPath,
    ownerRunning,
    ownerPid,
    ownerCommandMatches,
    lockInfo: lockInfo.raw,
    lockPid: lockInfo.pid,
    lockHeldByOwner,
    lastLifecycleEvent,
    connected,
    logTail,
    message,
  };
}

async function ensureOwner(flags: Flags): Promise<LiveStatus> {
  await fsp.mkdir(flags.storeDir, { recursive: true, mode: 0o700 });
  const files = resolveOwnerFiles(flags.storeDir);

  const initial = await collectStatus(flags);
  if (initial.connected || (initial.ownerRunning && initial.ownerCommandMatches)) {
    return initial;
  }

  const logHandle = await fsp.open(files.logPath, "a", 0o600);
  try {
    const child = spawn("wacli", ["--store", flags.storeDir, "sync", "--follow", "--json"], {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: process.env,
    });
    child.unref();

    await writePidFile(files.pidPath, {
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      storeDir: flags.storeDir,
      command: ["wacli", "--store", flags.storeDir, "sync", "--follow", "--json"],
      host: os.hostname(),
    });
  } finally {
    await logHandle.close();
  }

  const deadline = Date.now() + flags.settleMs;
  for (;;) {
    const status = await collectStatus(flags);
    if (status.connected) {
      status.message = "OpenClaw started a wacli sync owner and it reported a live connection.";
      return status;
    }
    if (!status.ownerRunning && Date.now() > deadline) {
      status.message = "OpenClaw failed to keep a wacli sync owner running.";
      return status;
    }
    if (Date.now() > deadline) {
      status.message =
        "OpenClaw started a wacli sync owner, but live connection did not settle in time.";
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function stopOwner(flags: Flags): Promise<LiveStatus> {
  const files = resolveOwnerFiles(flags.storeDir);
  const pidFile = await readPidFile(files.pidPath);
  if (pidFile?.pid && processExists(pidFile.pid)) {
    process.kill(pidFile.pid, "SIGINT");
    const deadline = Date.now() + flags.graceMs;
    while (processExists(pidFile.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (processExists(pidFile.pid)) {
      process.kill(pidFile.pid, "SIGKILL");
    }
  }
  await fsp.rm(files.pidPath, { force: true });
  const status = await collectStatus(flags);
  status.message = "OpenClaw stopped the recorded wacli sync owner.";
  return status;
}

function emit(result: LiveStatus, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`message=${result.message}`);
  console.log(`store_dir=${result.storeDir}`);
  console.log(`owner_running=${String(result.ownerRunning)}`);
  console.log(`connected=${String(result.connected)}`);
  console.log(`owner_command_matches=${String(result.ownerCommandMatches)}`);
  console.log(`lock_held_by_owner=${String(result.lockHeldByOwner)}`);
  if (result.ownerPid) {
    console.log(`owner_pid=${String(result.ownerPid)}`);
  }
  if (result.lastLifecycleEvent) {
    console.log(`last_lifecycle_event=${result.lastLifecycleEvent}`);
  }
  if (result.lockInfo) {
    console.log(`lock_info=${result.lockInfo.replace(/\n/g, " | ")}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  let result: LiveStatus;
  switch (flags.command) {
    case "ensure":
      result = await ensureOwner(flags);
      break;
    case "stop":
      result = await stopOwner(flags);
      break;
    case "status":
    default:
      result = await collectStatus(flags);
      break;
  }
  emit(result, flags.json);
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  const scriptName = path.basename(process.argv[1] ?? "wacli-live.ts");
  console.error(`${scriptName}: ${String(error)}`);
  process.exit(1);
});
