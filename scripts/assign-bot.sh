#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"
SCENARIO_RESERVATION_MODULE="${SCRIPT_DIR}/lib/telegram-tester-scenario-reservations.mjs"
# Reserved-token detection must look at the canonical shared runtime config,
# not the sanitized per-worktree baseline. Otherwise isolated tester lanes can
# stop seeing production/shared bot reservations and accidentally claim them.
RESERVED_CONFIG_PATH="${OPENCLAW_TELEGRAM_RESERVED_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

if [[ ! -r ".env.bots" ]]; then
  echo "Error: .env.bots not found or not readable in $(pwd)." >&2
  echo "Create it from .env.bots.example and add BOT_TOKEN entries." >&2
  exit 1
fi

bot_tokens=()
line=""
trimmed=""
parsed=""
while IFS= read -r line || [[ -n "$line" ]]; do
  trimmed="$(trim "$line")"
  if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
    continue
  fi
  parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
  if [[ -n "$parsed" ]]; then
    bot_tokens+=("$parsed")
  fi
done < ".env.bots"

if (( ${#bot_tokens[@]} == 0 )); then
  echo "Error: no valid BOT_TOKEN entries found in .env.bots." >&2
  exit 1
fi

# Assignment must be one transaction per worktree, not merely one transaction
# per bot token. Otherwise concurrent fresh invocations can generate different
# scenarios, reserve different bots under their independent token locks, and
# leave all but the last local assignment unreachable until expiry.
ASSIGNMENT_LOCK_DIR="$(pwd -P)/.openclaw-telegram-tester-assignment.lock"
ASSIGNMENT_LOCK_OWNED="no"

release_assignment_lock() {
  if [[ "$ASSIGNMENT_LOCK_OWNED" != "yes" ]]; then
    return
  fi
  # Only this process can own the directory while it exists. A contender waits
  # for removal and never auto-deletes it, so cleanup cannot erase a successor.
  rm -rf "$ASSIGNMENT_LOCK_DIR"
  ASSIGNMENT_LOCK_OWNED="no"
}

acquire_assignment_lock() {
  local deadline=$((SECONDS + 30))
  local owner_pid=""

  while ! mkdir "$ASSIGNMENT_LOCK_DIR" 2>/dev/null; do
    owner_pid=""
    if [[ -r "${ASSIGNMENT_LOCK_DIR}/owner.pid" ]]; then
      IFS= read -r owner_pid < "${ASSIGNMENT_LOCK_DIR}/owner.pid" || true
    fi
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
      # A crash-persistent lock is unknown ownership. Never unlink it from a
      # waiter: a pathname check/delete race could remove a newly created lock.
      echo "Error: stale tester-bot assignment lock requires manual recovery: ${ASSIGNMENT_LOCK_DIR}" >&2
      echo "Recorded owner PID is not running: ${owner_pid}" >&2
      exit 1
    fi
    if (( SECONDS >= deadline )); then
      echo "Error: timed out waiting for tester-bot assignment lock: ${ASSIGNMENT_LOCK_DIR}" >&2
      echo "Inspect owner.json and confirm the owner is gone before manual recovery." >&2
      exit 1
    fi
    sleep 0.05
  done

  ASSIGNMENT_LOCK_OWNED="yes"
  printf '%s\n' "$$" > "${ASSIGNMENT_LOCK_DIR}/owner.pid"
  printf '{"version":1,"pid":%s,"createdAt":"%s"}\n' \
    "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${ASSIGNMENT_LOCK_DIR}/owner.json"
}

trap release_assignment_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
acquire_assignment_lock

selection="$(
  HELPER_MODULE="$HELPER_MODULE" \
  SCENARIO_RESERVATION_MODULE="$SCENARIO_RESERVATION_MODULE" \
  BASE_CONFIG_PATH="$RESERVED_CONFIG_PATH" \
  CURRENT_WORKTREE="$(pwd -P)" \
  REQUESTED_SCENARIO_ID="${OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID:-}" \
  RESERVATION_ROOT="${OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT:-}" \
  RESERVATION_TTL_MS="${OPENCLAW_TELEGRAM_TESTER_RESERVATION_TTL_MS:-}" \
  node --input-type=module - <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const reservationModulePath = process.env.SCENARIO_RESERVATION_MODULE;
const baseConfigPath = process.env.BASE_CONFIG_PATH ?? "";
const currentWorktree = process.env.CURRENT_WORKTREE ?? "";

if (!helperPath || !reservationModulePath) {
  throw new Error("Missing tester-bot helper module path.");
}

const {
  classifyTelegramTesterClaimEntries,
  collectActiveReservedTelegramBotTokensFromCanonicalConfig,
  collectActiveTelegramTokenLeaseEntries,
  summarizeTelegramTesterTokenPool,
} = await import(pathToFileURL(helperPath).href);
const {
  acquireTelegramTesterScenarioReservation,
  findTelegramTesterScenarioReservation,
  resolveTelegramTesterScenarioReservationPath,
} = await import(pathToFileURL(reservationModulePath).href);

const envBotsPath = path.join(currentWorktree, ".env.bots");
const envLocalPath = path.join(currentWorktree, ".env.local");
const envBotsText = fs.readFileSync(envBotsPath, "utf8");
const poolTokens = [];
for (const line of envBotsText.split(/\r?\n/g)) {
  const match = line.match(/^[\t ]*(?:export[\t ]+)?BOT_TOKEN[\t ]*=[\t ]*(.*)$/);
  if (!match) {
    continue;
  }
  let value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (value) {
    poolTokens.push(value);
  }
}

const readLastEnvValue = (filePath, key) => {
  const text = fs.readFileSync(filePath, "utf8");
  let token = "";
  for (const line of text.split(/\r?\n/g)) {
    const match = line.match(
      new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[\\t ]*(.*)$`),
    );
    if (!match) {
      continue;
    }
    let value = match[1].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    token = value;
  }
  return token;
};

const currentToken = fs.existsSync(envLocalPath)
  ? readLastEnvValue(envLocalPath, "TELEGRAM_BOT_TOKEN")
  : "";
const storedScenarioId = fs.existsSync(envLocalPath)
  ? readLastEnvValue(envLocalPath, "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID")
  : "";
const storedReservationGeneration = fs.existsSync(envLocalPath)
  ? readLastEnvValue(envLocalPath, "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION")
  : "";
const storedReservationTokenHash = fs.existsSync(envLocalPath)
  ? readLastEnvValue(envLocalPath, "OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH")
  : "";
const requestedScenarioId = String(process.env.REQUESTED_SCENARIO_ID ?? "").trim();
// A path-derived default can resurrect an old scenario when a deleted
// worktree is later recreated at the same location. Generate a fresh run
// incarnation once, then persist it in .env.local for process restarts.
const defaultScenarioId = `tg-scenario-${crypto.randomUUID()}`;
const scenarioId = requestedScenarioId || storedScenarioId || defaultScenarioId;

if (storedScenarioId && requestedScenarioId && storedScenarioId !== requestedScenarioId) {
  let scenarioChangeReason = currentToken ? "scenario_change_requires_release" : "";
  if (!scenarioChangeReason) {
    const storedScenarioReservation = await findTelegramTesterScenarioReservation({
      scenarioId: storedScenarioId,
      worktreePath: currentWorktree,
      reservationRoot: process.env.RESERVATION_ROOT,
    });
    if (!storedScenarioReservation.ok || storedScenarioReservation.reservation) {
      // A scenario-only env file is the recovery credential for an assignment
      // interrupted after its global reservation write. Replacing it before
      // discovery would orphan that bot and let the override claim another.
      scenarioChangeReason = "scenario_change_requires_recovery";
    }
  }
  if (scenarioChangeReason) {
    console.log("ok=no");
    console.log(`reason=${scenarioChangeReason}`);
    console.log(`scenarioId=${storedScenarioId}`);
    process.exit(0);
  }
}

// Persist a freshly generated run identity before acquiring any global bot
// reservation. If this process dies after the global write, the next invocation
// can recover the same scenario instead of losing its only ownership credential
// and leaving the bot stranded until the reservation expires.
const persistScenarioIntent = () => {
  const intentPath = `${envLocalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const existingContent = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, "utf8") : "";
  const keptLines = existingContent.split(/\r?\n/gu).filter(
    (line) =>
      !/^[\t ]*(?:export[\t ]+)?OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID[\t ]*=/u.test(line),
  );
  while (keptLines.length > 0 && keptLines.at(-1) === "") {
    keptLines.pop();
  }
  fs.writeFileSync(
    intentPath,
    `${[...keptLines, `OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID=${scenarioId}`].join("\n")}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
  fs.renameSync(intentPath, envLocalPath);
  fs.chmodSync(envLocalPath, 0o600);
};
if (!currentToken && storedScenarioId !== scenarioId) {
  persistScenarioIntent();
}

const claimedEntries = [];
const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
  cwd: currentWorktree,
  encoding: "utf8",
});
for (const line of worktreeList.split(/\r?\n/g)) {
  if (!line.startsWith("worktree ")) {
    continue;
  }
  const worktreePath = line.slice("worktree ".length).trim();
  if (!worktreePath || path.resolve(worktreePath) === path.resolve(currentWorktree)) {
    continue;
  }
  const candidateEnvLocalPath = path.join(worktreePath, ".env.local");
  if (!fs.existsSync(candidateEnvLocalPath)) {
    continue;
  }
  const claimed = readLastEnvValue(candidateEnvLocalPath, "TELEGRAM_BOT_TOKEN");
  if (claimed) {
    claimedEntries.push({
      token: claimed,
      worktreePath,
    });
  }
}

const reservedTokens = collectActiveReservedTelegramBotTokensFromCanonicalConfig({
  baseConfigPath,
});

const leasedEntries = collectActiveTelegramTokenLeaseEntries({
  tokens: poolTokens,
  currentWorktreePath: currentWorktree,
});

const classifiedClaims = classifyTelegramTesterClaimEntries({
  claimedEntries,
});
const summary = summarizeTelegramTesterTokenPool({
  poolTokens,
  activeClaimEntries: classifiedClaims.activeClaimEntries,
  staleClaimEntries: classifiedClaims.staleClaimEntries,
  leasedEntries,
  reservedTokens,
  currentToken,
});
const activeClaimTokens = new Set(summary.claimedTokens);
const reservedTokenSet = new Set(summary.reservedTokens);
const priorScenarioReservation = await findTelegramTesterScenarioReservation({
  scenarioId,
  worktreePath: currentWorktree,
  reservationRoot: process.env.RESERVATION_ROOT,
});
let priorScenarioToken = "";
let priorScenarioReason = "";
if (!priorScenarioReservation.ok) {
  priorScenarioReason = priorScenarioReservation.reason;
} else if (priorScenarioReservation.reservation) {
  priorScenarioToken =
    poolTokens.find(
      (token) =>
        crypto.createHash("sha256").update(token).digest("hex") ===
        priorScenarioReservation.reservation.tokenHash,
    ) ?? "";
  if (!priorScenarioToken) {
    priorScenarioReason = "scenario_reservation_token_not_in_pool";
  } else if (
    path.resolve(priorScenarioReservation.reservation.reservationPath) !==
    path.resolve(
      resolveTelegramTesterScenarioReservationPath({
        token: priorScenarioToken,
        reservationRoot: process.env.RESERVATION_ROOT,
      }),
    )
  ) {
    // Token hash lookup identifies the actual pool credential, which is the
    // only authoritative source for its Bot API ID. Bind the discovered file
    // to that credential so a self-consistent forged botId + filename cannot
    // make acquire write a second canonical reservation.
    priorScenarioReason = "reservation_identity_mismatch_manual_recovery_required";
  } else if (currentToken && currentToken !== priorScenarioToken) {
    // A local token claim and a different durable scenario reservation are two
    // competing owners. Rotating either side would destroy evidence needed for
    // explicit recovery, so stop without touching global or local state.
    priorScenarioReason = "scenario_reservation_token_mismatch";
  }
}
// An interrupted assignment has already chosen the scenario's token globally.
// Pin recovery to that token even if an earlier pool entry becomes eligible;
// otherwise retry can create a second unreachable reservation for one owner.
const candidates = priorScenarioReason
  ? []
  : priorScenarioToken
    ? [priorScenarioToken]
    : [...new Set([currentToken, ...poolTokens].filter(Boolean))];
const parsedTtlMs = Number.parseInt(String(process.env.RESERVATION_TTL_MS ?? ""), 10);
let selection = null;
let lastReservationReason = priorScenarioReason;

// Token selection and durable reservation happen under the reservation
// module's per-token lock. Keeping those operations together closes the race
// where two simultaneous assigners both observe an unclaimed pool entry.
for (const candidate of candidates) {
  const isLegacyCurrentToken =
    candidate === currentToken &&
    !storedReservationGeneration &&
    !storedReservationTokenHash;
  const isCurrentReservationCandidate =
    candidate === currentToken &&
    Boolean(storedReservationGeneration) &&
    Boolean(storedReservationTokenHash);
  if (isLegacyCurrentToken) {
    // Metadata-free claims predate durable scenario ownership. Neither a local
    // env file nor a live PID lease can exclude copied/expired competing state,
    // so migration is deliberately explicit: serialized release first, then a
    // fresh ensure that creates one fenced generation.
    lastReservationReason = activeClaimTokens.has(candidate)
      ? "legacy_current_token_claim_conflict_release_required"
      : "legacy_current_token_release_required";
    break;
  }
  if (
    !poolTokens.includes(candidate) ||
    // A copied .env.local is not modern reservation ownership. Let the exact
    // credentialed owner reach the locked PID lease check below; other claims
    // remain unavailable.
    (activeClaimTokens.has(candidate) && !isCurrentReservationCandidate) ||
    reservedTokenSet.has(candidate)
  ) {
    if (priorScenarioToken) {
      lastReservationReason = "scenario_reservation_token_unavailable";
    }
    continue;
  }
  const reservation = await acquireTelegramTesterScenarioReservation({
    token: candidate,
    scenarioId,
    worktreePath: currentWorktree,
    reservationRoot: process.env.RESERVATION_ROOT,
    ttlMs: Number.isFinite(parsedTtlMs) && parsedTtlMs > 0 ? parsedTtlMs : undefined,
    expectedGeneration: candidate === currentToken ? storedReservationGeneration : undefined,
    expectedTokenHash: candidate === currentToken ? storedReservationTokenHash : undefined,
    requireExpectedOwner: candidate === currentToken,
    // The initial pool summary is diagnostic only. Re-read the per-token PID
    // lease inside the reservation lock so a just-started runtime wins the
    // race and assignment cannot reserve underneath it.
    hasActivePollingLease: () =>
      collectActiveTelegramTokenLeaseEntries({
        tokens: [candidate],
      }),
  });
  if (!reservation.ok) {
    lastReservationReason = reservation.reason;
    if (candidate === currentToken) {
      // A persisted current token is ownership state, even when its generation
      // metadata is partial or stale. Any retain failure must stop instead of
      // rotating to another bot, leaking a reservation, or silently adopting
      // ownership that this worktree cannot prove.
      break;
    }
    continue;
  }
  selection = {
    ok: true,
    action: candidate === currentToken ? "retain" : "assign",
    reason: reservation.reason,
    selectedToken: candidate,
    scenarioId,
    reservationGeneration: reservation.generation,
    safeReuseRequired: reservation.safeReuseRequired,
    safeReuseEnabled: reservation.safeReuseEnabled,
  };
  break;
}

if (!selection?.ok || !selection.selectedToken) {
  console.log("ok=no");
  console.log(`reason=${lastReservationReason || summary.selection.reason}`);
  console.log(`scenarioId=${scenarioId}`);
  console.log(`currentTokenStatus=${summary.currentTokenStatus}`);
  console.log(`claimedCount=${summary.claimedCount}`);
  console.log(`poolCount=${summary.poolCount}`);
  console.log(`reservedCount=${summary.reservedCount}`);
  console.log(`claimableCount=${summary.claimableCount}`);
  for (const entry of summary.claimedEntries) {
    console.log(`claimedWorktree=${entry.worktreePath}`);
  }
  for (const entry of classifiedClaims.staleClaimEntries) {
    console.log(`staleClaimToken=${entry.token}`);
    console.log(`staleClaimWorktree=${entry.worktreePath}`);
    console.log(`staleClaimReason=${entry.reason ?? "unknown"}`);
    console.log(`staleClaimRuntimePort=${entry.runtimePort ?? 0}`);
  }
  process.exit(0);
}

// Deterministic fault injection for the otherwise microscopic crash window
// between the global reservation write and the final local assignment write.
// Production callers never set this; the regression test proves recovery from
// the same scenario identity persisted above.
if (process.env.OPENCLAW_TELEGRAM_TESTER_ASSIGN_ABORT_AFTER_RESERVATION === "1") {
  process.exit(86);
}

const selectedIndex = poolTokens.findIndex((token) => token === selection.selectedToken);
console.log("ok=yes");
console.log(`action=${selection.action}`);
console.log(`reason=${selection.reason}`);
console.log(`selectedToken=${selection.selectedToken}`);
console.log(`selectedIndex=${selectedIndex >= 0 ? selectedIndex + 1 : 0}`);
console.log(`scenarioId=${selection.scenarioId}`);
console.log(`reservationGeneration=${selection.reservationGeneration}`);
console.log(
  `reservationTokenHash=${crypto.createHash("sha256").update(selection.selectedToken).digest("hex")}`,
);
console.log(`safeReuseRequired=${selection.safeReuseRequired ? "yes" : "no"}`);
console.log(`safeReuseEnabled=${selection.safeReuseEnabled ? "yes" : "no"}`);
console.log(`claimedCount=${summary.claimedCount}`);
console.log(`poolCount=${summary.poolCount}`);
console.log(`reservedCount=${summary.reservedCount}`);
console.log(`claimableCount=${summary.claimableCount}`);
for (const entry of classifiedClaims.staleClaimEntries) {
  console.log(`staleClaimToken=${entry.token}`);
  console.log(`staleClaimWorktree=${entry.worktreePath}`);
  console.log(`staleClaimReason=${entry.reason ?? "unknown"}`);
  console.log(`staleClaimRuntimePort=${entry.runtimePort ?? 0}`);
}
NODE
)"

selected_token=""
selected_index=0
selection_ok="no"
selection_action=""
selection_reason=""
claimed_count=0
pool_count=${#bot_tokens[@]}
reserved_count=0
claimable_count=0
current_token_status="absent"
scenario_id=""
reservation_generation=""
reservation_token_hash=""
safe_reuse_required="no"
safe_reuse_enabled="no"
claimed_worktrees=()
stale_claim_tokens=()
stale_claim_worktrees=()
stale_claim_reasons=()
stale_claim_runtime_ports=()
while IFS= read -r line || [[ -n "$line" ]]; do
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    ok) selection_ok="$value" ;;
    action) selection_action="$value" ;;
    reason) selection_reason="$value" ;;
    selectedToken) selected_token="$value" ;;
    selectedIndex) selected_index="$value" ;;
    claimedCount) claimed_count="$value" ;;
    poolCount) pool_count="$value" ;;
    reservedCount) reserved_count="$value" ;;
    claimableCount) claimable_count="$value" ;;
    currentTokenStatus) current_token_status="$value" ;;
    scenarioId) scenario_id="$value" ;;
    reservationGeneration) reservation_generation="$value" ;;
    reservationTokenHash) reservation_token_hash="$value" ;;
    safeReuseRequired) safe_reuse_required="$value" ;;
    safeReuseEnabled) safe_reuse_enabled="$value" ;;
    claimedWorktree) claimed_worktrees+=("$value") ;;
    staleClaimToken) stale_claim_tokens+=("$value") ;;
    staleClaimWorktree) stale_claim_worktrees+=("$value") ;;
    staleClaimReason) stale_claim_reasons+=("$value") ;;
    staleClaimRuntimePort) stale_claim_runtime_ports+=("$value") ;;
  esac
done <<< "$selection"

if [[ "$selection_ok" != "yes" || -z "$selected_token" || -z "$scenario_id" || -z "$reservation_generation" || ! "$reservation_token_hash" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Error: no eligible tester bot tokens available." >&2
  echo "Reason: ${selection_reason:-unknown}" >&2
  echo "Claimed: ${claimed_count} / Pool: ${pool_count} / Reserved by main runtime: ${reserved_count}" >&2
  echo "Claimable now: ${claimable_count}" >&2
  if [[ "${current_token_status}" != "absent" ]]; then
    echo "Current token status: ${current_token_status}" >&2
  fi
  if (( ${#claimed_worktrees[@]} > 0 )); then
    echo "Claimed worktrees:" >&2
    for claimed_worktree in "${claimed_worktrees[@]}"; do
      echo "  - ${claimed_worktree}" >&2
    done
  fi
  if [[ "${selection_reason:-}" == legacy_current_token_*_release_required ||
    "${selection_reason:-}" == "legacy_current_token_release_required" ||
    "${selection_reason:-}" == "expired_owner_release_required" ]]; then
    echo "Existing tester ownership requires an explicit reset." >&2
    echo "Run 'bash scripts/telegram-live-runtime.sh release', then rerun ensure." >&2
  elif [[ "${selection_reason:-}" == "scenario_change_requires_recovery" ]]; then
    echo "The stored scenario may own an interrupted tester reservation." >&2
    echo "Rerun ensure without a scenario override to recover it, then release before changing scenarios." >&2
  else
    echo "Release an unused worktree with 'bash scripts/telegram-live-runtime.sh release' or add more tester-only bot tokens." >&2
  fi
  exit 1
fi

clear_env_assignment_file() {
  local file_path="$1"
  local key="$2"
  local tmp_file=""
  tmp_file="$(mktemp "${file_path}.tmp.XXXXXX")"
  # Rewrite the file instead of in-place regex surgery so reclaim stays
  # predictable even when the stale worktree has odd quoting or export syntax.
  KEY_TO_CLEAR="$key" SOURCE_FILE="$file_path" TARGET_FILE="$tmp_file" python3 - <<'PY'
import os
import re

key = os.environ["KEY_TO_CLEAR"]
source_file = os.environ["SOURCE_FILE"]
target_file = os.environ["TARGET_FILE"]
pattern = re.compile(rf"^[ \t]*(?:export[ \t]+)?{re.escape(key)}[ \t]*=")

with open(source_file, "r", encoding="utf-8") as src:
    lines = src.readlines()

with open(target_file, "w", encoding="utf-8") as dst:
    for line in lines:
        if pattern.match(line):
            continue
        dst.write(line)
PY
  mv "$tmp_file" "$file_path"
}

for idx in "${!stale_claim_tokens[@]}"; do
  if [[ "${stale_claim_tokens[$idx]}" != "$selected_token" ]]; then
    continue
  fi
  stale_worktree="${stale_claim_worktrees[$idx]}"
  stale_reason="${stale_claim_reasons[$idx]:-unknown}"
  stale_runtime_port="${stale_claim_runtime_ports[$idx]:-0}"
  stale_env_local="${stale_worktree}/.env.local"
  if [[ -f "$stale_env_local" ]]; then
    clear_env_assignment_file "$stale_env_local" "TELEGRAM_BOT_TOKEN"
  fi
  echo "Reclaimed stale tester bot claim from worktree: ${stale_worktree}" >&2
  echo "Reclaim reason: ${stale_reason}" >&2
  echo "Reclaim runtime port: ${stale_runtime_port}" >&2
done

# Publish the complete assignment atomically while retaining unrelated local
# settings. Managed keys are replaced as one set so a crash cannot expose a
# token paired with stale generation or safe-reuse scope metadata.
ENV_LOCAL_PATH="$(pwd -P)/.env.local" \
  SELECTED_TOKEN="$selected_token" \
  SCENARIO_ID="$scenario_id" \
  RESERVATION_GENERATION="$reservation_generation" \
  RESERVATION_TOKEN_HASH="$reservation_token_hash" \
  SAFE_REUSE_ENABLED="$safe_reuse_enabled" \
  node --input-type=module - <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";

const envLocalPath = process.env.ENV_LOCAL_PATH;
const managedValues = new Map([
  ["TELEGRAM_BOT_TOKEN", process.env.SELECTED_TOKEN],
  ["OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID", process.env.SCENARIO_ID],
  ["OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION", process.env.RESERVATION_GENERATION],
  ["OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH", process.env.RESERVATION_TOKEN_HASH],
]);
if (process.env.SAFE_REUSE_ENABLED === "yes") {
  managedValues.set(
    "OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION",
    process.env.RESERVATION_GENERATION,
  );
  managedValues.set("OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH", process.env.RESERVATION_TOKEN_HASH);
  managedValues.set("OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID", "default");
}
if (
  !envLocalPath ||
  Array.from(managedValues.values()).some((value) => typeof value !== "string" || !value)
) {
  throw new Error("Cannot publish incomplete tester-bot assignment metadata.");
}

const existingContent = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, "utf8") : "";
// Remove every managed key first, including disabled safe-reuse scope. This
// prevents a migrated legacy reservation from inheriting a stale fence request
// left by an interrupted or copied assignment.
const managedKeys = new Set([
  ...managedValues.keys(),
  "OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION",
  "OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH",
  "OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID",
]);
const keptLines = existingContent.split(/\r?\n/gu).filter((line) => {
  for (const key of managedKeys) {
    if (new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=`).test(line)) {
      return false;
    }
  }
  return true;
});
while (keptLines.length > 0 && keptLines.at(-1) === "") {
  keptLines.pop();
}
const nextLines = [
  ...keptLines,
  ...Array.from(managedValues, ([key, value]) => `${key}=${value}`),
  "",
];
const tempPath = `${envLocalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
fs.writeFileSync(tempPath, nextLines.join("\n"), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
fs.renameSync(tempPath, envLocalPath);
fs.chmodSync(envLocalPath, 0o600);
NODE

if [[ "$selection_action" == "retain" ]]; then
  echo "Retained Telegram bot token #$selected_index for worktree: $(pwd -P)"
else
  echo "Assigned Telegram bot token #$selected_index to worktree: $(pwd -P)"
fi
echo "Selection reason: ${selection_reason}"
echo "Scenario ID: ${scenario_id}"
echo "Reservation generation: ${reservation_generation}"
echo "Safe reuse fence required: ${safe_reuse_required}"
echo "Token fingerprint: $(mask_token "$selected_token")"
