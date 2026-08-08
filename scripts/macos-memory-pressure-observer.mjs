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
const CONFIRMATION_SAMPLES = 2;
const RECOVERY_SAMPLES = 2;

function parseArgs(argv) {
  const args = {
    statePath: process.env.OPENCLAW_MEMORY_OBSERVER_STATE_PATH || DEFAULT_STATE_PATH,
    notifyCommand: process.env.OPENCLAW_MEMORY_OBSERVER_NOTIFY_COMMAND || DEFAULT_NOTIFY,
    samplePath: undefined,
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
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: macos-memory-pressure-observer.mjs [--state-path PATH] [--sample-json PATH] [--notify-command PATH] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.nowMs)) {
    throw new Error("--now-ms must be numeric");
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
  if (sample.pressureLevel >= 2 || sample.freePercent < 25) {
    return "warn";
  }
  return "healthy";
}

function defaultState() {
  return {
    schemaVersion: 1,
    severity: "healthy",
    pendingSeverity: "healthy",
    pendingCount: 0,
    recoveryCount: 0,
    episodeId: 0,
    notifiedLevels: [],
    recoveryNotificationPending: false,
    lastWeeklyKey: null,
    lastSample: null,
  };
}

async function loadState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (state.schemaVersion !== 1) {
      throw new Error("unsupported schema");
    }
    return { ...defaultState(), ...state };
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

function localWeeklyKey(nowMs) {
  const now = new Date(nowMs);
  // launchd runs every five minutes. Sunday at/after 10:30 gets one report per
  // local calendar week, even if the exact 10:30 tick was delayed or missed.
  if (
    now.getDay() !== 0 ||
    now.getHours() < 10 ||
    (now.getHours() === 10 && now.getMinutes() < 30)
  ) {
    return null;
  }
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
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

function weeklyMessage(state, sample) {
  if (state.severity === "healthy") {
    return `Weekly Mac memory check: healthy. Memory available: ${sample.freePercent}%. Swap allocated: ${formatMiB(sample.swapUsedMiB)} MB (historical telemetry). No restart needed.`;
  }
  return `Weekly Mac memory check: ${state.severity}. Memory available: ${sample.freePercent}%. Restart Codex first when safe; restart the Mac only if pressure remains unhealthy afterward.`;
}

async function notify(args, message) {
  if (args.dryRun) {
    console.log(`MEMORY_OBSERVER_NOTIFICATION dry_run=1 message=${JSON.stringify(message)}`);
    return;
  }
  await execFileAsync(
    args.notifyCommand,
    ["--session-id", "Mac memory health", "--message", message],
    {
      timeout: 60_000,
      encoding: "utf8",
    },
  );
}

function updateState(state, observed) {
  let notificationKind = null;
  if (observed === "healthy") {
    state.pendingSeverity = "healthy";
    state.pendingCount = 0;
    if (state.severity !== "healthy") {
      state.recoveryCount += 1;
      if (state.recoveryCount >= RECOVERY_SAMPLES) {
        state.severity = "healthy";
        state.recoveryCount = 0;
        state.notifiedLevels = [];
        state.recoveryNotificationPending = true;
        notificationKind = "recovery";
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
  if (state.pendingCount < CONFIRMATION_SAMPLES) {
    return { state, notificationKind };
  }

  const wasHealthy = state.severity === "healthy";
  const escalated = observed === "critical" && state.severity !== "critical";
  state.severity = observed;
  if (wasHealthy) {
    state.episodeId += 1;
    state.notifiedLevels = [];
  }
  // A failed delivery leaves the level absent from notifiedLevels. Retry the
  // same bounded episode notification on the next scheduled sample.
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
  } else if (result.notificationKind === "recovery" || result.state.recoveryNotificationPending) {
    message = recoveryMessage(sample);
  }

  const weeklyKey = localWeeklyKey(args.nowMs);
  if (!message && observed === "healthy" && weeklyKey && weeklyKey !== result.state.lastWeeklyKey) {
    message = weeklyMessage(result.state, sample);
  }

  // Persist observations before a send, but record delivery dedupe only after
  // the notification command succeeds. A failed send is safely retried.
  await saveState(args.statePath, result.state);
  if (message) {
    await notify(args, message);
    if (deliveredLevel) {
      result.state.notifiedLevels.push(deliveredLevel);
    }
    if (result.state.recoveryNotificationPending) {
      result.state.recoveryNotificationPending = false;
    }
    if (weeklyKey) {
      result.state.lastWeeklyKey = weeklyKey;
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
