import { randomBytes } from "node:crypto";
import { resolveGlobalSingleton } from "../../../src/shared/global-singleton.js";
import type { TelegramInlineButtons } from "./button-types.js";

const RUN_STOP_CALLBACK_PREFIX = "ors:";
const RUN_STOP_TOKEN_RE = /^[a-f0-9]{24}$/;

type TelegramRunStopEntry = {
  accountId: string;
  chatId: string;
  requesterId: string;
  threadId?: string;
  released: boolean;
};

type TelegramRunStopState = {
  entries: Map<string, TelegramRunStopEntry>;
};

export type TelegramRunStopClaim =
  | { status: "claimed"; restore: () => void }
  | { status: "stale" }
  | { status: "mismatch" };

const TELEGRAM_RUN_STOP_STATE_KEY = Symbol.for("openclaw.telegramRunStopState");
const runStopState = resolveGlobalSingleton<TelegramRunStopState>(
  TELEGRAM_RUN_STOP_STATE_KEY,
  () => ({
    entries: new Map(),
  }),
);

function allocateRunStopToken(): string {
  // A process-local counter can reuse a still-visible callback after restart
  // and let an old button cancel a new run on the same route. A 96-bit random
  // token stays well within Telegram's 64-byte callback_data limit while
  // making reuse across registrations and restarts negligible.
  return randomBytes(12).toString("hex");
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
    released: false,
  };
  runStopState.entries.set(token, entry);
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
      if (entry.released) {
        return;
      }
      // Mark the shared entry even while a claim has temporarily removed it
      // from the map. A later failed-abort restore must see that the owning
      // controller has already disposed this authorization.
      entry.released = true;
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
  let restored = false;
  return {
    status: "claimed",
    restore: () => {
      if (restored || entry.released || runStopState.entries.has(token)) {
        return;
      }
      restored = true;
      runStopState.entries.set(token, entry);
    },
  };
}

export const __testing = {
  resetTelegramRunStopsForTests() {
    runStopState.entries.clear();
  },
};
