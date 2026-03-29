import type { Message, Update, User } from "@grammyjs/types";
import { resolveTelegramAccount } from "../../../extensions/telegram/src/accounts.js";
import { createTelegramBot } from "../../../extensions/telegram/src/bot.js";
import {
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "../../../extensions/telegram/src/update-offset-store.js";
import { loadConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

export type ChannelsTelegramReplaySetupDmOptions = {
  account?: string;
  json?: boolean;
  payloadJson: string;
};

export type ChannelsTelegramReplaySetupDmPayload = {
  updateId: number;
  messageId: number;
  chatId: number;
  chatUsername?: string;
  senderId: number;
  senderUsername?: string;
  senderFirstName?: string;
  text?: string;
  caption?: string;
  date: number;
  messageThreadId?: number | null;
};

export type ChannelsTelegramReplaySetupDmResult = {
  ok: boolean;
  replyStarted: boolean;
  replyCompleted: boolean;
  accountId: string;
  updateId: number;
};

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parsePayload(raw: string): ChannelsTelegramReplaySetupDmPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Captured Telegram DM payload is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Captured Telegram DM payload must be an object.");
  }
  const payload = parsed as Record<string, unknown>;
  const updateId = payload.updateId;
  const messageId = payload.messageId;
  const chatId = payload.chatId;
  const senderId = payload.senderId;
  const date = payload.date;
  if (!isSafeInteger(updateId) || updateId < 0) {
    throw new Error("Captured Telegram DM payload is missing a valid updateId.");
  }
  if (!isSafeInteger(messageId) || messageId <= 0) {
    throw new Error("Captured Telegram DM payload is missing a valid messageId.");
  }
  if (!isSafeInteger(chatId)) {
    throw new Error("Captured Telegram DM payload is missing a valid chatId.");
  }
  if (!isSafeInteger(senderId) || senderId <= 0) {
    throw new Error("Captured Telegram DM payload is missing a valid senderId.");
  }
  if (!isSafeInteger(date) || date <= 0) {
    throw new Error("Captured Telegram DM payload is missing a valid message date.");
  }
  const text = normalizeOptionalString(payload.text);
  const caption = normalizeOptionalString(payload.caption);
  if (!text && !caption) {
    throw new Error("Captured Telegram DM payload needs text or caption to start the first reply.");
  }
  const messageThreadId =
    payload.messageThreadId == null
      ? undefined
      : isSafeInteger(payload.messageThreadId)
        ? payload.messageThreadId
        : undefined;
  return {
    updateId,
    messageId,
    chatId,
    chatUsername: normalizeOptionalString(payload.chatUsername),
    senderId,
    senderUsername: normalizeOptionalString(payload.senderUsername),
    senderFirstName: normalizeOptionalString(payload.senderFirstName),
    text,
    caption,
    date,
    messageThreadId,
  };
}

function buildSyntheticUpdate(payload: ChannelsTelegramReplaySetupDmPayload): Update {
  // Reconstruct the exact private-message shape grammY expects so the setup
  // handoff exercises the normal Telegram middleware stack instead of a
  // separate "first reply" shortcut path.
  const fromUser: User = {
    id: payload.senderId,
    is_bot: false,
    first_name: payload.senderFirstName ?? "Telegram user",
    ...(payload.senderUsername ? { username: payload.senderUsername } : {}),
  };
  const message: Message & Update.NonChannel = {
    message_id: payload.messageId,
    date: payload.date,
    chat: {
      id: payload.chatId,
      type: "private",
      first_name: payload.senderFirstName ?? "Telegram user",
      ...(payload.chatUsername ? { username: payload.chatUsername } : {}),
    },
    from: fromUser,
    ...(payload.text ? { text: payload.text } : {}),
    ...(payload.caption ? { caption: payload.caption } : {}),
    ...(typeof payload.messageThreadId === "number"
      ? { message_thread_id: payload.messageThreadId }
      : {}),
  };
  return {
    update_id: payload.updateId,
    message,
  };
}

export async function replayTelegramSetupDirectMessage(params: {
  account?: string;
  payloadJson: string;
  runtime: RuntimeEnv;
}): Promise<ChannelsTelegramReplaySetupDmResult> {
  // Parse and validate the captured DM once inside the backend process so the
  // gateway and CLI wrapper share the exact same replay behavior.
  const payload = parsePayload(params.payloadJson);
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: params.account,
  });
  const token = account.token?.trim();
  if (!token) {
    throw new Error(`Telegram bot token missing for account "${account.accountId}".`);
  }

  const lastUpdateId = await readTelegramUpdateOffset({
    accountId: account.accountId,
    botToken: token,
  });
  let persistOffsetPromise: Promise<void> = Promise.resolve();
  // Seed the bot with the persisted watermark and let the normal bot pipeline
  // advance it. That keeps the setup replay and the long-polling runtime from
  // racing each other into duplicate first-message handling.
  const bot = createTelegramBot({
    token,
    accountId: account.accountId,
    config: cfg,
    runtime: params.runtime,
    updateOffset: {
      lastUpdateId,
      onUpdateId: async (updateId) => {
        const writePromise = writeTelegramUpdateOffset({
          accountId: account.accountId,
          botToken: token,
          updateId,
        });
        // The normal live poller can fire-and-forget watermark persistence, but
        // setup replay immediately re-enables the real Telegram runtime after
        // returning. Chain and await those writes here so the restarted poller
        // cannot see a stale offset and re-consume the same first DM.
        persistOffsetPromise = persistOffsetPromise.then(async () => {
          await writePromise;
        });
        await writePromise;
      },
    },
  });

  try {
    // The replay path does not call `bot.run()`, so grammY never performs its
    // usual lazy bot-info bootstrap. Initialize explicitly before handleUpdate.
    await bot.init();
    await bot.handleUpdate(buildSyntheticUpdate(payload));
    await persistOffsetPromise;
  } finally {
    await bot.stop().catch(() => {});
  }

  return {
    ok: true,
    replyStarted: true,
    // `handleUpdate` only resolves after the Telegram middleware stack has
    // finished this synthetic inbound message, so the backend can truthfully
    // report replay completion instead of forcing the macOS app to infer it
    // from shell stdout or delayed activity snapshots.
    replyCompleted: true,
    accountId: account.accountId,
    updateId: payload.updateId,
  };
}

export async function channelsTelegramReplaySetupDmCommand(
  opts: ChannelsTelegramReplaySetupDmOptions,
  runtime: RuntimeEnv,
) {
  const result = await replayTelegramSetupDirectMessage({
    account: opts.account,
    payloadJson: opts.payloadJson,
    runtime,
  });
  if (opts.json) {
    runtime.log(JSON.stringify(result));
    return;
  }
  runtime.log(`Telegram first-reply handoff complete for account ${result.accountId}.`);
}
