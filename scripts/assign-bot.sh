#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"
BASE_CONFIG_PATH="${OPENCLAW_TELEGRAM_BASE_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}}"

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

selection="$(
  HELPER_MODULE="$HELPER_MODULE" \
  BASE_CONFIG_PATH="$BASE_CONFIG_PATH" \
  CURRENT_WORKTREE="$(pwd -P)" \
  node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const helperPath = process.env.HELPER_MODULE;
const baseConfigPath = process.env.BASE_CONFIG_PATH ?? "";
const currentWorktree = process.env.CURRENT_WORKTREE ?? "";

if (!helperPath) {
  throw new Error("Missing helper module path.");
}

const {
  extractTelegramBotTokensFromConfig,
  selectTelegramTesterToken,
} = await import(pathToFileURL(helperPath).href);

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

const currentToken = fs.existsSync(envLocalPath) ? readLastEnvValue(envLocalPath, "TELEGRAM_BOT_TOKEN") : "";

const claimedTokens = [];
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
    claimedTokens.push(claimed);
  }
}

let reservedTokens = [];
if (baseConfigPath && fs.existsSync(baseConfigPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(baseConfigPath, "utf8"));
    reservedTokens = extractTelegramBotTokensFromConfig(parsed);
  } catch {
    reservedTokens = [];
  }
}

const selection = selectTelegramTesterToken({
  poolTokens,
  claimedTokens,
  reservedTokens,
  currentToken,
});

if (!selection.ok || !selection.selectedToken) {
  console.log("ok=no");
  console.log(`reason=${selection.reason}`);
  console.log(`claimedCount=${claimedTokens.length}`);
  console.log(`poolCount=${poolTokens.length}`);
  console.log(`reservedCount=${reservedTokens.length}`);
  process.exit(0);
}

const selectedIndex = poolTokens.findIndex((token) => token === selection.selectedToken);
console.log("ok=yes");
console.log(`action=${selection.action}`);
console.log(`reason=${selection.reason}`);
console.log(`selectedToken=${selection.selectedToken}`);
console.log(`selectedIndex=${selectedIndex >= 0 ? selectedIndex + 1 : 0}`);
console.log(`claimedCount=${claimedTokens.length}`);
console.log(`poolCount=${poolTokens.length}`);
console.log(`reservedCount=${reservedTokens.length}`);
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
  esac
done <<< "$selection"

if [[ "$selection_ok" != "yes" || -z "$selected_token" ]]; then
  echo "Error: no eligible tester bot tokens available." >&2
  echo "Reason: ${selection_reason:-unknown}" >&2
  echo "Claimed: ${claimed_count} / Pool: ${pool_count} / Reserved by main runtime: ${reserved_count}" >&2
  echo "Delete an unused worktree .env.local or add more tester-only bot tokens." >&2
  exit 1
fi

printf 'TELEGRAM_BOT_TOKEN=%s\n' "$selected_token" > ".env.local"

if [[ "$selection_action" == "retain" ]]; then
  echo "Retained Telegram bot token #$selected_index for worktree: $(pwd -P)"
else
  echo "Assigned Telegram bot token #$selected_index to worktree: $(pwd -P)"
fi
echo "Selection reason: ${selection_reason}"
echo "Token fingerprint: $(mask_token "$selected_token")"
