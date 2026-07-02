export function collectActiveTelegramTokenLeaseEntries(params?: unknown): unknown[];
export function isCanonicalSharedGatewayActive(params?: unknown): boolean;
export function collectActiveReservedTelegramBotTokensFromCanonicalConfig(
  params?: unknown,
): string[];
export function deriveTelegramLiveRuntimeProfile(params?: unknown): {
  worktreePath: string;
  profileId: string;
  runtimePort: number;
  runtimeStateDir: string;
};
export function isTelegramLiveIsolatedRuntimeProfile(params?: unknown): boolean;
export function resolveTelegramLiveModelAuthProbe(params?: unknown): {
  required: boolean;
  reason: string;
  model: string;
  provider: string;
  profile: string;
};
export function ensureTelegramLiveSenderAccess(params?: unknown): {
  ok: boolean;
  status: string;
  reason: string;
  senderId: string;
  storePath: string;
};
export function syncTelegramLiveRuntimeMemoryStore(params?: unknown): {
  copied: boolean;
  reason?: string;
  sourceMemoryDir?: string;
  targetMemoryDir?: string;
};
export function selectTelegramTesterToken(params?: unknown): {
  ok: boolean;
  action: string;
  reason: string;
  selectedToken: string | null;
};
export function summarizeTelegramTesterTokenPool(params?: unknown): unknown;
export function buildTelegramLiveRuntimeConfig(params?: unknown): unknown;
export function pruneTesterRuntimeAuthStore(params?: unknown): Record<string, unknown>;
export function resolveTesterRuntimeAuthStoreFromSources(params?: unknown): Record<string, unknown>;
export function extractTelegramBotTokensFromConfig(config?: unknown): string[];
