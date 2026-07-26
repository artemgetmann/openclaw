#!/usr/bin/env bash
set -euo pipefail

# This proof is deliberately a two-mode tool. Dry-run stays shell-builtin-only so
# operators can inspect the exact plan without touching the runtime, network,
# filesystem, process table, lock, logs, Telegram, or session state.
MODE=""
EXPECTED_COMMIT=""
RUNTIME_SOURCE="jarvis-managed-bundle"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--execute)
      [[ -z "$MODE" ]] || { printf '%s\n' "choose exactly one of --dry-run or --execute" >&2; exit 2; }
      MODE="${1#--}"
      shift
      ;;
    --expected-commit)
      [[ $# -ge 2 ]] || { printf '%s\n' "--expected-commit requires a value" >&2; exit 2; }
      EXPECTED_COMMIT="$2"
      shift 2
      ;;
    --runtime-source)
      [[ $# -ge 2 ]] || { printf '%s\n' "--runtime-source requires a value" >&2; exit 2; }
      RUNTIME_SOURCE="$2"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ -n "$MODE" ]] || { printf '%s\n' "choose --dry-run or --execute" >&2; exit 2; }
[[ "$RUNTIME_SOURCE" == "jarvis-managed-bundle" || \
  "$RUNTIME_SOURCE" == "jarvis-break-glass-hotfix" ]] || {
  printf '%s\n' "--runtime-source must be jarvis-managed-bundle or jarvis-break-glass-hotfix" >&2
  exit 2
}
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || {
  printf '%s\n' "--expected-commit must be a 7-40 character hexadecimal commit" >&2
  exit 2
}
# macOS still ships Bash 3.2, so normalize hexadecimal case with portable
# parameter substitutions instead of Bash 4's ${value,,} expansion.
EXPECTED_COMMIT="${EXPECTED_COMMIT//A/a}"
EXPECTED_COMMIT="${EXPECTED_COMMIT//B/b}"
EXPECTED_COMMIT="${EXPECTED_COMMIT//C/c}"
EXPECTED_COMMIT="${EXPECTED_COMMIT//D/d}"
EXPECTED_COMMIT="${EXPECTED_COMMIT//E/e}"
EXPECTED_COMMIT="${EXPECTED_COMMIT//F/f}"

LAB_CHAT="${OPENCLAW_JARVIS_LAB_CHAT_ID:--1003783709877}"
[[ "$LAB_CHAT" =~ ^-[0-9]+$ ]] || {
  printf '%s\n' "OPENCLAW_JARVIS_LAB_CHAT_ID must be a numeric Telegram chat id" >&2
  exit 2
}

if [[ "$MODE" == "dry-run" ]]; then
  # Keep this JSON literal and parseable. In particular, do not generate a nonce
  # here: even temporary randomness would make dry-run dynamic and harder to audit.
  printf '{"schema":"openclaw.jarvis-telegram-runtime-proof.v2","mode":"dry-run","expectedCommit":"%s","runtimeSource":{"selected":"%s","default":"jarvis-managed-bundle","autoFallback":false},"target":{"selector":"OPENCLAW_JARVIS_LAB_CHAT_ID","chatId":"%s","defaultChatId":"-1003783709877"},"mutations":false,"plan":["prove-selected-runtime-provenance","acquire-machine-canary-lock","snapshot-pid-bot-transport-log","create-generated-topic","send-generated-anchor-only","wait-bounded-thread-reply","read-bounded-evidence","verify-runtime-and-appended-log","delete-exact-topic-and-verify-marker-absent","delete-one-canonical-session-via-gateway-api","verify-session-absent","release-token-matched-lock","emit-one-structured-evidence-object"]}\n' \
    "$EXPECTED_COMMIT" "$RUNTIME_SOURCE" "$LAB_CHAT"
  exit 0
fi

# Execute is intentionally pinned to the installed consumer runtime. The only
# selector exposed to operators is the named Jarvis Lab chat environment above.
JARVIS_HOME="${HOME}/Library/Application Support/Jarvis"
JARVIS_STATE_DIR="${JARVIS_HOME}/.jarvis"
JARVIS_NODE="${JARVIS_STATE_DIR}/tools/node/bin/node"
JARVIS_ENTRYPOINT="${JARVIS_STATE_DIR}/lib/openclaw-bundled/dist/index.js"
ROOT_DIR="${BASH_SOURCE[0]%/*}/.."

[[ -x "$JARVIS_NODE" ]] || {
  printf '{"schema":"openclaw.jarvis-telegram-runtime-proof.v2","result":"failed","reason":"installed Jarvis Node is unavailable","runtimeSource":{"selected":"%s","observed":null,"autoFallback":false},"cleanup":{"topic":"not-created","session":"not-inspected","lock":"not-acquired"},"residuals":[]}\n' "$RUNTIME_SOURCE"
  exit 1
}

exec "$JARVIS_NODE" --input-type=module - "$EXPECTED_COMMIT" "$RUNTIME_SOURCE" "$LAB_CHAT" "$ROOT_DIR" "$JARVIS_ENTRYPOINT" "$JARVIS_STATE_DIR" <<'NODE'
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [expectedCommit, selectedRuntimeSource, labChat, repoRoot, entrypoint, stateDir] = process.argv.slice(2);
const label = "ai.jarvis.gateway";
const logPath = path.join(stateDir, "logs", "gateway.log");
const testMode = process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_MODE === "1";
const gate = testMode && process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_GATE
  ? process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_GATE
  : path.join(repoRoot, "scripts", "prove-jarvis-runtime.sh");
const launchctl = testMode && process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_LAUNCHCTL
  ? process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_LAUNCHCTL
  : "launchctl";
const lockPath = testMode && process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_LOCK
  ? process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_LOCK
  : `/tmp/openclaw-jarvis-telegram-canary-${process.getuid()}.lock`;

const runId = crypto.randomUUID();
const nonce = `JARVIS_RUNTIME_CANARY_${runId.replaceAll("-", "").toUpperCase()}`;
const title = `Jarvis runtime canary ${runId}`;
const prompt = `Reply with exactly ${nonce}`;
const startedAt = Date.now();
const token = crypto.randomBytes(24).toString("hex");
let workspace = "";
let lockHeld = false;
let topicAnchor = 0;
let topicCreationAttempted = false;
let topicCreationUncertain = false;
let uncertainTopicIds;
let topicDeleted = false;
let markerAbsent = false;
let canonicalSessionKey = "";
let sessionDeleted = false;
let sessionAbsent = false;
let sentMessageId = 0;
let sentSenderId = 0;
let replyMessageId = 0;
let replySenderId = 0;
let replyThreadAnchor = 0;
let proofPassed = false;
let failureReason = "";
let botIdentity;
let pidBefore = 0;
let pidAfter = 0;
let transportBefore;
let transportAfter;
let operatorBackend;
let appendedLogBytes = 0;
let appendedLogScan = "not-run";
let archives = [];
let provenanceIdentity;
let provenanceFailure;
const residuals = [];
const actions = [];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function parseJson(text, stage) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${stage} did not return parseable JSON`);
  }
}

function managedChildEnv() {
  const childEnv = { ...process.env };
  // These selectors outrank the managed config used by both the provenance
  // gate and gateway CLI. One shared builder prevents the two proof layers
  // from silently inspecting different listeners or credentials.
  for (const key of [
    "OPENCLAW_GATEWAY_URL",
    "CLAWDBOT_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "CLAWDBOT_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "CLAWDBOT_GATEWAY_PASSWORD",
    "CLAWDBOT_GATEWAY_PORT",
    // Consumer instance identity outranks OPENCLAW_PROFILE and rewrites the
    // state/config roots. Letting a tester lane leak through here could prove
    // the main gateway while mutating that lane's Telegram account.
    "OPENCLAW_CONSUMER_INSTANCE_ID",
    // The packaged runtime's persisted monitor binding owns Telegram operator
    // credentials. Shell selectors must not override it with a stale personal
    // or worktree session during a managed canary.
    "USERBOT_SESSION",
    "OPENCLAW_TELEGRAM_USER_SESSION",
    "OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION",
    "OPENCLAW_TELEGRAM_USER_LOCK_PATH",
  ]) {
    delete childEnv[key];
  }
  return {
    ...childEnv,
    OPENCLAW_HOME: path.dirname(stateDir),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_LOG_DIR: path.join(stateDir, "logs"),
    OPENCLAW_PROFILE: "consumer",
    OPENCLAW_LAUNCHD_LABEL: label,
    OPENCLAW_JARVIS_GATEWAY_LABEL: label,
    OPENCLAW_GATEWAY_PORT: "18789",
    // Receipt selectors are test seams in the reusable runtime prover, but the
    // daily canary must always bind them to canonical installed Jarvis state.
    // Never let an operator shell redirect provenance to alternate fixtures.
    OPENCLAW_JARVIS_INSTALLED_MANIFEST: path.join(stateDir, ".consumer-bundled-runtime.json"),
    OPENCLAW_JARVIS_PROTECTION_MARKER: path.join(stateDir, ".consumer-bundled-runtime.protection.json"),
    OPENCLAW_INSTALLED_JARVIS_APP_PATH: "/Applications/Jarvis.app",
    OPENCLAW_JARVIS_APP_MANIFEST: "/Applications/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json",
  };
}

// Every CLI call gets the complete installed-runtime identity. Inherited shell
// state cannot silently redirect this proof to a source checkout or shared bot.
function jarvis(args, stage) {
  actions.push(stage);
  const isTelegramUser = args[0] === "telegram-user";
  // Resolve the packaged credential context once during precheck. Pin both
  // selectors before every later Telegram mutation so an atomic binding update
  // cannot switch accounts between command execution and metadata validation.
  const pinnedArgs = isTelegramUser && operatorBackend
    ? [
        ...args,
        "--env-file", operatorBackend.envFile,
        "--session", operatorBackend.sessionPath,
      ]
    : args;
  const result = run(process.execPath, [entrypoint, ...pinnedArgs], {
    env: managedChildEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`${stage} failed with status ${String(result.status)}`);
  }
  const payload = parseJson(result.stdout, stage);
  if (isTelegramUser) {
    const meta = payload?.backend_meta;
    const stateDefaultSession = path.join(stateDir, "telegram-user", "userbot.session");
    const stateDefaultEnvFile = path.join(stateDir, "telegram-user", ".env.local");
    // The canary may trust a persisted monitor binding or the packaged state
    // fallback. It must never promote legacy machine/env/repo discovery into an
    // authority for live mutations merely because that database is readable.
    const packagedEnvSource = meta?.env_file_source === "monitor-binding"
      || (meta?.env_file_source === "runtime-default"
        && meta?.env_file === stateDefaultEnvFile);
    // Session provenance is interpreted inside the already-proven credential
    // context. USERBOT_SESSION from a persisted monitor env file is
    // session_source=env-file, while an env-only binding may legitimately fall
    // back to the packaged state session.
    const packagedSessionSource = meta?.session_source === "monitor-binding"
      || meta?.session_source === "env-file"
      || (meta?.session_source === "state-default"
        && meta?.session_path === stateDefaultSession);
    if (typeof meta?.session_source !== "string"
      || typeof meta?.session_path !== "string"
      || !path.isAbsolute(meta.session_path)
      || typeof meta?.env_file !== "string"
      || !path.isAbsolute(meta.env_file)
      || meta?.lock_scope !== "machine"
      || (!operatorBackend && (!packagedEnvSource || !packagedSessionSource))) {
      throw new Error(`${stage} returned mismatched operator backend ownership`);
    }
    // Precheck establishes the packaged resolver's authoritative session.
    // Every later mutation must prove it resolved the same owner again.
    if (operatorBackend
      && (meta.session_path !== operatorBackend.sessionPath
        || meta.env_file !== operatorBackend.envFile
        || meta.env_file_source !== "explicit"
        || meta.session_source !== "explicit")) {
      throw new Error(`${stage} returned changed operator backend ownership`);
    }
  }
  return payload;
}

function field(object, names) {
  for (const name of names) {
    if (object && object[name] !== undefined) return object[name];
  }
  return undefined;
}

function snapshotAccount(payload) {
  const accounts = payload?.channelAccounts?.telegram;
  const account = Array.isArray(accounts)
    ? accounts.find((item) => item?.accountId === "default")
    : accounts?.default;
  if (!account || account.accountId !== "default") {
    throw new Error("channels.status did not return exactly the default Telegram account");
  }
  return account;
}

function validateStatus(payload, requireProbe) {
  const account = snapshotAccount(payload);
  if (account.running !== true || account.connected !== true) {
    throw new Error("default Telegram account is not running and connected");
  }
  if (requireProbe) {
    const bot = account?.probe?.bot;
    if (account?.probe?.ok !== true || !bot || !Number.isSafeInteger(Number(bot.id)) || !bot.username) {
      throw new Error("default Telegram bot identity probe is incomplete");
    }
    botIdentity = { accountId: "default", id: String(bot.id), username: String(bot.username) };
  }
  if (!account.transportActivity) {
    throw new Error("default Telegram transport activity is unavailable");
  }
  // Poll counters live under transportActivity, while the timestamps needed to
  // prove inbound/outbound flow are account-level channel snapshot fields.
  return {
    ...structuredClone(account.transportActivity),
    lastPollCompletedAt: account.lastPollCompletedAt ?? null,
    lastInboundAt: account.lastInboundAt ?? null,
    lastOutboundAt: account.lastOutboundAt ?? null,
  };
}

function parseProvenance(stdout) {
  const selected = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    // The canonical helper prefixes proof lines with its script name.
    const match = line.match(/^(?:\[prove-jarvis-runtime\]\s+)?([a-z_]+)=(.*)$/);
    if (match) selected.set(match[1], match[2]);
  }
  const identity = {
    proof: selected.get("jarvis_runtime_proof"),
    serviceLabel: selected.get("service_label"),
    runtimeSource: selected.get("runtime_source"),
    runtimeCommit: selected.get("runtime_commit"),
    runtimePackageVersion: selected.get("runtime_package_version"),
    launchServiceVersion: selected.get("launch_service_version"),
    stateDir: selected.get("state_dir"),
    configPath: selected.get("config_path"),
    pid: Number(selected.get("pid")),
    listener: selected.get("listener"),
    rpc: selected.get("rpc"),
    health: selected.get("health"),
  };
  const normalizedRuntimeCommit = identity.runtimeCommit?.toLowerCase();
  const normalizedExpectedCommit = expectedCommit.toLowerCase();
  // The runtime prover intentionally emits a short SHA. Accept either side as
  // the prefix so callers may supply the normal full 40-character commit.
  const commitMatches = /^[0-9a-f]{7,40}$/.test(normalizedRuntimeCommit ?? "")
    && (normalizedRuntimeCommit.startsWith(normalizedExpectedCommit)
      || normalizedExpectedCommit.startsWith(normalizedRuntimeCommit));
  if (identity.proof !== "true"
    || identity.serviceLabel !== label
    || identity.runtimeSource !== selectedRuntimeSource
    || !commitMatches
    || identity.stateDir !== stateDir
    || identity.configPath !== path.join(stateDir, "openclaw.json")
    || !Number.isSafeInteger(identity.pid)
    || identity.pid <= 0
    || identity.listener !== "127.0.0.1:18789"
    || identity.rpc !== "ok"
    || identity.health !== "healthy") {
    throw new Error(`Jarvis provenance output failed identity validation for runtimeSource=${selectedRuntimeSource}`);
  }
  return identity;
}

function classifyProvenanceFailure(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const observed = output.match(/runtime_source_observed=(jarvis-managed-bundle|jarvis-break-glass-hotfix|unknown)/)?.[1]
    ?? output.match(/runtime_source=(jarvis-managed-bundle|jarvis-break-glass-hotfix)/)?.[1]
    ?? "unknown";
  const rules = [
    [/marker is not readable|marker is missing/i, "protection-marker-missing", "protected-hotfix marker is missing or unreadable"],
    [/marker commit=/i, "protection-marker-commit-mismatch", "protected-hotfix marker commit does not match the live runtime"],
    [/compatibility commit=/i, "protection-compatibility-commit-mismatch", "protected-hotfix compatibility commit does not match the installed manifest"],
    [/compatibility version=/i, "protection-compatibility-version-mismatch", "protected-hotfix compatibility version does not match the installed manifest"],
    [/backup receipt is missing|backup commit=/i, "protection-backup-mismatch", "protected-hotfix backup receipt is missing or mismatched"],
    [/runtimeCommit=/i, "runtime-commit-mismatch", "live runtime commit does not match the expected commit"],
    [/runtimeSource=/i, "runtime-source-mismatch", "live runtime source does not match the selected canary source"],
    [/TCP port .* not owned|no listener found/i, "listener-owner-mismatch", "gateway listener ownership proof failed"],
    [/PID|pid=/i, "pid-owner-mismatch", "gateway PID ownership proof failed"],
    [/RPC probe is not ok|deep RPC status failed/i, "rpc-unhealthy", "deep RPC health proof failed"],
  ];
  const matched = rules.find(([pattern]) => pattern.test(output));
  const sourceForCommand = observed === "jarvis-managed-bundle" || observed === "jarvis-break-glass-hotfix"
    ? observed
    : selectedRuntimeSource;
  return {
    code: matched?.[1] ?? "runtime-provenance-rejected",
    reason: matched?.[2] ?? "selected Jarvis runtime provenance proof failed",
    observedRuntimeSource: observed,
    expectedRuntimeSource: selectedRuntimeSource,
    nextCommand: `bash scripts/prove-jarvis-telegram-runtime.sh --dry-run --runtime-source ${sourceForCommand} --expected-commit ${expectedCommit}`,
  };
}

function gatewayPid() {
  const result = run(launchctl, ["print", `gui/${process.getuid()}/${label}`]);
  if (result.status !== 0) throw new Error("Jarvis launchd service is unavailable");
  const match = result.stdout.match(/\bpid\s*=\s*(\d+)/);
  if (!match || Number(match[1]) <= 0) throw new Error("Jarvis gateway PID is unavailable");
  return Number(match[1]);
}

function logSnapshot() {
  const stat = fs.statSync(logPath);
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

function acquireLock() {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    // Never guess whether an unreadable/stale owner is safe. A human must clear
    // the fixed machine-wide lock after inspecting it.
    let ownerState = "unreadable";
    try {
      const owner = parseJson(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"), "lock owner");
      ownerState = Number.isSafeInteger(owner?.pid) ? "readable" : "invalid";
    } catch {}
    // Never leak the owner token into logs/evidence; ownership detail is kept
    // deliberately coarse while the lock remains fail-closed.
    throw new Error(`canary lock already exists; fail-closed owner metadata is ${ownerState}`);
  }
  // Directory creation is the atomic ownership event. Mark it immediately so
  // finally cannot mistake an owner-metadata write failure for "not acquired".
  lockHeld = true;
  try {
    const injectedFailure = testMode
      ? process.env.OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_OWNER_WRITE_FAILURE
      : undefined;
    if (injectedFailure === "partial") {
      fs.writeFileSync(path.join(lockPath, "owner.json"), "partial", { mode: 0o600 });
      throw new Error("test owner metadata write failure");
    }
    if (injectedFailure === "empty") {
      throw new Error("test owner metadata write failure");
    }
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
      command: "prove-jarvis-telegram-runtime",
    }), { mode: 0o600 });
  } catch (error) {
    // Remove only the exact empty directory this process just created. Any
    // non-empty partial state stays fail-closed for human inspection.
    try {
      if (fs.readdirSync(lockPath).length === 0) {
        fs.rmdirSync(lockPath);
        lockHeld = false;
      } else {
        residuals.push({ type: "lock", path: lockPath, reason: "owner-write-partial-state" });
      }
    } catch {
      residuals.push({ type: "lock", path: lockPath, reason: "owner-write-cleanup-failed" });
    }
    throw new Error(`canary lock owner metadata write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseLock() {
  if (!lockHeld) return "not-acquired";
  try {
    const owner = parseJson(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"), "lock owner");
    if (owner.token !== token || owner.pid !== process.pid) {
      residuals.push({ type: "lock", path: lockPath, reason: "owner-token-mismatch" });
      return "owner-mismatch";
    }
    fs.unlinkSync(path.join(lockPath, "owner.json"));
    fs.rmdirSync(lockPath);
    lockHeld = false;
    return "released";
  } catch {
    residuals.push({ type: "lock", path: lockPath, reason: "release-failed" });
    return "release-failed";
  }
}

function validateTransport() {
  const before = transportBefore;
  const after = transportAfter;
  const numeric = (value) => Number(value ?? 0);
  if (!Number.isSafeInteger(before.transportGeneration)
    || !Number.isSafeInteger(after.transportGeneration)) {
    throw new Error("Telegram transport generation evidence is missing or invalid");
  }
  if (numeric(after.completedCount) <= numeric(before.completedCount)) {
    throw new Error("Telegram poll completion did not advance");
  }
  for (const key of ["stallCount", "stopTimeoutCount", "restartAttempts"]) {
    if (numeric(after[key]) !== numeric(before[key])) {
      throw new Error(`Telegram ${key} changed during proof`);
    }
  }
  for (const key of ["lastPollCompletedAt", "lastInboundAt", "lastOutboundAt"]) {
    const raw = after[key];
    const timestamp = typeof raw === "number" ? raw : Date.parse(raw ?? "");
    if (!Number.isFinite(timestamp) || timestamp < startedAt) {
      throw new Error(`Telegram ${key} did not cover the proof window`);
    }
  }
  for (const [phase, watchdog] of [["before", before.watchdog], ["after", after.watchdog]]) {
    if (!watchdog || typeof watchdog !== "object" || !Object.hasOwn(watchdog, "escalation")) {
      throw new Error(`Telegram ${phase} watchdog evidence is missing`);
    }
    if (watchdog.escalation !== null) {
      throw new Error(`Telegram ${phase} watchdog escalated during proof`);
    }
  }
  if (after.transportGeneration !== before.transportGeneration) {
    throw new Error("Telegram transport generation changed during proof");
  }
}

function sessionList() {
  const suffix = `:telegram:group:${labChat}:topic:${topicAnchor}`;
  const response = jarvis([
    "gateway", "call", "sessions.list", "--params", JSON.stringify({ search: suffix }), "--json",
  ], "sessions-list");
  const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
  return sessions.filter((session) => typeof session?.key === "string" && session.key.endsWith(suffix));
}

async function cleanupTopicAndSession() {
  if (!topicAnchor) return;
  try {
    const deleted = jarvis([
      "telegram-user", "topic-delete", "--chat", labChat, "--topic-anchor", String(topicAnchor), "--json",
    ], "topic-delete");
    topicDeleted = deleted?.deleted === true
      && String(field(deleted, ["chat_id", "chatId"])) === labChat
      && Number(field(deleted, ["topic_anchor", "topicAnchor", "message_id", "messageId"])) === topicAnchor;
    if (!topicDeleted) throw new Error("topic-delete response did not match the exact topic");
  } catch (error) {
    failureReason ||= error.message;
    residuals.push({ type: "telegram-topic", chatId: labChat, topicAnchor, reason: "delete-unconfirmed" });
    return;
  }

  try {
    const read = jarvis([
      "telegram-user", "read", "--chat", labChat, "--after-id", String(topicAnchor),
      "--contains", nonce, "--limit", "20", "--json",
    ], "topic-marker-absence");
    const messages = Array.isArray(read?.messages) ? read.messages : Array.isArray(read) ? read : [];
    markerAbsent = messages.length === 0;
    if (!markerAbsent) {
      residuals.push({ type: "telegram-marker", chatId: labChat, topicAnchor, reason: "still-visible" });
    }
  } catch {
    residuals.push({ type: "telegram-marker", chatId: labChat, topicAnchor, reason: "absence-unverified" });
  }

  try {
    const matches = sessionList();
    const canonical = new RegExp(`^agent:[a-z0-9_-]+:telegram:group:${labChat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:topic:${topicAnchor}$`);
    if (matches.length !== 1 || !canonical.test(matches[0].key)) {
      residuals.push({
        type: "session",
        suffix: `:telegram:group:${labChat}:topic:${topicAnchor}`,
        reason: matches.length === 0 ? "zero-canonical-matches" : "multiple-or-bound-shared-matches",
        count: matches.length,
      });
      return;
    }
    canonicalSessionKey = matches[0].key;
    const deleted = jarvis([
      "gateway", "call", "sessions.delete", "--params",
      JSON.stringify({ key: canonicalSessionKey, deleteTranscript: true, emitLifecycleHooks: false }),
      "--json",
    ], "sessions-delete");
    if (deleted?.deleted !== true || deleted?.key !== canonicalSessionKey) {
      throw new Error("sessions.delete did not confirm the exact canonical key");
    }
    sessionDeleted = true;
    archives = Array.isArray(deleted.archived) ? deleted.archived : [];
    if (archives.length === 0) {
      // The API removed the active entry but transcript archival is
      // best-effort. Absence of an archive path is unknown cleanup, not proof
      // that no transcript artifact remains.
      residuals.push({
        type: "session-transcript",
        key: canonicalSessionKey,
        reason: "archive-path-not-reported",
      });
    }
    for (const archive of archives) {
      residuals.push({ type: "archived-session-transcript", path: String(archive), reason: "archived-not-erased" });
    }
    sessionAbsent = sessionList().length === 0;
    if (!sessionAbsent) {
      residuals.push({ type: "session", key: canonicalSessionKey, reason: "still-listed-after-delete" });
    }
  } catch (error) {
    failureReason ||= error.message;
    residuals.push({ type: "session", key: canonicalSessionKey || null, reason: "cleanup-unconfirmed" });
  }
}

let lockRelease = "not-acquired";
try {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-telegram-proof-"));
  actions.push("provenance-gate");
  const provenance = run("bash", [
    gate,
    "--runtime-source", selectedRuntimeSource,
    "--expected-commit", expectedCommit,
  ], {
    env: managedChildEnv(),
  });
  if (provenance.status !== 0) {
    provenanceFailure = classifyProvenanceFailure(provenance);
    throw new Error(`${provenanceFailure.reason}; observed runtimeSource=${provenanceFailure.observedRuntimeSource}, expected runtimeSource=${selectedRuntimeSource}; next command: ${provenanceFailure.nextCommand}`);
  }
  try {
    provenanceIdentity = parseProvenance(provenance.stdout);
  } catch (error) {
    provenanceFailure = classifyProvenanceFailure({
      stdout: provenance.stdout,
      stderr: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`${provenanceFailure.reason}; observed runtimeSource=${provenanceFailure.observedRuntimeSource}, expected runtimeSource=${selectedRuntimeSource}; next command: ${provenanceFailure.nextCommand}`);
  }

  acquireLock();
  actions.push("lock-acquired");
  pidBefore = gatewayPid();
  if (pidBefore !== provenanceIdentity.pid) {
    throw new Error("launchd PID does not match the provenance-gated Jarvis PID");
  }
  const logBefore = logSnapshot();
  const beforePayload = jarvis(["channels", "status", "--probe", "--json"], "channels-status-before");
  transportBefore = validateStatus(beforePayload, true);

  const precheck = jarvis([
    "telegram-user", "precheck", "--chat", labChat, "--json",
  ], "operator-precheck");
  operatorBackend = {
    envFile: precheck.backend_meta.env_file,
    envFileSource: precheck.backend_meta.env_file_source,
    sessionPath: precheck.backend_meta.session_path,
    sessionSource: precheck.backend_meta.session_source,
    lockScope: precheck.backend_meta.lock_scope,
    backend: precheck.backend_meta.backend ?? null,
  };

  topicCreationAttempted = true;
  let created;
  try {
    created = jarvis([
      "telegram-user", "topic-create", "--chat", labChat, "--title", title, "--json",
    ], "topic-create");
  } catch (error) {
    topicCreationUncertain = true;
    residuals.push({
      type: "telegram-topic",
      chatId: labChat,
      topicAnchor: null,
      messageId: null,
      reason: "create-outcome-unknown-refused-deletion",
    });
    throw error;
  }
  const createdChat = String(field(created, ["chat_id", "chatId"]));
  const createdTitle = String(field(created, ["topic_title", "topicTitle", "title"]));
  const returnedAnchor = Number(field(created, ["topic_anchor", "topicAnchor"]));
  const returnedMessageId = Number(field(created, ["message_id", "messageId"]));
  if (createdChat !== labChat) {
    topicAnchor = 0;
    topicCreationUncertain = true;
    uncertainTopicIds = { chatId: createdChat, topicAnchor: returnedAnchor, messageId: returnedMessageId };
    residuals.push({
      type: "telegram-topic",
      ...uncertainTopicIds,
      reason: "wrong-chat-create-refused-deletion",
    });
    throw new Error("topic-create returned a mismatched chat");
  }
  if (!Number.isSafeInteger(returnedAnchor) || returnedAnchor <= 0 || returnedAnchor !== returnedMessageId) {
    topicAnchor = 0;
    topicCreationUncertain = true;
    uncertainTopicIds = { chatId: createdChat, topicAnchor: returnedAnchor, messageId: returnedMessageId };
    residuals.push({
      type: "telegram-topic",
      ...uncertainTopicIds,
      reason: "invalid-or-mismatched-create-identifiers-refused-deletion",
    });
    throw new Error("topic-create did not return equal positive topic_anchor and message_id");
  }
  // Once the chat and anchor are trustworthy, retain them even when later
  // validation fails so the exact topic is still removed in finally.
  topicAnchor = returnedAnchor;
  if (createdTitle !== title) {
    throw new Error("topic-create returned a mismatched title");
  }

  const sent = jarvis([
    "telegram-user", "send", "--chat", labChat, "--message", prompt,
    "--reply-to", String(topicAnchor), "--json",
  ], "anchor-send");
  const sentMessage = sent?.result?.message ?? sent?.message ?? sent;
  sentMessageId = Number(field(sentMessage, ["message_id", "messageId"]));
  sentSenderId = Number(field(sentMessage, ["sender_id", "senderId"]));
  if (!Number.isSafeInteger(sentMessageId)
    || sentMessageId <= topicAnchor
    || !Number.isSafeInteger(sentSenderId)
    || sentSenderId <= 0) {
    throw new Error("anchor send did not return a positive message and sender id");
  }

  const waited = jarvis([
    "telegram-user", "wait", "--chat", labChat, "--after-id", String(sentMessageId),
    "--sender-id", String(botIdentity.id), "--thread-anchor", String(topicAnchor),
    "--contains", nonce, "--timeout-ms", "90000", "--json",
  ], "bounded-reply-wait");
  const matched = waited?.matched ?? waited?.message ?? waited;
  replyMessageId = Number(field(matched, ["message_id", "messageId"]));
  replySenderId = Number(field(matched, ["sender_id", "senderId"]));
  replyThreadAnchor = Number(field(
    matched,
    ["thread_anchor", "threadAnchor", "reply_to_top_id", "replyToTopId"],
  ));
  if (!Number.isSafeInteger(replyMessageId)
    || replyMessageId <= sentMessageId
    || replySenderId !== Number(botIdentity.id)
    || replyThreadAnchor !== topicAnchor
    || String(field(matched, ["text", "message"]) ?? "").trim() !== nonce) {
    throw new Error("wait result did not exactly match message ordering, bot, thread anchor, and nonce");
  }

  const read = jarvis([
    "telegram-user", "read", "--chat", labChat, "--after-id", String(topicAnchor),
    "--contains", nonce, "--limit", "20", "--json",
  ], "bounded-evidence-read");
  const readMessages = Array.isArray(read?.messages) ? read.messages : Array.isArray(read) ? read : [];
  if (readMessages.length === 0 || readMessages.length > 20) {
    throw new Error("bounded evidence read did not contain the nonce");
  }

  pidAfter = gatewayPid();
  if (pidAfter !== pidBefore) throw new Error("Jarvis gateway PID changed during proof");
  const afterPayload = jarvis(["channels", "status", "--json"], "channels-status-after");
  transportAfter = validateStatus(afterPayload, false);
  validateTransport();

  const logAfter = logSnapshot();
  if (logAfter.dev !== logBefore.dev || logAfter.ino !== logBefore.ino || logAfter.size < logBefore.size) {
    throw new Error("Jarvis gateway log rotated or truncated during proof");
  }
  appendedLogBytes = logAfter.size - logBefore.size;
  const fd = fs.openSync(logPath, "r");
  const appended = Buffer.alloc(appendedLogBytes);
  fs.readSync(fd, appended, 0, appended.length, logBefore.size);
  fs.closeSync(fd);
  const appendedText = appended.toString("utf8");
  const forbidden = [
    /polling stalled/i, /watchdog.*restart/i, /conflict.*getupdates/i,
    /unauthorized/i, /forbidden/i, /transport closed/i,
  ];
  if (forbidden.some((pattern) => pattern.test(appendedText))) {
    appendedLogScan = "forbidden-marker";
    throw new Error("appended Jarvis log bytes contain a transport failure marker");
  }
  appendedLogScan = "clean";
  proofPassed = true;
} catch (error) {
  failureReason = error instanceof Error ? error.message : String(error);
} finally {
  await cleanupTopicAndSession();
  lockRelease = releaseLock();
  if (workspace) {
    try { fs.rmSync(workspace, { recursive: true }); } catch {
      residuals.push({ type: "temporary-workspace", path: workspace, reason: "cleanup-failed" });
    }
  }
}

const cleanupComplete = !topicCreationUncertain
  && (!topicAnchor || (topicDeleted && markerAbsent && sessionDeleted && sessionAbsent))
  && lockRelease !== "owner-mismatch"
  && lockRelease !== "release-failed";
const result = proofPassed && cleanupComplete ? "passed" : cleanupComplete ? "failed" : "cleanup-incomplete";
const finishedAt = Date.now();
const evidence = {
  schema: "openclaw.jarvis-telegram-runtime-proof.v2",
  result,
  reason: failureReason || null,
  expectedCommit,
  runtimeSource: {
    selected: selectedRuntimeSource,
    observed: provenanceIdentity?.runtimeSource ?? provenanceFailure?.observedRuntimeSource ?? null,
    autoFallback: false,
  },
  guidance: provenanceFailure ?? null,
  target: { selector: "OPENCLAW_JARVIS_LAB_CHAT_ID", chatId: labChat },
  timing: {
    startedAt: new Date(startedAt).toISOString(),
    startedAtMs: startedAt,
    finishedAt: new Date(finishedAt).toISOString(),
    finishedAtMs: finishedAt,
  },
  operatorSession: {
    source: operatorBackend?.sessionSource ?? null,
    path: operatorBackend?.sessionPath ?? null,
    lockScope: operatorBackend?.lockScope ?? null,
    verifiedBackend: operatorBackend ?? null,
  },
  generated: { runId, title, nonce, prompt },
  runtime: {
    serviceLabel: label,
    node: process.execPath,
    entrypoint,
    stateDir,
    pidBefore: pidBefore || null,
    pidAfter: pidAfter || null,
    provenance: provenanceIdentity ?? null,
  },
  telegram: {
    botIdentity: botIdentity ?? null,
    topicAnchor: topicAnchor || null,
    topicCreationAttempted,
    topicCreationUncertain,
    uncertainTopicIds: uncertainTopicIds ?? null,
    sentMessageId: sentMessageId || null,
    sentSenderId: sentSenderId || null,
    replyMessageId: replyMessageId || null,
    replySenderId: replySenderId || null,
    replyThreadAnchor: replyThreadAnchor || null,
    topicDeleted,
    markerAbsent,
    transportBefore: transportBefore ?? null,
    transportAfter: transportAfter ?? null,
  },
  log: { path: logPath, appendedBytes: appendedLogBytes, appendedScan: appendedLogScan },
  cleanup: {
    topic: topicCreationUncertain
      ? "creation-uncertain-delete-refused"
      : !topicAnchor
        ? "not-created"
        : topicDeleted
          ? "deleted"
          : "unconfirmed",
    marker: topicCreationUncertain
      ? "unknown"
      : !topicAnchor
        ? "not-created"
        : markerAbsent
          ? "absent"
          : "unconfirmed",
    sessionKey: canonicalSessionKey || null,
    session: sessionAbsent ? "absent" : sessionDeleted ? "delete-unverified" : "not-deleted",
    lock: lockRelease,
    archivesRemain: archives,
  },
  residuals,
  actions,
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
process.exitCode = result === "passed" ? 0 : 1;
NODE
