export function collectActiveTelegramTokenLeaseEntries(params?: unknown): unknown[];
export function deriveTelegramLiveRuntimeProfile(params?: unknown): {
  worktreePath: string;
  profileId: string;
  runtimePort: number;
  runtimeStateDir: string;
};
export function selectTelegramTesterToken(params?: unknown): {
  ok: boolean;
  action: string;
  reason: string;
  selectedToken: string | null;
};
export function summarizeTelegramTesterTokenPool(params?: unknown): unknown;
export function buildTelegramLiveRuntimeConfig(params?: unknown): unknown;
export function extractTelegramBotTokensFromConfig(config?: unknown): string[];
