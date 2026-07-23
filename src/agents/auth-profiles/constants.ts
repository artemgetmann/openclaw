import { createSubsystemLogger } from "../../logging/subsystem.js";

export const AUTH_STORE_VERSION = 1;
export const AUTH_PROFILE_FILENAME = "auth-profiles.json";
export const LEGACY_AUTH_FILENAME = "auth.json";

export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
export const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

export const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

// OAuth providers such as OpenAI rotate refresh tokens: once one caller uses a
// token, a second concurrent refresh with the same value is permanently
// rejected. Keep this lock separate from the per-store write lock because it
// coordinates every agent store that shares one provider/profile credential.
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
} as const;

export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;
export const EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000;

export const log = createSubsystemLogger("agents/auth-profiles");
