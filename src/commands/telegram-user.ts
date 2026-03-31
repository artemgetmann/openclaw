import type { RuntimeEnv } from "../runtime.js";
import {
  getTelegramUserDefaultPollIntervalMs,
  getTelegramUserDefaultWaitTimeoutMs,
  runTelegramUserClick,
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
  TelegramUserBackendMeta,
  TelegramUserBackendOptions,
  TelegramUserClickResult,
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
    const buttons = message.buttons
      .flat()
      .map((button) => button.text)
      .join(" | ");
    return {
      Id: String(message.message_id),
      Sender: message.sender_id == null ? "-" : String(message.sender_id),
      "Reply To": message.reply_to_msg_id == null ? "-" : String(message.reply_to_msg_id),
      "Top Id": message.reply_to_top_id == null ? "-" : String(message.reply_to_top_id),
      Topic: topicId == null ? "-" : String(topicId),
      Buttons: buttons || "-",
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
      { key: "Buttons", header: "Buttons", minWidth: 20, maxWidth: 36 },
      { key: "Text", header: "Text", flex: true, minWidth: 24 },
    ],
    rows: renderTelegramUserMessageRows(messages),
  }).trimEnd();
}

function logJson(runtime: RuntimeEnv, payload: unknown) {
  runtime.log(JSON.stringify(payload, null, 2));
}

function formatBackendMeta(meta: TelegramUserBackendMeta | undefined): string {
  if (!meta) {
    return "backend=unknown";
  }
  return `env_file=${meta.env_file} session=${meta.session_path} api_id_source=${meta.api_id_source} api_hash_source=${meta.api_hash_source}`;
}

function logPrecheckText(runtime: RuntimeEnv, precheck: TelegramUserPrecheck) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user session ready: user_id=${precheck.user.user_id} username=${precheck.user.username ?? "-"} session=${precheck.session_path}`,
    ),
  );
  runtime.log(formatBackendMeta(precheck.backend_meta));
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
  runtime.log(formatBackendMeta(result.backend_meta));
  runtime.log(
    `sender_id=${message.sender_id ?? "-"} reply_to_msg_id=${message.reply_to_msg_id ?? "-"} reply_to_top_id=${message.reply_to_top_id ?? "-"} direct_messages_topic.topic_id=${topicId ?? "-"}`,
  );
  runtime.log(`text=${JSON.stringify(message.text)}`);
}

function logReadText(runtime: RuntimeEnv, result: TelegramUserReadResult) {
  runtime.log(
    `Telegram user read completed. messages=${result.messages.length} ${formatBackendMeta(result.backend_meta)}`,
  );
  if (result.messages.length === 0) {
    runtime.log("No Telegram user messages matched the requested range.");
    return;
  }
  runtime.log(formatTelegramUserMessages(result.messages));
}

function logClickText(runtime: RuntimeEnv, result: TelegramUserClickResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  const topicId =
    result.message.direct_messages_topic?.topic_id ?? result.message.direct_messages_topic_id;
  const answer = result.callback_answer?.message
    ? ` callback_answer=${JSON.stringify(result.callback_answer.message)} alert=${String(result.callback_answer.alert)}`
    : "";
  runtime.log(
    ok(
      `Telegram user click ok. matched_by=${result.matched_by} button=${JSON.stringify(result.clicked_button.text)} message_id=${result.message.message_id} chat_id=${result.message.chat_id}${answer}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  runtime.log(
    `sender_id=${result.message.sender_id ?? "-"} reply_to_msg_id=${result.message.reply_to_msg_id ?? "-"} reply_to_top_id=${result.message.reply_to_top_id ?? "-"} direct_messages_topic.topic_id=${topicId ?? "-"} button_row=${result.clicked_button.row} button_column=${result.clicked_button.column}`,
  );
  runtime.log(`text=${JSON.stringify(result.message.text)}`);
  if (result.message.buttons.length > 0) {
    runtime.log(
      `buttons=${JSON.stringify(result.message.buttons.map((row) => row.map((button) => button.text)))}`,
    );
  }
}

function logWaitText(runtime: RuntimeEnv, result: TelegramUserWaitResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user wait matched after ${result.attempts} poll(s) via ${result.matched_by}. message_id=${result.matched.message_id} chat_id=${result.matched.chat_id}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
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

export async function telegramUserClickCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const chat = readStringOpt(opts, "chat");
  const messageId = readNumberOpt(opts, "messageId");
  if (!chat || !messageId) {
    throw new Error("Telegram user click requires --chat and --message-id.");
  }

  const buttonText = readStringOpt(opts, "buttonText");
  const buttonSubstring = readStringOpt(opts, "buttonSubstring");
  const callbackData = readStringOpt(opts, "callbackData");
  const matchCount = [buttonText, buttonSubstring, callbackData].filter(Boolean).length;
  if (matchCount !== 1) {
    throw new Error(
      "Telegram user click requires exactly one of --button-text, --button-substring, or --callback-data.",
    );
  }

  const result = await runTelegramUserClick({
    ...resolveBackendOptions(opts),
    afterClickSleepMs: readNumberOpt(opts, "afterClickSleepMs"),
    buttonSubstring,
    buttonText,
    callbackData,
    chat,
    messageId,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logClickText(runtime, result);
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
        backendMeta: readResult.backend_meta,
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
