import { resolveGlobalSingleton } from "../../../src/shared/global-singleton.js";
import type { TelegramInlineButtons } from "./button-types.js";

const RUN_STOP_CALLBACK_PREFIX = "ors:";
const RUN_STOP_TOKEN_RE = /^[a-z0-9]{1,20}$/;

type TelegramRunStopEntry = {
  accountId: string;
  chatId: string;
  requesterId: string;
  threadId?: string;
};

type TelegramRunStopState = {
  nextId: number;
  entries: Map<string, TelegramRunStopEntry>;
};

export type TelegramRunStopClaim =
  | { status: "claimed" }
  | { status: "stale" }
  | { status: "mismatch" };

const TELEGRAM_RUN_STOP_STATE_KEY = Symbol.for("openclaw.telegramRunStopState");
const runStopState = resolveGlobalSingleton<TelegramRunStopState>(
  TELEGRAM_RUN_STOP_STATE_KEY,
  () => ({
    nextId: 0,
    entries: new Map(),
  }),
);

function allocateRunStopToken(): string {
  runStopState.nextId =
    runStopState.nextId >= Number.MAX_SAFE_INTEGER ? 1 : runStopState.nextId + 1;
  return runStopState.nextId.toString(36);
}

function normalizeThreadId(value: string | number | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function parseTelegramRunStopCallbackData(data: string): string | undefined {
  const normalized = data.trim();
  if (!normalized.startsWith(RUN_STOP_CALLBACK_PREFIX)) {
    return undefined;
  }
  const token = normalized.slice(RUN_STOP_CALLBACK_PREFIX.length);
  return RUN_STOP_TOKEN_RE.test(token) ? token : undefined;
}

export function registerTelegramRunStop(params: {
  accountId: string;
  chatId: string | number;
  requesterId: string | number;
  threadId?: string | number | null;
}): {
  buttons: TelegramInlineButtons;
  release: () => void;
} {
  const token = allocateRunStopToken();
  const entry: TelegramRunStopEntry = {
    accountId: params.accountId,
    chatId: String(params.chatId),
    requesterId: String(params.requesterId),
    threadId: normalizeThreadId(params.threadId),
  };
  runStopState.entries.set(token, entry);
  let released = false;
  return {
    buttons: [
      [
        {
          text: "⏹ Stop",
          callback_data: `${RUN_STOP_CALLBACK_PREFIX}${token}`,
          style: "danger",
        },
      ],
    ],
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (runStopState.entries.get(token) === entry) {
        runStopState.entries.delete(token);
      }
    },
  };
}

export function claimTelegramRunStop(params: {
  data: string;
  accountId: string;
  chatId: string | number;
  requesterId: string | number;
  threadId?: string | number | null;
}): TelegramRunStopClaim | undefined {
  const token = parseTelegramRunStopCallbackData(params.data);
  if (!token) {
    return undefined;
  }
  const entry = runStopState.entries.get(token);
  if (!entry) {
    return { status: "stale" };
  }
  if (
    entry.accountId !== params.accountId ||
    entry.chatId !== String(params.chatId) ||
    entry.requesterId !== String(params.requesterId) ||
    entry.threadId !== normalizeThreadId(params.threadId)
  ) {
    return { status: "mismatch" };
  }
  // Claim before cancellation begins. Duplicate Telegram deliveries or
  // impatient repeat taps then become harmless stale callbacks.
  runStopState.entries.delete(token);
  return { status: "claimed" };
}

export const __testing = {
  resetTelegramRunStopsForTests() {
    runStopState.nextId = 0;
    runStopState.entries.clear();
  },
};
