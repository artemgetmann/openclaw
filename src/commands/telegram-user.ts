import type { RuntimeEnv } from "../runtime.js";
import {
  getTelegramUserDefaultPollIntervalMs,
  getTelegramUserDefaultWaitTimeoutMs,
  runTelegramUserPrecheck,
  runTelegramUserRead,
  runTelegramUserSend,
  sleep,
} from "../telegram-user/backend.js";
import {
  appendIgnoredTelegramUserCandidate,
  buildTelegramUserWaitResult,
  buildTelegramUserWaitTimeoutError,
  matchTelegramUserMessage,
} from "../telegram-user/match.js";
import type {
  TelegramUserBackendOptions,
  TelegramUserMessage,
  TelegramUserPrecheck,
  TelegramUserReadResult,
  TelegramUserSendResult,
  TelegramUserWaitParams,
  TelegramUserWaitResult,
} from "../telegram-user/types.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";

function readBooleanOpt(opts: Record<string, unknown>, key: string): boolean {
  return opts[key] === true;
}

function readNumberOpt(opts: Record<string, unknown>, key: string): number | undefined {
  const value = opts[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readStringOpt(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveBackendOptions(opts: Record<string, unknown>): TelegramUserBackendOptions {
  return {
    envFile: readStringOpt(opts, "envFile"),
    session: readStringOpt(opts, "session"),
  };
}

function renderTelegramUserMessageRows(messages: TelegramUserMessage[]) {
  return messages.map((message) => {
    const topicId = message.direct_messages_topic?.topic_id ?? message.direct_messages_topic_id;
    return {
      Id: String(message.message_id),
      Sender: message.sender_id == null ? "-" : String(message.sender_id),
      "Reply To": message.reply_to_msg_id == null ? "-" : String(message.reply_to_msg_id),
      "Top Id": message.reply_to_top_id == null ? "-" : String(message.reply_to_top_id),
      Topic: topicId == null ? "-" : String(topicId),
      Text: message.text.replace(/\s+/g, " ").trim(),
    };
  });
}

function formatTelegramUserMessages(messages: TelegramUserMessage[]): string {
  return renderTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Id", header: "Id", minWidth: 8 },
      { key: "Sender", header: "Sender", minWidth: 10 },
      { key: "Reply To", header: "Reply To", minWidth: 10 },
      { key: "Top Id", header: "Top Id", minWidth: 10 },
      { key: "Topic", header: "Topic", minWidth: 10 },
      { key: "Text", header: "Text", flex: true, minWidth: 24 },
    ],
    rows: renderTelegramUserMessageRows(messages),
  }).trimEnd();
}

function logJson(runtime: RuntimeEnv, payload: unknown) {
  runtime.log(JSON.stringify(payload, null, 2));
}

function logPrecheckText(runtime: RuntimeEnv, precheck: TelegramUserPrecheck) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user session ready: user_id=${precheck.user.user_id} username=${precheck.user.username ?? "-"} session=${precheck.session_path}`,
    ),
  );
  if (precheck.chat) {
    runtime.log(
      `chat_id=${precheck.chat.chat_id ?? "-"} peer_type=${precheck.chat.peer_type ?? "-"} username=${precheck.chat.username ?? "-"}`,
    );
  }
}

function logSendText(runtime: RuntimeEnv, result: TelegramUserSendResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  const message = result.message;
  const topicId = message.direct_messages_topic?.topic_id ?? message.direct_messages_topic_id;
  runtime.log(
    ok(`Telegram user send ok. message_id=${message.message_id} chat_id=${message.chat_id}`),
  );
  runtime.log(
    `sender_id=${message.sender_id ?? "-"} reply_to_msg_id=${message.reply_to_msg_id ?? "-"} reply_to_top_id=${message.reply_to_top_id ?? "-"} direct_messages_topic.topic_id=${topicId ?? "-"}`,
  );
}

function logReadText(runtime: RuntimeEnv, result: TelegramUserReadResult) {
  if (result.messages.length === 0) {
    runtime.log("No Telegram user messages matched the requested range.");
    return;
  }
  runtime.log(formatTelegramUserMessages(result.messages));
}

function logWaitText(runtime: RuntimeEnv, result: TelegramUserWaitResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user wait matched after ${result.attempts} poll(s) via ${result.matched_by}. message_id=${result.matched.message_id} chat_id=${result.matched.chat_id}`,
    ),
  );
  runtime.log(
    `sender_id=${result.matched.sender_id ?? "-"} reply_to_msg_id=${result.matched.reply_to_msg_id ?? "-"} reply_to_top_id=${result.matched.reply_to_top_id ?? "-"} direct_messages_topic.topic_id=${result.matched.direct_messages_topic?.topic_id ?? result.matched.direct_messages_topic_id ?? "-"}`,
  );
  runtime.log(`text=${JSON.stringify(result.matched.text)}`);
}

export async function telegramUserPrecheckCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const result = await runTelegramUserPrecheck({
    ...resolveBackendOptions(opts),
    chat: readStringOpt(opts, "chat"),
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logPrecheckText(runtime, result);
}

export async function telegramUserSendCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const chat = readStringOpt(opts, "chat");
  const message = readStringOpt(opts, "message");
  if (!chat || !message) {
    throw new Error("Telegram user send requires --chat and --message.");
  }
  const result = await runTelegramUserSend({
    ...resolveBackendOptions(opts),
    chat,
    message,
    replyTo: readNumberOpt(opts, "replyTo"),
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logSendText(runtime, result);
}

export async function telegramUserReadCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user read requires --chat.");
  }
  const result = await runTelegramUserRead({
    ...resolveBackendOptions(opts),
    chat,
    limit: readNumberOpt(opts, "limit") ?? 20,
    afterId: readNumberOpt(opts, "afterId"),
    beforeId: readNumberOpt(opts, "beforeId"),
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logReadText(runtime, result);
}

export async function telegramUserWaitCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user wait requires --chat.");
  }

  const params: TelegramUserWaitParams = {
    ...resolveBackendOptions(opts),
    chat,
    afterId: readNumberOpt(opts, "afterId") ?? 0,
    contains: readStringOpt(opts, "contains") ?? "",
    limit: readNumberOpt(opts, "limit") ?? 80,
    pollIntervalMs: readNumberOpt(opts, "pollIntervalMs") ?? getTelegramUserDefaultPollIntervalMs(),
    senderId: readNumberOpt(opts, "senderId") ?? 0,
    threadAnchor: readNumberOpt(opts, "threadAnchor") ?? 0,
    timeoutMs: readNumberOpt(opts, "timeoutMs") ?? getTelegramUserDefaultWaitTimeoutMs(),
  };

  const startedAt = Date.now();
  let attempts = 0;
  let ignoredRecent: ReturnType<typeof appendIgnoredTelegramUserCandidate> = [];
  const seenMessageIds = new Set<number>();

  while (Date.now() - startedAt < (params.timeoutMs ?? getTelegramUserDefaultWaitTimeoutMs())) {
    attempts += 1;
    const readResult = await runTelegramUserRead({
      ...resolveBackendOptions(opts),
      chat: params.chat,
      limit: params.limit,
      afterId: params.afterId,
    });

    for (const message of readResult.messages) {
      if (seenMessageIds.has(message.message_id)) {
        continue;
      }
      seenMessageIds.add(message.message_id);
      const match = matchTelegramUserMessage(message, params);
      if (!match.matched) {
        ignoredRecent = appendIgnoredTelegramUserCandidate(ignoredRecent, message, match.reason);
        continue;
      }
      const result = buildTelegramUserWaitResult({
        attempts,
        elapsedMs: Date.now() - startedAt,
        ignoredRecent,
        matched: message,
        matchedBy: match.matchedBy,
      });
      if (readBooleanOpt(opts, "json")) {
        logJson(runtime, result);
        return;
      }
      logWaitText(runtime, result);
      return;
    }

    await sleep(params.pollIntervalMs ?? getTelegramUserDefaultPollIntervalMs());
  }

  throw buildTelegramUserWaitTimeoutError(params, attempts, Date.now() - startedAt, ignoredRecent);
}
