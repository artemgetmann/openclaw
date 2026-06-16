import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

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
  lockWaitMs: number;
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
  lockPidRunning?: boolean;
  connected?: boolean;
  message?: string;
  forcedStop?: boolean;
  stopSignal?: "SIGINT" | "SIGKILL";
  stoppedPid?: number;
  stopReason?: string;
};

type SendReceipt = {
  chatJid?: string;
  messageId?: string;
};

type SendVerification = {
  status: "verified_local" | "verified_local_after_failed_exit" | "unverified";
  chatJid?: string;
  messageId?: string;
  reason?: string;
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
  verification: SendVerification;
  retryAttempted: boolean;
  message: string;
  error?: string;
};

type Deps = {
  runCommand: typeof runCommand;
  sleep: (ms: number) => Promise<void>;
  verifySend: typeof verifyAcceptedSendInLocalHistory;
};

function usage() {
  console.error(`Usage:
  wacli-send-safe.sh text --to <recipient> --message <text> [--store <dir>] [--json] [--timeout-ms <ms>] [--lock-wait-ms <ms>] [--settle-ms <ms>] [--grace-ms <ms>]
  wacli-send-safe.sh file --to <recipient> --file <path> [--caption <text>] [--store <dir>] [--json] [--timeout-ms <ms>] [--lock-wait-ms <ms>] [--settle-ms <ms>] [--grace-ms <ms>]

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
    timeoutMs: 90_000,
    lockWaitMs: 180_000,
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
      case "--lock-wait-ms": {
        const next = rest[index + 1];
        if (!next) {
          throw new Error("--lock-wait-ms requires a value");
        }
        flags.lockWaitMs = parsePositiveInt(next, "--lock-wait-ms");
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

function parseSendReceipt(stdout: string, stderr = ""): SendReceipt {
  const raw = `${stdout}\n${stderr}`;

  // wacli can emit structured JSON. Treat `sent:true` as acceptance only, then
  // extract the returned target/id so the local DB can prove whether history saw it.
  for (const candidate of [stdout, stderr, ...raw.split(/\r?\n/)]) {
    try {
      const parsed = parseJson<{ sent?: unknown; to?: unknown; id?: unknown }>(candidate);
      if (parsed?.sent === true && typeof parsed.to === "string" && typeof parsed.id === "string") {
        return { chatJid: parsed.to, messageId: parsed.id };
      }
    } catch {
      // Human output is the common path; malformed/non-JSON lines are expected.
    }
  }

  const humanMatch = raw.match(/\bSent\s+to\s+(\S+)\s+\(id\s+([^)]+)\)/i);
  if (!humanMatch) {
    return {};
  }
  return {
    chatJid: humanMatch[1],
    messageId: humanMatch[2],
  };
}

function containsLockError(raw: string) {
  return raw.toLowerCase().includes("store is locked");
}

function sendLockDir(storeDir: string) {
  return path.join(storeDir, ".openclaw-send-safe.lock");
}

function isPidRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    return code === "EPERM";
  }
}

function readLockOwner(lockDir: string): { pid?: number; acquiredAt?: string } | undefined {
  try {
    return parseJson<{ pid?: number; acquiredAt?: string }>(
      fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

async function acquireStoreSendLock(storeDir: string, waitMs: number, deps: Pick<Deps, "sleep">) {
  fs.mkdirSync(storeDir, { recursive: true });
  const lockDir = sendLockDir(storeDir);
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify(
          { pid: process.pid, acquiredAt: new Date().toISOString(), storeDir },
          null,
          2,
        ),
      );
      return {
        release() {
          fs.rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }

      const owner = readLockOwner(lockDir);
      if (typeof owner?.pid === "number" && !isPidRunning(owner.pid)) {
        // A crashed helper can leave the coordination directory behind. Only
        // clear it when the recorded owner PID is definitely gone.
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      await deps.sleep(250);
    }
  }

  const owner = readLockOwner(lockDir);
  const ownerHint =
    typeof owner?.pid === "number"
      ? ` Current owner PID: ${String(owner.pid)}.`
      : " Current owner is unknown.";
  throw new Error(
    `Timed out waiting ${String(waitMs)}ms for safe-send lock at ${lockDir}.${ownerHint}`,
  );
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

function isOwnerReleaseSuccessful(status: LiveStatus | undefined, stoppedPid?: number) {
  if (status?.ownerRunning === true) {
    return false;
  }

  if (status?.lockPid == null) {
    return true;
  }

  if (
    typeof stoppedPid === "number" &&
    status.lockPid === stoppedPid &&
    status.lockPidRunning !== true
  ) {
    return true;
  }

  return status.lockPidRunning === false;
}

function isLiveUnrelatedLock(status: LiveStatus | undefined, stoppedPid?: number) {
  return (
    status?.ownerRunning !== true &&
    typeof status?.lockPid === "number" &&
    status.lockPidRunning === true &&
    (typeof stoppedPid !== "number" || status.lockPid !== stoppedPid)
  );
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

async function waitForOwnerRelease(
  flags: Flags,
  deps: Pick<Deps, "runCommand" | "sleep">,
  stoppedPid?: number,
) {
  const deadline = Date.now() + flags.graceMs;
  let lastStatus = await readOwnerStatus(flags, deps);

  while (Date.now() <= deadline) {
    if (isOwnerReleaseSuccessful(lastStatus, stoppedPid)) {
      return lastStatus;
    }
    if (isLiveUnrelatedLock(lastStatus, stoppedPid)) {
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

async function verifyAcceptedSendInLocalHistory(params: {
  storeDir: string;
  stdout: string;
  stderr: string;
  to?: string;
  command?: SendCommand;
  message?: string;
  caption?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  allowTargetTextFallback?: boolean;
}): Promise<SendVerification> {
  const receipt = parseSendReceipt(params.stdout, params.stderr);
  if (!receipt.chatJid || !receipt.messageId) {
    return await verifyFailedSendByTargetAndText(params);
  }

  const dbPath = path.join(params.storeDir, "wacli.db");
  let db: InstanceType<typeof DatabaseSync> | undefined;

  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1000");
    const row = db
      .prepare(
        `SELECT 1
         FROM messages
         WHERE chat_jid = ?
           AND msg_id = ?
           AND from_me = 1
         LIMIT 1`,
      )
      .get(receipt.chatJid, receipt.messageId);

    if (row) {
      return {
        status: "verified_local",
        chatJid: receipt.chatJid,
        messageId: receipt.messageId,
      };
    }

    return {
      status: "unverified",
      chatJid: receipt.chatJid,
      messageId: receipt.messageId,
      reason: `No matching outbound row found in ${dbPath}.`,
    };
  } catch (error) {
    return {
      status: "unverified",
      chatJid: receipt.chatJid,
      messageId: receipt.messageId,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

function candidateChatJids(rawTo: string | undefined) {
  if (!rawTo) {
    return [];
  }
  const candidates = new Set<string>([rawTo]);
  const digits = rawTo.replace(/\D/g, "");
  if (digits) {
    candidates.add(`${digits}@s.whatsapp.net`);
  }
  return [...candidates];
}

function fallbackSendText(params: { command?: SendCommand; message?: string; caption?: string }) {
  return params.command === "file" ? params.caption : params.message;
}

async function verifyFailedSendByTargetAndText(params: {
  storeDir: string;
  to?: string;
  command?: SendCommand;
  message?: string;
  caption?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  allowTargetTextFallback?: boolean;
}): Promise<SendVerification> {
  if (!params.allowTargetTextFallback) {
    return {
      status: "unverified",
      reason: "wacli send output did not include a chat JID and message ID to verify.",
    };
  }

  const text = fallbackSendText(params);
  const chats = candidateChatJids(params.to);
  if (!text || chats.length === 0 || params.startedAtMs == null || params.endedAtMs == null) {
    return {
      status: "unverified",
      reason:
        "Raw wacli send failed and there was not enough target/message/time data to reconcile local history.",
    };
  }

  const dbPath = path.join(params.storeDir, "wacli.db");
  let db: InstanceType<typeof DatabaseSync> | undefined;

  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1000");
    const startSeconds = Math.floor((params.startedAtMs - 5_000) / 1000);
    const endSeconds = Math.ceil((params.endedAtMs + 5_000) / 1000);
    const placeholders = chats.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT chat_jid, msg_id
         FROM messages
         WHERE from_me = 1
           AND ts BETWEEN ? AND ?
           AND chat_jid IN (${placeholders})
           AND (text = ? OR display_text = ? OR media_caption = ?)
         ORDER BY ts DESC, rowid DESC
         LIMIT 2`,
      )
      .all(startSeconds, endSeconds, ...chats, text, text, text) as Array<{
      chat_jid: string;
      msg_id: string;
    }>;

    if (rows.length === 1) {
      return {
        status: "verified_local_after_failed_exit",
        chatJid: rows[0].chat_jid,
        messageId: rows[0].msg_id,
        reason:
          "Raw wacli send failed or timed out, but exactly one matching outbound row was found in local history.",
      };
    }

    return {
      status: "unverified",
      reason:
        rows.length === 0
          ? `No matching outbound row found in ${dbPath} after failed raw send.`
          : `Multiple matching outbound rows found in ${dbPath}; leaving send unverified.`,
    };
  } catch (error) {
    return {
      status: "unverified",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

function buildSuccessMessage(
  flags: Flags,
  ownerPaused: boolean,
  ownerRestored: boolean,
  verification: SendVerification,
) {
  const acceptedPrefix = ownerPaused
    ? ownerRestored
      ? `Paused the live sync owner, accepted the WhatsApp ${flags.command}, and restored the owner`
      : `Paused the live sync owner and accepted the WhatsApp ${flags.command}, but restoring the owner needs attention`
    : `Accepted WhatsApp ${flags.command}`;

  if (verification.status === "verified_local") {
    return `${acceptedPrefix} and verified it in local history.`;
  }
  if (verification.status === "verified_local_after_failed_exit") {
    return `Raw wacli send did not exit cleanly, but the outbound ${flags.command} was found exactly once in local history.`;
  }

  const reason = verification.reason ? ` Reason: ${verification.reason}` : "";
  return `${acceptedPrefix}, but it was not verified in local history.${reason} Open the WhatsApp chat or use a wa.me fallback manually before claiming delivery or thread proof.`;
}

function unverified(reason: string): SendVerification {
  return { status: "unverified", reason };
}

function defaultDeps(): Deps {
  return { runCommand, sleep, verifySend: verifyAcceptedSendInLocalHistory };
}

function mergeDeps(overrides: Partial<Deps>): Deps {
  return {
    runCommand,
    sleep,
    verifySend: verifyAcceptedSendInLocalHistory,
    ...overrides,
  };
}

function emptySendResult() {
  return { exitCode: null, stdout: "", stderr: "", timedOut: false };
}

function failedPauseVerification() {
  return unverified(
    "Send was not attempted because the recorded wacli sync owner could not be paused.",
  );
}

function missingSendResultVerification() {
  return unverified("Raw wacli send did not produce a result.");
}

function resolveDeps(deps: Partial<Deps> | undefined): Deps {
  return deps ? mergeDeps(deps) : defaultDeps();
}

async function runOwnerSafeSend(flags: Flags, depsOverrides?: Partial<Deps>): Promise<SendReport> {
  const deps = resolveDeps(depsOverrides);
  const lock = await acquireStoreSendLock(flags.storeDir, flags.lockWaitMs, deps);
  try {
    return await runOwnerSafeSendLocked(flags, deps);
  } finally {
    lock.release();
  }
}

async function runOwnerSafeSendLocked(flags: Flags, deps: Deps): Promise<SendReport> {
  const ownerBefore = await readOwnerStatus(flags, deps);
  const shouldPauseOwner =
    ownerBefore?.ownerRunning === true && ownerBefore.ownerCommandMatches === true;

  let ownerPaused = false;
  let ownerRestored = false;
  let retryAttempted = false;
  let sendResult: CommandResult | undefined;
  let sendRaw = "";
  let sendStartedAtMs: number | undefined;
  let sendEndedAtMs: number | undefined;
  let ownerStop: LiveStatus | undefined;
  let pauseFailureReport: SendReport | undefined;

  if (shouldPauseOwner) {
    ownerStop = await runLiveCommand("stop", flags, deps);
    const releaseStatus = await waitForOwnerRelease(flags, deps, ownerStop?.stoppedPid);
    ownerPaused = isOwnerReleaseSuccessful(releaseStatus, ownerStop?.stoppedPid);
    if (!ownerPaused) {
      pauseFailureReport = {
        ok: false,
        status: "failed",
        command: flags.command,
        to: flags.to,
        ownerPaused: false,
        ownerRestored: false,
        ownerBefore,
        ownerStop,
        send: emptySendResult(),
        verification: failedPauseVerification(),
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
    if (!pauseFailureReport) {
      sendStartedAtMs = Date.now();
      sendResult = await sendOnce(flags, deps);
      sendEndedAtMs = Date.now();
      sendRaw = `${sendResult.stdout}\n${sendResult.stderr}`;

      if (!sendResult.ok && shouldPauseOwner && containsLockError(sendRaw)) {
        retryAttempted = true;
        await waitForOwnerRelease(flags, deps, ownerStop?.stoppedPid);
        sendStartedAtMs = Date.now();
        sendResult = await sendOnce(flags, deps);
        sendEndedAtMs = Date.now();
        sendRaw = `${sendResult.stdout}\n${sendResult.stderr}`;
      }
    }
  } finally {
    if (ownerStop?.stoppedPid != null) {
      const restored = await runLiveCommand("ensure", flags, deps);
      ownerRestored = Boolean(restored?.connected || restored?.ownerRunning);
    }
  }

  if (pauseFailureReport) {
    pauseFailureReport.ownerRestored = ownerRestored;
    return pauseFailureReport;
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
      send: emptySendResult(),
      verification: missingSendResultVerification(),
      retryAttempted,
      message: "WhatsApp send did not start.",
      error: "No send result was produced.",
    };
  }

  if (!sendResult.ok) {
    const verification = await deps.verifySend({
      storeDir: flags.storeDir,
      stdout: sendResult.stdout,
      stderr: sendResult.stderr,
      to: flags.to,
      command: flags.command,
      message: flags.message,
      caption: flags.caption,
      startedAtMs: sendStartedAtMs,
      endedAtMs: sendEndedAtMs ?? Date.now(),
      allowTargetTextFallback: true,
    });

    if (verification.status === "verified_local_after_failed_exit") {
      const reconciledStatus: SendReport["status"] =
        ownerPaused && ownerRestored
          ? "sent_with_owner_restored"
          : ownerPaused && !ownerRestored
            ? "sent_with_restore_warning"
            : "sent";
      return {
        ok: true,
        status: reconciledStatus,
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
        verification,
        retryAttempted,
        message: buildSuccessMessage(flags, ownerPaused, ownerRestored, verification),
        error:
          sendResult.stderr.trim() ||
          sendResult.stdout.trim() ||
          `wacli send exited with ${String(sendResult.exitCode)}`,
      };
    }

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
      verification,
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
  const verification = await deps.verifySend({
    storeDir: flags.storeDir,
    stdout: sendResult.stdout,
    stderr: sendResult.stderr,
    to: flags.to,
    command: flags.command,
    message: flags.message,
    caption: flags.caption,
    startedAtMs: sendStartedAtMs,
    endedAtMs: sendEndedAtMs,
  });

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
    verification,
    retryAttempted,
    message: buildSuccessMessage(flags, ownerPaused, ownerRestored, verification),
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
  console.log(`send_exit_code=${String(report.send.exitCode)}`);
  console.log(`send_timed_out=${String(report.send.timedOut)}`);
  if (report.send.stdout) {
    console.log(`send_stdout=${JSON.stringify(report.send.stdout)}`);
  }
  if (report.send.stderr) {
    console.log(`send_stderr=${JSON.stringify(report.send.stderr)}`);
  }
  console.log(`verification_status=${report.verification.status}`);
  if (report.verification.chatJid) {
    console.log(`verification_chat_jid=${report.verification.chatJid}`);
  }
  if (report.verification.messageId) {
    console.log(`verification_message_id=${report.verification.messageId}`);
  }
  if (report.verification.reason) {
    console.log(`verification_reason=${report.verification.reason}`);
  }
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

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    const scriptName = path.basename(process.argv[1] ?? "wacli-send-safe.ts");
    console.error(`${scriptName}: ${String(error)}`);
    process.exit(1);
  });
}

export {
  buildSendArgs,
  containsLockError,
  parseArgs,
  parseSendReceipt,
  runOwnerSafeSend,
  verifyAcceptedSendInLocalHistory,
};
export type { Flags, LiveStatus, SendReceipt, SendReport, SendVerification };
