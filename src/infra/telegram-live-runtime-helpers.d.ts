declare module "*telegram-live-runtime-helpers.mjs" {
  export type TelegramTokenLeaseEntry = {
    token: string;
    worktreePath: string;
    pid: number;
    accountId: string | null;
  };

  export type TelegramLiveRuntimeConfig = {
    gateway: {
      port: number;
      bind: string;
      mode: string;
      controlUi: {
        enabled: boolean;
        allowedOrigins: string[];
      };
    };
    channels: {
      telegram: {
        allowFrom?: string[];
        enabled: boolean;
        requireMention?: boolean;
        dmPolicy?: string;
        botToken: string;
      };
    };
    agents?: {
      defaults?: {
        workspace?: string;
        model?: {
          primary?: string;
          fallbacks?: string[];
        };
      };
      list?: Array<{ id: string }>;
    };
    acp: {
      enabled: boolean;
      dispatch: {
        enabled: boolean;
      };
    };
    bindings: unknown[];
    plugins: {
      enabled: boolean;
      allow: string[];
      deny?: string[];
      entries?: Record<string, { enabled?: boolean }>;
      slots?: Record<string, string>;
    };
    env?: Record<string, string>;
    tools?: Record<string, unknown>;
  };

  export function collectActiveTelegramTokenLeaseEntries(
    params?: unknown,
  ): TelegramTokenLeaseEntry[];
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
  export function summarizeTelegramTesterTokenPool(params?: unknown): Record<string, unknown>;
  export function buildTelegramLiveRuntimeConfig(params?: unknown): TelegramLiveRuntimeConfig;
  export function extractTelegramBotTokensFromConfig(config?: unknown): string[];
}
