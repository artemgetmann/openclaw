import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { ListenerHealthSnapshot } from "../monitor/listener-health.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  getTelegramUserDefaultPollIntervalMs,
  getTelegramUserDefaultWaitTimeoutMs,
  runTelegramUserButtonClick,
  runTelegramUserInbox,
  runTelegramUserLogin,
  runTelegramUserLogout,
  runTelegramUserMarkRead,
  runTelegramUserMarkUnread,
  runTelegramUserOwnerClaim,
  runTelegramUserPrecheck,
  runTelegramUserRead,
  runTelegramUserDownload,
  runTelegramUserSend,
  runTelegramUserStatus,
  runTelegramUserTopicCreate,
  runTelegramUserTopicDelete,
  runTelegramUserTopicList,
  runTelegramUserTopicResolve,
  sleep,
} from "../telegram-user/backend.js";
import type {
  TelegramUserMonitorPollDispatchContext,
  TelegramUserMonitorPollResult,
} from "../telegram-user/monitor-listener.js";
import type {
  TelegramUserAuthStatus,
  TelegramUserBackendMeta,
  TelegramUserBackendOptions,
  TelegramUserButtonClickResult,
  TelegramUserDoctorResult,
  TelegramUserDownloadResult,
  TelegramUserInboxDialog,
  TelegramUserInboxResult,
  TelegramUserLoginResult,
  TelegramUserMarkReadResult,
  TelegramUserMarkUnreadResult,
  TelegramUserOwnerClaimResult,
  TelegramUserMessage,
  TelegramUserLogoutResult,
  TelegramUserPrecheck,
  TelegramUserReadResult,
  TelegramUserSendResult,
  TelegramUserTopicCreateResult,
  TelegramUserTopicDeleteResult,
  TelegramUserTopicListResult,
  TelegramUserTopicResolveResult,
  TelegramUserWaitParams,
  TelegramUserWaitResult,
} from "../telegram-user/types.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";

const telegramReadFormats = new Set(["table", "compact"]);

type TelegramUserReadFormat = "table" | "compact";
type TelegramUserCompactMessage = {
  buttons: TelegramUserMessage["inline_buttons"];
  date: string | null;
  dir: "in" | "out";
  id: number;
  media: TelegramUserMessage["media_kind"];
  reply_to: number | null;
  sender: number | null;
  text: string;
  top: number | null;
  topic: number | null;
};

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

function readExactStringOpt(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTelegramReadFormat(opts: Record<string, unknown>): TelegramUserReadFormat {
  const raw = readStringOpt(opts, "format") ?? "table";
  if (!telegramReadFormats.has(raw)) {
    throw new Error("Telegram user read --format must be either table or compact.");
  }
  return raw as TelegramUserReadFormat;
}

function hasProvidedOpt(opts: Record<string, unknown>, key: string): boolean {
  const value = opts[key];
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function readRequiredNumberOpt(
  opts: Record<string, unknown>,
  key: string,
  flag: string,
  context = "Telegram user send",
): number | undefined {
  const value = readNumberOpt(opts, key);
  if (value === undefined && hasProvidedOpt(opts, key)) {
    throw new Error(`${context} requires ${flag} to be a numeric message/topic id.`);
  }
  return value;
}

function resolveSendTarget(opts: Record<string, unknown>): {
  replyTo?: number;
  topicAnchor?: number;
  topicTitle?: string;
} {
  const replyTo = readRequiredNumberOpt(opts, "replyTo", "--reply-to");
  const topicAnchor =
    readRequiredNumberOpt(opts, "topicAnchor", "--topic-anchor") ??
    readRequiredNumberOpt(opts, "topicId", "--topic-id");
  if (topicAnchor !== undefined && (!Number.isInteger(topicAnchor) || topicAnchor <= 0)) {
    throw new Error("Telegram user send requires --topic-anchor to be a positive integer.");
  }
  if (replyTo !== undefined && topicAnchor !== undefined && replyTo !== topicAnchor) {
    throw new Error("Telegram user send cannot combine --reply-to with a different topic anchor.");
  }
  const topicTitle = readStringOpt(opts, "topicTitle");
  const rawTopicTitle = opts.topicTitle;
  // A title is an assertion, not a search query. Reject invisible normalization
  // at the CLI boundary so the backend compares the caller's exact title.
  if (typeof rawTopicTitle === "string" && rawTopicTitle !== rawTopicTitle.trim()) {
    throw new Error("Telegram user send requires --topic-title without surrounding whitespace.");
  }
  // A numeric topic id is not durable identity: titles and ids can be confused
  // across agent handoffs. Force callers onto a title+anchor pair so the
  // backend can revalidate both under the same session lock as the send.
  if (topicAnchor !== undefined && !topicTitle) {
    throw new Error(
      "Telegram user send requires --topic-title with --topic-anchor so Telegram can validate the destination before sending.",
    );
  }
  if (topicTitle && topicAnchor === undefined) {
    throw new Error("Telegram user send requires --topic-anchor with --topic-title.");
  }
  return { replyTo, topicAnchor, topicTitle };
}

function resolveBackendOptions(opts: Record<string, unknown>): TelegramUserBackendOptions {
  return {
    envFile: readStringOpt(opts, "envFile"),
    session: readStringOpt(opts, "session"),
  };
}

async function readLoginSecretFromStdin(kind: string | undefined): Promise<{
  code?: string;
  password?: string;
}> {
  if (!kind) {
    return {};
  }
  if (kind !== "code" && kind !== "password") {
    throw new Error("Telegram user login --secret-stdin must be code or password.");
  }
  if (process.stdin.isTTY) {
    throw new Error("Telegram user login --secret-stdin requires a local pipe, not a terminal.");
  }
  let secret = "";
  for await (const chunk of process.stdin) {
    secret += chunk.toString();
    if (secret.length > 16_384) {
      throw new Error("Telegram user login secret input exceeded the local limit.");
    }
  }
  const value = secret.replace(/[\r\n]+$/, "");
  if (!value) {
    throw new Error("Telegram user login received an empty local secret.");
  }
  return kind === "code" ? { code: value } : { password: value };
}

function assertNever(value: never, context: string): never {
  throw new Error(context);
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

function formatTelegramCompactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getTelegramMessageTopicId(message: TelegramUserMessage): number | null {
  return message.direct_messages_topic?.topic_id ?? message.direct_messages_topic_id ?? null;
}

function toTelegramCompactMessage(message: TelegramUserMessage): TelegramUserCompactMessage {
  return {
    buttons: message.inline_buttons ?? [],
    date: message.date,
    dir: message.out ? "out" : "in",
    id: message.message_id,
    media: message.media_kind ?? null,
    reply_to: message.reply_to_msg_id,
    sender: message.sender_id,
    text: formatTelegramCompactText(message.text),
    top: message.reply_to_top_id,
    topic: getTelegramMessageTopicId(message),
  };
}

function formatTelegramCompactField(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function buildTelegramCompactPaging(messages: TelegramUserCompactMessage[]) {
  if (messages.length === 0) {
    return {
      newer_after_id: null,
      older_before_id: null,
    };
  }
  const ids = messages.map((message) => message.id);
  return {
    newer_after_id: Math.max(...ids),
    older_before_id: Math.min(...ids),
  };
}

function buildTelegramCompactReadResult(result: TelegramUserReadResult, chat: string) {
  const messages = result.messages.map(toTelegramCompactMessage);
  return {
    chat,
    messages,
    order: "newest_first" as const,
    paging: buildTelegramCompactPaging(messages),
    ...(result.topic ? { topic: result.topic } : {}),
  };
}

function formatTelegramCompactMessages(result: TelegramUserReadResult, chat: string): string {
  const compact = buildTelegramCompactReadResult(result, chat);
  const lines = [
    `Telegram user read compact. chat=${chat} messages=${compact.messages.length} order=newest-first`,
  ];
  if ("topic" in compact && compact.topic) {
    lines.push(
      `Topic: anchor=${compact.topic.topic_anchor} title=${JSON.stringify(compact.topic.topic_title)}`,
    );
  }
  for (const message of compact.messages) {
    lines.push(
      [
        `id=${message.id}`,
        `date=${formatTelegramCompactField(message.date)}`,
        `dir=${message.dir}`,
        `sender=${formatTelegramCompactField(message.sender)}`,
        `reply_to=${formatTelegramCompactField(message.reply_to)}`,
        `top=${formatTelegramCompactField(message.top)}`,
        `topic=${formatTelegramCompactField(message.topic)}`,
        `media=${formatTelegramCompactField(message.media)}`,
        `buttons=${JSON.stringify(message.buttons)}`,
        `text=${JSON.stringify(message.text)}`,
      ].join(" "),
    );
  }
  if (compact.messages.length === 0) {
    lines.push("No Telegram user messages matched the requested range.");
    return lines.join("\n");
  }
  lines.push(
    `Paging: newer --after-id ${compact.paging.newer_after_id} | older --before-id ${compact.paging.older_before_id}`,
  );
  return lines.join("\n");
}

function formatTelegramInboxLastMessage(dialog: TelegramUserInboxDialog): string {
  const lastMessage = dialog.last_message;
  if (!lastMessage) {
    return "-";
  }
  const text = lastMessage.text.replace(/\s+/g, " ").trim();
  if (text) {
    return text;
  }
  return `[message ${lastMessage.message_id}]`;
}

function formatTelegramInboxType(dialog: TelegramUserInboxDialog): string {
  if (dialog.is_user) {
    return dialog.is_bot ? "bot-dm" : "dm";
  }
  if (dialog.is_group) {
    return "group";
  }
  if (dialog.is_channel) {
    return "channel";
  }
  return "chat";
}

function renderTelegramInboxRows(dialogs: TelegramUserInboxDialog[]) {
  return dialogs.map((dialog) => ({
    Chat: dialog.display_name,
    Type: formatTelegramInboxType(dialog),
    Unread: String(dialog.unread_count),
    Mentions: String(dialog.unread_mentions_count),
    Reactions: String(dialog.unread_reactions_count),
    Flags:
      [dialog.pinned ? "pin" : "", dialog.archived ? "arch" : "", dialog.muted ? "mute" : ""]
        .filter(Boolean)
        .join(",") || "-",
    Last: formatTelegramInboxLastMessage(dialog),
  }));
}

function formatTelegramInbox(dialogs: TelegramUserInboxDialog[]): string {
  return renderTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Chat", header: "Chat", minWidth: 18 },
      { key: "Type", header: "Type", minWidth: 10 },
      { key: "Unread", header: "Unread", minWidth: 8 },
      { key: "Mentions", header: "Mentions", minWidth: 10 },
      { key: "Reactions", header: "React", minWidth: 8 },
      { key: "Flags", header: "Flags", minWidth: 12 },
      { key: "Last", header: "Last", flex: true, minWidth: 28 },
    ],
    rows: renderTelegramInboxRows(dialogs),
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

async function postTelegramUserMonitorEventHook(
  context: TelegramUserMonitorPollDispatchContext,
  opts: Record<string, unknown>,
  hookUrl: string,
) {
  const hookToken =
    readStringOpt(opts, "hookToken") ??
    // Hook endpoints authenticate with hooks.token, which is deliberately
    // separate from gateway RPC auth. Retain the gateway token only as the
    // compatibility fallback for existing manually supervised listeners.
    (process.env.OPENCLAW_HOOKS_TOKEN?.trim() || process.env.OPENCLAW_GATEWAY_TOKEN?.trim());
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(hookToken ? { Authorization: `Bearer ${hookToken}` } : {}),
    },
    body: JSON.stringify({
      accountId:
        typeof context.event.sourceTarget.accountId === "string"
          ? context.event.sourceTarget.accountId
          : undefined,
      chat: context.chat,
      message: context.message,
      monitorId: context.monitor.monitorId,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`telegram-user monitor hook returned HTTP ${response.status}: ${body}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function formatTelegramMonitorPollText(
  result: TelegramUserMonitorPollResult,
  runNumber?: number,
): string {
  const lines = [
    `Telegram user monitor-poll${runNumber ? ` run=${runNumber}` : ""} checked=${result.checked} events=${result.events.length} dispatched=${result.dispatched} updated_cursors=${result.updatedCursors} skipped=${result.skipped.length}`,
    `Cursor store: ${result.cursorStorePath}`,
  ];
  for (const skipped of result.skipped) {
    lines.push(
      `Skipped ${skipped.monitorId}: ${skipped.reason}${skipped.error ? ` (${skipped.error})` : ""}`,
    );
  }
  for (const event of result.events) {
    lines.push(
      `Event ${event.monitor.monitorId}: chat=${event.chat} idempotency=${event.event.idempotencyKey ?? "-"}`,
    );
  }
  if (!result.events.length && !result.skipped.length) {
    lines.push("No Telegram user monitor events detected.");
  }
  return lines.join("\n");
}

function readPositiveIntegerOpt(
  opts: Record<string, unknown>,
  key: string,
  flag: string,
  context: string,
): number | undefined {
  const value = readNumberOpt(opts, key);
  if (value === undefined) {
    if (hasProvidedOpt(opts, key)) {
      throw new Error(`${context} requires ${flag} to be a positive integer.`);
    }
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${context} requires ${flag} to be a positive integer.`);
  }
  return value;
}

function readPresentPositiveIntegerOpt(
  opts: Record<string, unknown>,
  key: string,
  flag: string,
  context: string,
): number | undefined {
  // Presence and validity are separate for security-sensitive scoping. Only
  // an omitted property may select unscoped history; every present value must
  // prove that it is a positive integer before any backend call.
  if (!Object.prototype.hasOwnProperty.call(opts, key)) {
    return undefined;
  }
  const value = readNumberOpt(opts, key);
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`${context} requires ${flag} to be a positive integer.`);
  }
  return value;
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

function formatAuthStatusSummary(status: TelegramUserAuthStatus): string {
  const pendingState = status.pending_login?.state ?? "-";
  const pendingPhone = status.pending_login?.phone ?? "-";
  const username = status.user?.username ?? "-";
  const userId = status.user?.user_id ?? "-";
  return [
    `state=${status.state}`,
    `user_id=${userId}`,
    `username=${username}`,
    `pending_state=${pendingState}`,
    `pending_phone=${pendingPhone}`,
    `session=${status.session_path}`,
  ].join(" ");
}

function buildTelegramUserDoctorResult(status: TelegramUserAuthStatus): TelegramUserDoctorResult {
  const meta = status.backend_meta;
  const envFile = meta?.env_file ?? "unknown";
  const missingApiId = meta?.api_id_source === "missing";
  const missingApiHash = meta?.api_hash_source === "missing";
  const missingSession = status.state === "missing_session";

  // The doctor intentionally interprets status only. Setup and login stay in
  // the existing consumer-setup/login flows so this diagnostic cannot mutate
  // credentials, sessions, or runtime ownership by accident.
  const stateCopy: Record<
    TelegramUserAuthStatus["state"],
    {
      diagnosis: string;
      nextStep: string;
    }
  > = {
    awaiting_code: {
      diagnosis: "Telegram-as-me login is waiting for the Telegram OTP.",
      nextStep: "Enter the Telegram OTP through the Telegram User setup flow.",
    },
    awaiting_password: {
      diagnosis: "Telegram-as-me login is waiting for Telegram 2FA.",
      nextStep: "Complete Telegram 2FA through the secure local login prompt.",
    },
    missing_credentials: {
      diagnosis: "Telegram-as-me is missing Telegram API credentials on this Mac.",
      nextStep: "Open the Telegram User section of consumer-setup and add the API ID/hash.",
    },
    missing_session: {
      diagnosis: "Telegram-as-me has API credentials but no saved real-account session.",
      nextStep: "Open the Telegram User section of consumer-setup and complete login.",
    },
    needs_reauth: {
      diagnosis: "Telegram-as-me has a saved session, but Telegram no longer accepts it.",
      nextStep: "Reconnect Telegram-as-me through the Telegram User setup flow.",
    },
    ready: {
      diagnosis: "Telegram-as-me is ready on this Mac.",
      nextStep: status.chat
        ? "The requested chat resolved successfully."
        : "Use inbox/read/send commands for the requested Telegram-as-me task.",
    },
  };

  return {
    backend_meta: meta,
    chat: status.chat,
    diagnosis: stateCopy[status.state].diagnosis,
    expected: {
      env_file: envFile,
      session_path: status.session_path,
    },
    missing: {
      api_hash: missingApiHash,
      api_id: missingApiId,
      session: missingSession,
    },
    next_step: stateCopy[status.state].nextStep,
    ready: status.state === "ready",
    state: status.state,
    user: status.user,
  };
}

function logDoctorText(runtime: RuntimeEnv, result: TelegramUserDoctorResult) {
  const rich = isRich();
  const colorize =
    result.ready && rich
      ? theme.success
      : !result.ready && rich
        ? theme.warn
        : (text: string) => text;
  runtime.log(colorize(`Telegram-as-me doctor: state=${result.state}`));
  runtime.log(result.diagnosis);
  runtime.log(`Expected env file: ${result.expected.env_file}`);
  runtime.log(`Expected session: ${result.expected.session_path}`);

  if (result.state === "missing_credentials") {
    runtime.log(`Missing API ID: ${result.missing.api_id ? "yes" : "no"}`);
    runtime.log(`Missing API hash: ${result.missing.api_hash ? "yes" : "no"}`);
  }

  if (result.state === "ready" && result.user) {
    runtime.log(
      `User: id=${result.user.user_id} username=${result.user.username ?? "-"} first_name=${result.user.first_name ?? "-"}`,
    );
  }

  if (result.chat) {
    runtime.log(
      `Chat: id=${result.chat.chat_id ?? "-"} peer_type=${result.chat.peer_type ?? "-"} username=${result.chat.username ?? "-"}`,
    );
  }

  runtime.log(`Next step: ${result.next_step}`);
}

function logStatusText(runtime: RuntimeEnv, status: TelegramUserAuthStatus) {
  const rich = isRich();
  const colorize =
    status.state === "ready"
      ? rich
        ? theme.success
        : (text: string) => text
      : rich
        ? theme.warn
        : (text: string) => text;
  runtime.log(colorize(`Telegram user status: ${formatAuthStatusSummary(status)}`));
  runtime.log(formatBackendMeta(status.backend_meta));
  if (status.chat) {
    runtime.log(
      `chat_id=${status.chat.chat_id ?? "-"} peer_type=${status.chat.peer_type ?? "-"} username=${status.chat.username ?? "-"}`,
    );
  }
}

function logLoginText(runtime: RuntimeEnv, result: TelegramUserLoginResult) {
  const rich = isRich();
  const colorize =
    result.state === "ready"
      ? rich
        ? theme.success
        : (text: string) => text
      : rich
        ? theme.warn
        : (text: string) => text;
  runtime.log(
    colorize(
      result.state === "ready"
        ? `Telegram user login complete: user_id=${result.user?.user_id ?? "-"} username=${result.user?.username ?? "-"} session=${result.session_path}`
        : `Telegram user login pending: state=${result.state} phone=${result.pending_login?.phone ?? "-"} session=${result.session_path}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
}

function logLogoutText(runtime: RuntimeEnv, result: TelegramUserLogoutResult) {
  const rich = isRich();
  const colorize = rich ? theme.success : (text: string) => text;
  runtime.log(
    colorize(
      `Telegram user logout ${result.cleared ? "cleared session state" : "had nothing to clear"}: session=${result.session_path}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  if (result.removed_paths.length > 0) {
    runtime.log(`removed=${result.removed_paths.join(",")}`);
  }
  if (result.owner_path_preserved) {
    runtime.log("owner_path_preserved=true");
  }
}

function logOwnerClaimText(runtime: RuntimeEnv, result: TelegramUserOwnerClaimResult) {
  const rich = isRich();
  const colorize = rich ? theme.success : (text: string) => text;
  runtime.log(
    colorize(`Telegram user owner claimed: source=${result.source} session=${result.session_path}`),
  );
  runtime.log(
    `authorized_same_account_sources=${result.authorized_same_account_sources.join(",") || "none"}`,
  );
  runtime.log(`unauthorized_sources=${result.unauthorized_sources.join(",") || "none"}`);
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

function logButtonClickText(runtime: RuntimeEnv, result: TelegramUserButtonClickResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  const outcome = result.clicked ? "ok" : "no-action";
  runtime.log(
    ok(
      `Telegram user button-click ${outcome}. message_id=${result.message_id} chat=${result.chat} text=${JSON.stringify(result.button.text)}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  runtime.log(
    `callback_data=${JSON.stringify(result.button.callback_data)} button_url=${JSON.stringify(result.button.url)} alert=${result.click_result.alert} response=${JSON.stringify(result.click_result.message)} result_url=${JSON.stringify(result.click_result.url)} url_action=${JSON.stringify(result.url_action ?? null)}`,
  );
}

function logTopicCreateText(runtime: RuntimeEnv, result: TelegramUserTopicCreateResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user topic-create ok. topic_anchor=${result.topic_anchor} message_id=${result.message_id} chat_id=${result.chat_id}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  runtime.log(`topic_title=${JSON.stringify(result.topic_title)}`);
}

function logTopicDeleteText(runtime: RuntimeEnv, result: TelegramUserTopicDeleteResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user topic-delete ok. topic_anchor=${result.topic_anchor} chat_id=${result.chat_id} deleted=${result.deleted}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  runtime.log(
    `affected_pts=${result.affected.pts} affected_pts_count=${result.affected.pts_count} affected_offset=${result.affected.offset}`,
  );
}

function logTopicResolveText(runtime: RuntimeEnv, result: TelegramUserTopicResolveResult) {
  runtime.log(
    `Telegram user topic-resolve ok. chat=${result.chat} topic_anchor=${result.topic.topic_anchor} topic_title=${JSON.stringify(result.topic.topic_title)}`,
  );
  runtime.log(formatBackendMeta(result.backend_meta));
}

function logTopicListText(runtime: RuntimeEnv, result: TelegramUserTopicListResult) {
  runtime.log(
    `Telegram user topic-list completed. chat=${result.chat} topics=${result.topics.length} query=${JSON.stringify(result.query)}`,
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  for (const topic of result.topics) {
    runtime.log(
      `topic_anchor=${topic.topic_anchor} topic_title=${JSON.stringify(topic.topic_title)} closed=${topic.closed} hidden=${topic.hidden}`,
    );
  }
}

function logReadText(runtime: RuntimeEnv, result: TelegramUserReadResult) {
  runtime.log(
    `Telegram user read completed. messages=${result.messages.length} ${formatBackendMeta(result.backend_meta)}`,
  );
  if (result.topic) {
    runtime.log(
      `topic_anchor=${result.topic.topic_anchor} topic_title=${JSON.stringify(result.topic.topic_title)}`,
    );
  }
  if (result.messages.length === 0) {
    runtime.log("No Telegram user messages matched the requested range.");
    return;
  }
  runtime.log(formatTelegramUserMessages(result.messages));
}

function logMarkReadText(runtime: RuntimeEnv, result: TelegramUserMarkReadResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(ok(`Telegram user mark-read ok. chat=${result.chat}`));
  runtime.log(formatBackendMeta(result.backend_meta));
}

function logMarkUnreadText(runtime: RuntimeEnv, result: TelegramUserMarkUnreadResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(ok(`Telegram user mark-unread ok. chat=${result.chat}`));
  runtime.log(formatBackendMeta(result.backend_meta));
}

function logDownloadText(runtime: RuntimeEnv, result: TelegramUserDownloadResult) {
  const rich = isRich();
  const ok = rich ? theme.success : (text: string) => text;
  runtime.log(
    ok(
      `Telegram user download ok. message_id=${result.message_id} media_kind=${result.media_kind ?? "-"} path=${result.path}`,
    ),
  );
  runtime.log(formatBackendMeta(result.backend_meta));
  runtime.log(`size_bytes=${result.size_bytes ?? "-"}`);
}

function logInboxText(
  runtime: RuntimeEnv,
  result: TelegramUserInboxResult,
  filters: {
    dmOnly: boolean;
    unreadOnly: boolean;
  },
) {
  runtime.log(
    `Telegram user inbox completed. dialogs=${result.dialogs.length} unread_only=${filters.unreadOnly} dm_only=${filters.dmOnly} ${formatBackendMeta(result.backend_meta)}`,
  );
  if (result.dialogs.length === 0) {
    runtime.log("No Telegram user dialogs matched the requested filters.");
    return;
  }
  runtime.log(formatTelegramInbox(result.dialogs));
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

async function promptForValue(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Missing required value and no interactive TTY is available for prompt: ${prompt}`,
    );
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(prompt);
    const trimmed = answer.trim();
    if (!trimmed) {
      throw new Error(`Prompt returned an empty value for: ${prompt}`);
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

async function promptForSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Missing required secret and no interactive TTY is available for prompt: ${prompt}`,
    );
  }

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRawMode = stdin.isRaw;
    let secret = "";

    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.setRawMode) {
        stdin.setRawMode(Boolean(previousRawMode));
      }
      stdout.write("\n");
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const finish = () => {
      const trimmed = secret.trim();
      if (!trimmed) {
        fail(new Error(`Prompt returned an empty value for: ${prompt}`));
        return;
      }
      cleanup();
      resolve(trimmed);
    };

    // Read the password in raw mode so the terminal does not echo the secret
    // back to the screen while still allowing backspace and Ctrl+C handling.
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const char of text) {
        if (char === "\u0003") {
          fail(new Error("Telegram login prompt interrupted."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += char;
      }
    };

    stdout.write(prompt);
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function completeInteractiveTelegramUserLogin(
  opts: Record<string, unknown>,
): Promise<TelegramUserLoginResult> {
  const phone = readStringOpt(opts, "phone") ?? (await promptForValue("Telegram phone number: "));
  const initial = await runTelegramUserLogin({ ...resolveBackendOptions(opts), phone });
  if (initial.state === "ready") {
    return initial;
  }
  // One invocation submits at most one secret. Invalid, expired, and cooldown
  // results return to the caller instead of creating an unbounded prompt loop.
  if (initial.state === "awaiting_code") {
    return runTelegramUserLogin({
      ...resolveBackendOptions(opts),
      code: await promptForSecret("Telegram login code: "),
      phone,
    });
  }
  if (initial.state === "awaiting_password") {
    return runTelegramUserLogin({
      ...resolveBackendOptions(opts),
      password: await promptForSecret("Telegram 2FA password: "),
      phone,
    });
  }
  return assertNever(initial.state, "Unsupported Telegram login state");
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

export async function telegramUserStatusCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const result = await runTelegramUserStatus({
    ...resolveBackendOptions(opts),
    chat: readStringOpt(opts, "chat"),
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logStatusText(runtime, result);
}

export async function telegramUserDoctorCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const status = await runTelegramUserStatus({
    ...resolveBackendOptions(opts),
    chat: readStringOpt(opts, "chat"),
  });
  const result = buildTelegramUserDoctorResult(status);
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logDoctorText(runtime, result);
}

export async function telegramUserLoginCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const json = readBooleanOpt(opts, "json");
  const phone = readStringOpt(opts, "phone");
  const localSecret = await readLoginSecretFromStdin(readStringOpt(opts, "secretStdin"));
  const interactive = !json && !localSecret.code && !localSecret.password;
  if (json && !phone) {
    throw new Error("Telegram user login requires --phone when --json is enabled.");
  }
  const result = interactive
    ? await completeInteractiveTelegramUserLogin(opts)
    : await runTelegramUserLogin({
        ...resolveBackendOptions(opts),
        ...localSecret,
        phone: phone ?? (await promptForValue("Telegram phone number: ")),
      });
  if (json) {
    logJson(runtime, result);
    return;
  }
  logLoginText(runtime, result);
}

export async function telegramUserLogoutCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const result = await runTelegramUserLogout(resolveBackendOptions(opts));
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logLogoutText(runtime, result);
}

export async function telegramUserOwnerClaimCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const source = readStringOpt(opts, "source");
  if (!source) {
    throw new Error("Telegram user owner claim requires --source.");
  }
  const result = await runTelegramUserOwnerClaim({
    envFile: readStringOpt(opts, "envFile"),
    source,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logOwnerClaimText(runtime, result);
}

export async function telegramUserSendCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const chat = readStringOpt(opts, "chat");
  const message = readStringOpt(opts, "message");
  const media = readStringOpt(opts, "media");
  const caption = readStringOpt(opts, "caption");
  if (!chat || (!message && !media)) {
    throw new Error("Telegram user send requires --chat and either --message or --media.");
  }
  // Keep the old text path exact. When media is present, --message remains
  // useful as a caption alias so existing smoke snippets can grow a media flag
  // without changing their wording option.
  const mediaCaption = media ? (caption ?? message) : undefined;
  const target = resolveSendTarget(opts);
  const result = await runTelegramUserSend({
    ...resolveBackendOptions(opts),
    caption: mediaCaption,
    chat,
    media,
    message: media ? undefined : message,
    ...target,
    voice: readBooleanOpt(opts, "voice") || readBooleanOpt(opts, "audioAsVoice"),
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logSendText(runtime, result);
}

export async function telegramUserTopicListCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user topic-list requires --chat.");
  }
  const result = await runTelegramUserTopicList({
    ...resolveBackendOptions(opts),
    chat,
    limit: readNumberOpt(opts, "limit") ?? 50,
    query: readStringOpt(opts, "query"),
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logTopicListText(runtime, result);
}

export async function telegramUserButtonClickCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  const messageId = readPositiveIntegerOpt(
    opts,
    "messageId",
    "--message-id",
    "Telegram user button-click",
  );
  // Visible text and the hidden callback/URL value are exact-match safety
  // selectors. Preserve caller whitespace instead of normalizing any value.
  const buttonText = readExactStringOpt(opts, "buttonText");
  const expectedCallbackData = readExactStringOpt(opts, "expectedCallbackData");
  const expectedUrl = readExactStringOpt(opts, "expectedUrl");
  if (!chat || messageId === undefined || !buttonText) {
    throw new Error("Telegram user button-click requires --chat, --message-id, and --button-text.");
  }
  if (Boolean(expectedCallbackData) === Boolean(expectedUrl)) {
    throw new Error(
      "Telegram user button-click requires exactly one of --expected-callback-data or --expected-url.",
    );
  }
  const result = await runTelegramUserButtonClick({
    ...resolveBackendOptions(opts),
    buttonText,
    chat,
    expectedCallbackData,
    expectedUrl,
    messageId,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logButtonClickText(runtime, result);
}

export async function telegramUserTopicCreateCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  const title = readStringOpt(opts, "title");
  if (!chat || !title) {
    throw new Error("Telegram user topic-create requires --chat and --title.");
  }
  const result = await runTelegramUserTopicCreate({
    ...resolveBackendOptions(opts),
    chat,
    title,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logTopicCreateText(runtime, result);
}

export async function telegramUserTopicDeleteCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  const topicAnchor =
    readRequiredNumberOpt(opts, "topicAnchor", "--topic-anchor", "Telegram user topic-delete") ??
    readRequiredNumberOpt(opts, "topicId", "--topic-id", "Telegram user topic-delete");
  if (!chat || topicAnchor === undefined) {
    throw new Error("Telegram user topic-delete requires --chat and --topic-anchor.");
  }
  const result = await runTelegramUserTopicDelete({
    ...resolveBackendOptions(opts),
    chat,
    topicAnchor,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logTopicDeleteText(runtime, result);
}

export async function telegramUserTopicResolveCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  const title = readStringOpt(opts, "title");
  if (!chat || !title) {
    throw new Error("Telegram user topic-resolve requires --chat and --title.");
  }
  const result = await runTelegramUserTopicResolve({
    ...resolveBackendOptions(opts),
    chat,
    title,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logTopicResolveText(runtime, result);
}

export async function telegramUserReadCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user read requires --chat.");
  }
  const format = readTelegramReadFormat(opts);
  const topicAnchor = readPresentPositiveIntegerOpt(
    opts,
    "topicAnchor",
    "--topic-anchor",
    "Telegram user read",
  );
  const result = await runTelegramUserRead({
    ...resolveBackendOptions(opts),
    chat,
    limit: readNumberOpt(opts, "limit") ?? 20,
    afterId: readNumberOpt(opts, "afterId"),
    beforeId: readNumberOpt(opts, "beforeId"),
    contains: readStringOpt(opts, "contains"),
    topicAnchor,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, format === "compact" ? buildTelegramCompactReadResult(result, chat) : result);
    return;
  }
  if (format === "compact") {
    runtime.log(formatTelegramCompactMessages(result, chat));
    return;
  }
  logReadText(runtime, result);
}

export async function telegramUserMarkReadCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user mark-read requires --chat.");
  }
  const result = await runTelegramUserMarkRead({
    ...resolveBackendOptions(opts),
    chat,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logMarkReadText(runtime, result);
}

export async function telegramUserMarkUnreadCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user mark-unread requires --chat.");
  }
  const result = await runTelegramUserMarkUnread({
    ...resolveBackendOptions(opts),
    chat,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logMarkUnreadText(runtime, result);
}

export async function telegramUserDownloadCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const chat = readStringOpt(opts, "chat");
  const messageId = readNumberOpt(opts, "messageId");
  const output = readStringOpt(opts, "output");
  if (!chat || !messageId || !output) {
    throw new Error("Telegram user download requires --chat, --message-id, and --output.");
  }
  const result = await runTelegramUserDownload({
    ...resolveBackendOptions(opts),
    chat,
    messageId,
    output,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logDownloadText(runtime, result);
}

export async function telegramUserInboxCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const unreadOnly = readBooleanOpt(opts, "unread");
  const dmOnly = readBooleanOpt(opts, "dmOnly");
  const result = await runTelegramUserInbox({
    ...resolveBackendOptions(opts),
    contains: readStringOpt(opts, "contains"),
    dmOnly,
    limit: readNumberOpt(opts, "limit") ?? 20,
    unreadOnly,
  });
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logInboxText(runtime, result, { dmOnly, unreadOnly });
}

export async function telegramUserMonitorListenCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  // Keep the normal read/send/status path free of monitor-store and routing
  // dependencies. Those modules pull in a large gateway-oriented graph that a
  // one-shot MTProto command never uses and previously paid to load on every run.
  const { buildTelegramUserMonitorEventEnvelope, pickTelegramUserMonitorMessage } =
    await import("../telegram-user/monitor-event.js");
  const chat = readStringOpt(opts, "chat");
  if (!chat) {
    throw new Error("Telegram user monitor-listen requires --chat.");
  }
  const afterId = readRequiredNumberOpt(
    opts,
    "afterId",
    "--after-id",
    "Telegram user monitor-listen",
  );
  if (afterId === undefined) {
    throw new Error("Telegram user monitor-listen requires --after-id.");
  }

  const startedAt = Date.now();
  const timeoutMs = readNumberOpt(opts, "timeoutMs") ?? getTelegramUserDefaultWaitTimeoutMs();
  const pollIntervalMs =
    readNumberOpt(opts, "pollIntervalMs") ?? getTelegramUserDefaultPollIntervalMs();
  const limit = readNumberOpt(opts, "limit") ?? 80;
  const contains = readStringOpt(opts, "contains");
  const threadAnchor = readNumberOpt(opts, "threadAnchor");
  const accountId = readStringOpt(opts, "accountId");

  // One-shot by design: this proves the listener envelope without claiming
  // daemon persistence, gateway dispatch, or durable cursor semantics.
  while (Date.now() - startedAt < timeoutMs) {
    const readResult = await runTelegramUserRead({
      ...resolveBackendOptions(opts),
      afterId,
      chat,
      contains,
      limit,
    });
    const message = pickTelegramUserMonitorMessage(readResult.messages, {
      afterId,
      contains,
      threadAnchor,
    });
    if (message) {
      logJson(
        runtime,
        buildTelegramUserMonitorEventEnvelope(message, {
          accountId,
          chat,
        }),
      );
      return;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Telegram user monitor-listen timed out after ${timeoutMs}ms (chat=${chat}, afterId=${afterId}).`,
  );
}

export async function telegramUserMonitorPollCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  // Monitor polling genuinely needs the durable store, listener health, and
  // hook routing graph. Load it only after this specific command is selected so
  // read/send/doctor startup remains proportional to the work requested.
  const [listenerHealth, monitorHook, monitorListener] = await Promise.all([
    import("../monitor/listener-health.js"),
    import("../telegram-user/monitor-hook-url.js"),
    import("../telegram-user/monitor-listener.js"),
  ]);
  const { classifyFatalListenerHealthError, resolveListenerHealthStorePath, updateListenerHealth } =
    listenerHealth;
  const { resolveLocalTelegramMonitorHookUrl } = monitorHook;
  const { pollTelegramUserMonitorEvents } = monitorListener;
  const hookUrl = readStringOpt(opts, "hookUrl");
  const localHookUrl = hookUrl ? resolveLocalTelegramMonitorHookUrl(hookUrl) : undefined;
  const commitWithoutDispatch = readBooleanOpt(opts, "commitWithoutDispatch");
  const loop = readBooleanOpt(opts, "watch");
  const maxRuns = readPositiveIntegerOpt(
    opts,
    "maxRuns",
    "--max-runs",
    "Telegram user monitor-poll",
  );
  const pollIntervalMs =
    readPositiveIntegerOpt(
      opts,
      "pollIntervalMs",
      "--poll-interval-ms",
      "Telegram user monitor-poll",
    ) ?? getTelegramUserDefaultPollIntervalMs();

  if (loop && !localHookUrl && !commitWithoutDispatch) {
    throw new Error(
      "Telegram user monitor-poll --watch requires --hook-url or --commit-without-dispatch so matched events can advance the cursor.",
    );
  }

  const basePollOptions = {
    ...resolveBackendOptions(opts),
    commitWithoutDispatch,
    cronStorePath: readStringOpt(opts, "cronStore"),
    cursorStorePath: readStringOpt(opts, "cursorStore"),
    limit: readNumberOpt(opts, "limit") ?? 80,
    monitorStorePath: readStringOpt(opts, "monitorStore"),
    dispatchEvent: localHookUrl
      ? async (context: TelegramUserMonitorPollDispatchContext) =>
          postTelegramUserMonitorEventHook(context, opts, localHookUrl)
      : undefined,
  };

  const listenerStartedAtMs = Date.now();
  const listenerInstanceId = /^[a-f0-9]{48}$/u.test(
    process.env.OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE ?? "",
  )
    ? process.env.OPENCLAW_TELEGRAM_LIVE_MONITOR_LISTENER_INSTANCE
    : undefined;
  const healthStorePath = loop
    ? resolveListenerHealthStorePath({
        cronStorePath: basePollOptions.cronStorePath,
        env: process.env,
        monitorStorePath: basePollOptions.monitorStorePath,
      })
    : undefined;

  const reportHealthTransition = (snapshot: ListenerHealthSnapshot) => {
    if (snapshot.transition === "degraded") {
      runtime.error(
        `Telegram listener health degraded: ${snapshot.record.lastError ?? "listener check failed"}`,
      );
    } else if (snapshot.transition === "recovered") {
      runtime.log("Telegram listener health recovered.");
    }
  };
  let healthPersistenceWarningEmitted = false;
  const persistHealth = async (input: Parameters<typeof updateListenerHealth>[0]) => {
    try {
      const snapshot = await updateListenerHealth(input);
      healthPersistenceWarningEmitted = false;
      reportHealthTransition(snapshot);
    } catch {
      // Health is observability, not routing authority. A permission or lock
      // failure must not stop matching, dispatch, or cursor commits, and the
      // in-process latch prevents a once-per-second warning loop.
      if (!healthPersistenceWarningEmitted) {
        runtime.error("Telegram listener health persistence unavailable.");
        healthPersistenceWarningEmitted = true;
      }
    }
  };

  for (let runNumber = 1; ; runNumber += 1) {
    let result: TelegramUserMonitorPollResult;
    try {
      result = await pollTelegramUserMonitorEvents(basePollOptions);
    } catch (err) {
      // Preserve the existing supervisor restart behavior, but first leave a
      // bounded durable explanation for status. A failed health write must not
      // replace the original listener failure that operators need to diagnose.
      if (healthStorePath) {
        await persistHealth({
          check: "failure",
          error: classifyFatalListenerHealthError(err),
          owner: {
            ...(listenerInstanceId ? { instanceId: listenerInstanceId } : {}),
            pid: process.pid,
            profile: process.env.OPENCLAW_PROFILE,
            startedAtMs: listenerStartedAtMs,
          },
          pollIntervalMs,
          service: "telegram-user",
          storePath: healthStorePath,
        });
      }
      throw err;
    }

    if (healthStorePath) {
      const operationalErrors = result.skipped.filter(
        (skip) => skip.reason === "read_error" || skip.reason === "dispatch_error",
      );
      await persistHealth({
        check: operationalErrors.length > 0 ? "failure" : "success",
        // Reason codes are useful operational evidence; backend error text is
        // not. It may contain message bodies, selectors, paths, or credentials.
        error: operationalErrors.map((skip) => skip.reason).join(","),
        owner: {
          ...(listenerInstanceId ? { instanceId: listenerInstanceId } : {}),
          pid: process.pid,
          profile: process.env.OPENCLAW_PROFILE,
          startedAtMs: listenerStartedAtMs,
        },
        pollIntervalMs,
        routedEvent: result.dispatched > 0,
        service: "telegram-user",
        storePath: healthStorePath,
      });
    }
    if (readBooleanOpt(opts, "json")) {
      logJson(runtime, loop ? { run: runNumber, ...result } : result);
    } else {
      runtime.log(formatTelegramMonitorPollText(result, loop ? runNumber : undefined));
    }

    if (!loop || (maxRuns !== undefined && runNumber >= maxRuns)) {
      return;
    }
    await sleep(pollIntervalMs);
  }
}

export async function telegramUserWaitCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  // Waiting adds polling semantics that ordinary one-shot commands do not need.
  // Defer that module until `wait` is actually invoked.
  const { runTelegramUserWait } = await import("../telegram-user/wait.js");
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
    pollIntervalMs: readNumberOpt(opts, "pollIntervalMs"),
    senderId: readNumberOpt(opts, "senderId") ?? 0,
    threadAnchor: readNumberOpt(opts, "threadAnchor") ?? 0,
    timeoutMs: readNumberOpt(opts, "timeoutMs"),
  };
  const result = await runTelegramUserWait(params);
  if (readBooleanOpt(opts, "json")) {
    logJson(runtime, result);
    return;
  }
  logWaitText(runtime, result);
}
