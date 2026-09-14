#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  "Library/Application Support/Jarvis/.jarvis/ops/memory-pressure-observer/state.json",
);
const DEFAULT_NOTIFY = path.join(
  os.homedir(),
  "Library/Application Support/OpenClaw/.openclaw/workspace/bin/jarvis-telegram-notify.sh",
);
// Five-minute sampling remains fast enough for admission control diagnostics,
// while user-visible notifications require a genuinely sustained condition.
const WARNING_CONFIRMATION_SAMPLES = 6;
const CRITICAL_CONFIRMATION_SAMPLES = 2;
const RECOVERY_CONFIRMATION_SAMPLES = 12;

function parseArgs(argv) {
  const args = {
    statePath: process.env.OPENCLAW_MEMORY_OBSERVER_STATE_PATH || DEFAULT_STATE_PATH,
    notifyCommand: process.env.OPENCLAW_MEMORY_OBSERVER_NOTIFY_COMMAND || DEFAULT_NOTIFY,
    samplePath: undefined,
    threadId: process.env.OPENCLAW_MEMORY_OBSERVER_THREAD_ID || undefined,
    nowMs: Date.now(),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--state-path") {
      args.statePath = next();
    } else if (arg === "--notify-command") {
      args.notifyCommand = next();
    } else if (arg === "--sample-json") {
      args.samplePath = next();
    } else if (arg === "--now-ms") {
      args.nowMs = Number(next());
    } else if (arg === "--thread-id") {
      args.threadId = next();
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: macos-memory-pressure-observer.mjs [--state-path PATH] [--sample-json PATH] [--notify-command PATH] [--thread-id ID] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.nowMs)) {
    throw new Error("--now-ms must be numeric");
  }
  if (args.threadId && !/^\d+$/.test(args.threadId)) {
    throw new Error("--thread-id must be a positive integer");
  }
  return args;
}

function parseLastNumber(output, pattern, label) {
  const match = output.match(pattern);
  if (!match) {
    throw new Error(`Unable to parse ${label}`);
  }
  return Number(match[1]);
}

async function command(command, args) {
  const result = await execFileAsync(command, args, { encoding: "utf8", timeout: 10_000 });
  return result.stdout;
}

async function sampleHost() {
  // Pressure state and the 25% free-memory floor are the only enforcement
  // inputs. Swap/pageout counters are deliberately diagnostic history.
  const [levelRaw, pressureRaw, swapRaw, vmRaw] = await Promise.all([
    command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    command("/usr/bin/memory_pressure", []),
    command("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    command("/usr/bin/vm_stat", []),
  ]);
  return {
    pressureLevel: Number(levelRaw.trim()),
    freePercent: parseLastNumber(
      pressureRaw,
      /System-wide memory free percentage:\s*(\d+)%/i,
      "free memory percentage",
    ),
    swapUsedMiB: parseLastNumber(swapRaw, /used\s*=\s*([\d.]+)M/i, "swap used"),
    pageouts: parseLastNumber(vmRaw, /Pageouts:\s*(\d+)/i, "pageouts"),
    swapouts: parseLastNumber(vmRaw, /Swapouts:\s*(\d+)/i, "swapouts"),
  };
}

function classify(sample) {
  for (const key of ["pressureLevel", "freePercent", "swapUsedMiB", "pageouts", "swapouts"]) {
    if (!Number.isFinite(sample[key])) {
      throw new Error(`Invalid sample field: ${key}`);
    }
  }
  if (sample.pressureLevel >= 4) {
    return "critical";
  }
  // A transient kernel warning with ample headroom is useful to the internal
  // heavy-work guard but was far too noisy as a human notification. The FYI
  // observer warns only when measured headroom is actually below the floor.
  if (sample.freePercent < 25) {
    return "warn";
  }
  return "healthy";
}

function defaultState() {
  return {
    schemaVersion: 2,
    severity: "healthy",
    pendingSeverity: "healthy",
    pendingCount: 0,
    recoveryCount: 0,
    episodeId: 0,
    notifiedLevels: [],
    lastRecoveryAttemptedEpisodeId: null,
    lastNotificationAttempt: null,
    lastSample: null,
  };
}

async function loadState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (state.schemaVersion !== 1 && state.schemaVersion !== 2) {
      throw new Error("unsupported schema");
    }
    if (state.schemaVersion === 1) {
      // Version 1 could retain recoveryNotificationPending after an ambiguous
      // send and replay stale recovery notices. Drop that flag, but preserve a
      // sanitized active episode and its delivered levels so deployment cannot
      // create a duplicate alert for pressure that is already in progress.
      const severity = ["healthy", "warn", "critical"].includes(state.severity)
        ? state.severity
        : "healthy";
      const pendingSeverity = ["healthy", "warn", "critical"].includes(state.pendingSeverity)
        ? state.pendingSeverity
        : severity;
      const episodeId =
        Number.isInteger(state.episodeId) && state.episodeId >= 0 ? state.episodeId : 0;
      return {
        ...defaultState(),
        severity,
        pendingSeverity,
        pendingCount:
          Number.isInteger(state.pendingCount) && state.pendingCount >= 0 ? state.pendingCount : 0,
        recoveryCount:
          Number.isInteger(state.recoveryCount) && state.recoveryCount >= 0
            ? state.recoveryCount
            : 0,
        episodeId,
        notifiedLevels: Array.isArray(state.notifiedLevels)
          ? [
              ...new Set(
                state.notifiedLevels.filter((level) => level === "warn" || level === "critical"),
              ),
            ]
          : [],
        lastSample: state.lastSample ?? null,
      };
    }
    const defaults = defaultState();
    return Object.fromEntries(
      Object.keys(defaults).map((key) => [key, state[key] ?? defaults[key]]),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return defaultState();
    }
    // A corrupt state must not erase dedupe history and cause notification spam.
    throw new Error(`State is unreadable; refusing to notify: ${String(error)}`, { cause: error });
  }
}

async function saveState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const staged = `${statePath}.staged-${process.pid}`;
  await fs.writeFile(staged, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(staged, 0o600);
  await fs.rename(staged, statePath);
}

function formatMiB(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "unknown";
}

function alertMessage(severity, sample) {
  const facts = `Memory available: ${sample.freePercent}%. Swap allocated: ${formatMiB(sample.swapUsedMiB)} MB (history, not a reboot threshold).`;
  if (severity === "critical") {
    return `Mac memory pressure is critical and has persisted across checks. ${facts} New heavy jobs are being held. Close finished Codex chats and restart Codex first when safe. Restart the Mac only if pressure remains unhealthy afterward. Nothing will be killed or restarted automatically.`;
  }
  return `Mac memory pressure has stayed high across checks. ${facts} New heavy jobs are being held. Close finished Codex chats and restart Codex first when convenient. No Mac restart is recommended yet, and nothing will be killed automatically.`;
}

function recoveryMessage(sample) {
  return `Mac memory recovered. Memory available: ${sample.freePercent}%. Swap allocated: ${formatMiB(sample.swapUsedMiB)} MB, which may be historical. No restart is needed now.`;
}

async function notify(args, message) {
  if (args.dryRun) {
    console.log(`MEMORY_OBSERVER_NOTIFICATION dry_run=1 message=${JSON.stringify(message)}`);
    return;
  }
  const notifyArgs = ["--session-id", "Mac memory health", "--message", message];
  if (args.threadId) {
    notifyArgs.push("--thread-id", args.threadId);
  }
  await execFileAsync(args.notifyCommand, notifyArgs, {
    timeout: 60_000,
    encoding: "utf8",
  });
}

function updateState(state, observed) {
  let notificationKind = null;
  if (observed === "healthy") {
    state.pendingSeverity = "healthy";
    state.pendingCount = 0;
    if (state.severity !== "healthy") {
      state.recoveryCount += 1;
      if (state.recoveryCount >= RECOVERY_CONFIRMATION_SAMPLES) {
        state.severity = "healthy";
        state.recoveryCount = 0;
        state.notifiedLevels = [];
        if (state.lastRecoveryAttemptedEpisodeId !== state.episodeId) {
          notificationKind = "recovery";
        }
      }
    } else {
      state.recoveryCount = 0;
    }
    return { state, notificationKind };
  }

  state.recoveryCount = 0;
  // Once an episode reaches critical, a merely-warn sample is not recovery and
  // must not emit a lower-severity follow-up. Only confirmed healthy samples
  // close the critical episode.
  if (state.severity === "critical" && observed === "warn") {
    state.pendingSeverity = "critical";
    state.pendingCount = 0;
    return { state, notificationKind };
  }
  if (state.pendingSeverity === observed) {
    state.pendingCount += 1;
  } else {
    state.pendingSeverity = observed;
    state.pendingCount = 1;
  }
  const requiredSamples =
    observed === "critical" ? CRITICAL_CONFIRMATION_SAMPLES : WARNING_CONFIRMATION_SAMPLES;
  if (state.pendingCount < requiredSamples) {
    return { state, notificationKind };
  }

  const wasHealthy = state.severity === "healthy";
  const escalated = observed === "critical" && state.severity !== "critical";
  state.severity = observed;
  if (wasHealthy) {
    state.episodeId += 1;
    state.notifiedLevels = [];
  }
  if (
    (wasHealthy || escalated || state.severity === observed) &&
    !state.notifiedLevels.includes(observed)
  ) {
    notificationKind = observed;
  }
  return { state, notificationKind };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = await loadState(args.statePath);
  const sample = args.samplePath
    ? JSON.parse(await fs.readFile(args.samplePath, "utf8"))
    : await sampleHost();
  const observed = classify(sample);
  const previousCounters = state.lastSample;
  const pagingReset = Boolean(
    previousCounters &&
    (sample.pageouts < previousCounters.pageouts || sample.swapouts < previousCounters.swapouts),
  );
  const result = updateState(state, observed);
  result.state.lastSample = { ...sample, observed, sampledAtMs: args.nowMs, pagingReset };

  let message = null;
  let deliveredLevel = null;
  if (result.notificationKind === "warn" || result.notificationKind === "critical") {
    message = alertMessage(result.notificationKind, sample);
    deliveredLevel = result.notificationKind;
  } else if (result.notificationKind === "recovery") {
    message = recoveryMessage(sample);
  }

  // A dry run is a pure preview. In particular, it must not advance the live
  // confirmation counters or consume the alert that the next scheduled run
  // is responsible for delivering.
  if (args.dryRun) {
    if (message) {
      await notify(args, message);
    }
    console.log(
      `MEMORY_OBSERVER_SAMPLE observed=${observed} state=${result.state.severity} pending=${result.state.pendingCount} free_percent=${sample.freePercent} swap_used_mib=${sample.swapUsedMiB} pageouts=${sample.pageouts} swapouts=${sample.swapouts} paging_reset=${pagingReset ? 1 : 0} notification=${message ? "dry-run" : "none"}`,
    );
    return;
  }

  // FYI delivery is deliberately at-most-once. Persist the attempt before the
  // external call so a successful Telegram send followed by a non-zero wrapper
  // exit cannot replay the same message every five minutes.
  if (message) {
    if (deliveredLevel) {
      result.state.notifiedLevels.push(deliveredLevel);
    }
    if (result.notificationKind === "recovery") {
      result.state.lastRecoveryAttemptedEpisodeId = result.state.episodeId;
    }
    result.state.lastNotificationAttempt = {
      kind: result.notificationKind,
      attemptedAtMs: args.nowMs,
      status: "pending",
    };
  }
  await saveState(args.statePath, result.state);
  if (message) {
    try {
      await notify(args, message);
      result.state.lastNotificationAttempt.status = "delivered";
    } catch (error) {
      result.state.lastNotificationAttempt.status = "failed";
      await saveState(args.statePath, result.state);
      throw error;
    }
    await saveState(args.statePath, result.state);
  }
  console.log(
    `MEMORY_OBSERVER_SAMPLE observed=${observed} state=${result.state.severity} pending=${result.state.pendingCount} free_percent=${sample.freePercent} swap_used_mib=${sample.swapUsedMiB} pageouts=${sample.pageouts} swapouts=${sample.swapouts} paging_reset=${pagingReset ? 1 : 0} notification=${message ? "sent" : "none"}`,
  );
}

main().catch((error) => {
  console.error(`MEMORY_OBSERVER_ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
