import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SendCommand = "text" | "file";

type Flags = {
  command: SendCommand;
  json: boolean;
  storeDir: string;
  to: string;
  message?: string;
  file?: string;
  caption?: string;
  timeoutMs: number;
  settleMs: number;
  graceMs: number;
};

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type LiveStatus = {
  ok?: boolean;
  ownerRunning?: boolean;
  ownerPid?: number;
  ownerCommandMatches?: boolean;
  lockHeldByOwner?: boolean;
  lockPid?: number;
  connected?: boolean;
  message?: string;
  forcedStop?: boolean;
  stopSignal?: "SIGINT" | "SIGKILL";
  stoppedPid?: number;
  stopReason?: string;
};

type SendReport = {
  ok: boolean;
  status: "sent" | "sent_with_owner_restored" | "sent_with_restore_warning" | "failed";
  command: SendCommand;
  to: string;
  ownerPaused: boolean;
  ownerRestored: boolean;
  ownerBefore?: LiveStatus;
  ownerStop?: LiveStatus;
  ownerAfter?: LiveStatus;
  send: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  };
  retryAttempted: boolean;
  message: string;
  error?: string;
};

type Deps = {
  runCommand: typeof runCommand;
  sleep: (ms: number) => Promise<void>;
};

function usage() {
  console.error(`Usage:
  wacli-send-safe.sh text --to <recipient> --message <text> [--store <dir>] [--json] [--timeout-ms <ms>] [--settle-ms <ms>] [--grace-ms <ms>]
  wacli-send-safe.sh file --to <recipient> --file <path> [--caption <text>] [--store <dir>] [--json] [--timeout-ms <ms>] [--settle-ms <ms>] [--grace-ms <ms>]

Notes:
  - If the recorded OpenClaw wacli sync owner is running, this helper pauses it, sends, then restores it.
  - It only pauses the recorded owner that matches the local sync-owner pid file.`);
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
  if (commandRaw !== "text" && commandRaw !== "file") {
    throw new Error(`Unknown command: ${commandRaw}`);
  }

  const flags: Flags = {
    command: commandRaw,
    json: false,
    storeDir: defaultStoreDir(),
    to: "",
    timeoutMs: 15_000,
    settleMs: 15_000,
    graceMs: 5_000,
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
      case "--to": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--to requires a value");
        }
        flags.to = next;
        index += 1;
        break;
      }
      case "--message": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--message requires a value");
        }
        flags.message = next;
        index += 1;
        break;
      }
      case "--file": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--file requires a value");
        }
        flags.file = next;
        index += 1;
        break;
      }
      case "--caption": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--caption requires a value");
        }
        flags.caption = next;
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
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!flags.to) {
    throw new Error("--to is required");
  }
  if (flags.command === "text" && !flags.message) {
    throw new Error("--message is required for text sends");
  }
  if (flags.command === "file" && !flags.file) {
    throw new Error("--file is required for file sends");
  }

  return flags;
}

function helperScriptPath() {
  return path.join(path.dirname(process.argv[1] ?? "."), "wacli-live.sh");
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
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
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(raw: string): T | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return JSON.parse(trimmed) as T;
}

function containsLockError(raw: string) {
  return raw.toLowerCase().includes("store is locked");
}

function buildSendArgs(flags: Flags) {
  const args = ["--store", flags.storeDir, "send", flags.command, "--to", flags.to];
  if (flags.command === "text") {
    args.push("--message", flags.message ?? "");
  } else {
    args.push("--file", flags.file ?? "");
    if (flags.caption) {
      args.push("--caption", flags.caption);
    }
  }
  return args;
}

async function readOwnerStatus(
  flags: Flags,
  deps: Pick<Deps, "runCommand">,
): Promise<LiveStatus | undefined> {
  const result = await deps.runCommand(
    helperScriptPath(),
    ["status", "--json", "--store", flags.storeDir],
    Math.min(flags.timeoutMs, 2_000),
  );
  if (!result.stdout.trim()) {
    return undefined;
  }
  return parseJson<LiveStatus>(result.stdout);
}

async function runLiveCommand(
  action: "stop" | "ensure",
  flags: Flags,
  deps: Pick<Deps, "runCommand">,
): Promise<LiveStatus | undefined> {
  const args = [action, "--json", "--store", flags.storeDir];
  if (action === "stop") {
    args.push("--grace-ms", String(flags.graceMs));
  } else {
    args.push("--settle-ms", String(flags.settleMs));
  }
  const result = await deps.runCommand(helperScriptPath(), args, Math.max(flags.timeoutMs, 5_000));
  if (!result.stdout.trim()) {
    return undefined;
  }
  return parseJson<LiveStatus>(result.stdout);
}

async function waitForOwnerRelease(flags: Flags, deps: Pick<Deps, "runCommand" | "sleep">) {
  const deadline = Date.now() + flags.graceMs;
  let lastStatus = await readOwnerStatus(flags, deps);

  while (Date.now() <= deadline) {
    if (lastStatus?.ownerRunning !== true && lastStatus?.lockPid == null) {
      return lastStatus;
    }
    await deps.sleep(250);
    lastStatus = await readOwnerStatus(flags, deps);
  }

  return lastStatus;
}

async function sendOnce(flags: Flags, deps: Pick<Deps, "runCommand">) {
  return await deps.runCommand("wacli", buildSendArgs(flags), flags.timeoutMs);
}

function buildSuccessMessage(flags: Flags, ownerPaused: boolean, ownerRestored: boolean) {
  if (!ownerPaused) {
    return `Sent WhatsApp ${flags.command}.`;
  }
  if (ownerRestored) {
    return `Paused the live sync owner, sent the WhatsApp ${flags.command}, and restored the owner.`;
  }
  return `Paused the live sync owner and sent the WhatsApp ${flags.command}, but restoring the owner needs attention.`;
}

async function runOwnerSafeSend(
  flags: Flags,
  deps: Deps = { runCommand, sleep },
): Promise<SendReport> {
  const ownerBefore = await readOwnerStatus(flags, deps);
  const shouldPauseOwner =
    ownerBefore?.ownerRunning === true && ownerBefore.ownerCommandMatches === true;

  let ownerPaused = false;
  let ownerRestored = false;
  let retryAttempted = false;
  let sendResult: CommandResult | undefined;
  let sendRaw = "";
  let ownerStop: LiveStatus | undefined;

  if (shouldPauseOwner) {
    ownerStop = await runLiveCommand("stop", flags, deps);
    const releaseStatus = await waitForOwnerRelease(flags, deps);
    ownerPaused = releaseStatus?.ownerRunning !== true && releaseStatus?.lockPid == null;
    if (!ownerPaused) {
      return {
        ok: false,
        status: "failed",
        command: flags.command,
        to: flags.to,
        ownerPaused: false,
        ownerRestored: false,
        ownerBefore,
        ownerStop,
        send: { exitCode: null, stdout: "", stderr: "", timedOut: false },
        retryAttempted: false,
        message: "Failed to pause the recorded wacli sync owner before sending.",
        error:
          releaseStatus?.lockPid != null
            ? `The wacli store is still locked by PID ${String(releaseStatus.lockPid)}.`
            : "The recorded owner could not be stopped cleanly.",
      };
    }
  }

  try {
    sendResult = await sendOnce(flags, deps);
    sendRaw = `${sendResult.stdout}\n${sendResult.stderr}`;

    if (!sendResult.ok && shouldPauseOwner && containsLockError(sendRaw)) {
      retryAttempted = true;
      await waitForOwnerRelease(flags, deps);
      sendResult = await sendOnce(flags, deps);
      sendRaw = `${sendResult.stdout}\n${sendResult.stderr}`;
    }
  } finally {
    if (ownerPaused) {
      const restored = await runLiveCommand("ensure", flags, deps);
      ownerRestored = Boolean(restored?.connected || restored?.ownerRunning);
    }
  }

  if (!sendResult) {
    return {
      ok: false,
      status: "failed",
      command: flags.command,
      to: flags.to,
      ownerPaused,
      ownerRestored,
      ownerBefore,
      send: { exitCode: null, stdout: "", stderr: "", timedOut: false },
      retryAttempted,
      message: "WhatsApp send did not start.",
      error: "No send result was produced.",
    };
  }

  if (!sendResult.ok) {
    return {
      ok: false,
      status: "failed",
      command: flags.command,
      to: flags.to,
      ownerPaused,
      ownerRestored,
      ownerBefore,
      ownerStop,
      send: {
        exitCode: sendResult.exitCode,
        stdout: sendResult.stdout,
        stderr: sendResult.stderr,
        timedOut: sendResult.timedOut,
      },
      retryAttempted,
      message: containsLockError(sendRaw)
        ? "WhatsApp send failed because the store is still locked."
        : "WhatsApp send failed.",
      error:
        sendResult.stderr.trim() ||
        sendResult.stdout.trim() ||
        `wacli send exited with ${String(sendResult.exitCode)}`,
    };
  }

  const ownerAfter = ownerPaused ? await readOwnerStatus(flags, deps) : undefined;
  const status: SendReport["status"] =
    ownerPaused && ownerRestored
      ? "sent_with_owner_restored"
      : ownerPaused && !ownerRestored
        ? "sent_with_restore_warning"
        : "sent";

  return {
    ok: true,
    status,
    command: flags.command,
    to: flags.to,
    ownerPaused,
    ownerRestored,
    ownerBefore,
    ownerStop,
    ownerAfter,
    send: {
      exitCode: sendResult.exitCode,
      stdout: sendResult.stdout,
      stderr: sendResult.stderr,
      timedOut: sendResult.timedOut,
    },
    retryAttempted,
    message: buildSuccessMessage(flags, ownerPaused, ownerRestored),
  };
}

function emit(report: SendReport, asJson: boolean) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`status=${report.status}`);
  console.log(`message=${report.message}`);
  console.log(`owner_paused=${String(report.ownerPaused)}`);
  console.log(`owner_restored=${String(report.ownerRestored)}`);
  console.log(`retry_attempted=${String(report.retryAttempted)}`);
  if (report.ownerStop?.forcedStop) {
    console.log("owner_stop_forced=true");
  }
  if (report.ownerStop?.stopSignal) {
    console.log(`owner_stop_signal=${report.ownerStop.stopSignal}`);
  }
  if (!report.ok && report.error) {
    console.log(`error=${report.error}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const report = await runOwnerSafeSend(flags);
  emit(report, flags.json);
  process.exit(report.ok ? 0 : 1);
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    const scriptName = path.basename(process.argv[1] ?? "wacli-send-safe.ts");
    console.error(`${scriptName}: ${String(error)}`);
    process.exit(1);
  });
}

export { buildSendArgs, containsLockError, parseArgs, runOwnerSafeSend };
export type { Flags, LiveStatus, SendReport };
