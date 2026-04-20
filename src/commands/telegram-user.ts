import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { RuntimeEnv } from "../runtime.js";
import {
  runTelegramUserLogin,
  runTelegramUserLogout,
  runTelegramUserPrecheck,
  runTelegramUserRead,
  runTelegramUserSend,
  runTelegramUserStatus,
} from "../telegram-user/backend.js";
import type {
  TelegramUserAuthStatus,
  TelegramUserBackendMeta,
  TelegramUserBackendOptions,
  TelegramUserLoginResult,
  TelegramUserMessage,
  TelegramUserLogoutResult,
  TelegramUserPrecheck,
  TelegramUserReadResult,
  TelegramUserSendResult,
  TelegramUserWaitParams,
  TelegramUserWaitResult,
} from "../telegram-user/types.js";
import { runTelegramUserWait } from "../telegram-user/wait.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";

const loginPasswordEnvKey = "OPENCLAW_TELEGRAM_USER_LOGIN_PASSWORD";

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

function readLoginPasswordFromEnv(): string | undefined {
  const raw = process.env[loginPasswordEnvKey];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
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
  let currentOpts: Record<string, unknown> = {
    ...opts,
    phone,
  };

  while (true) {
    const result = await runTelegramUserLogin({
      ...resolveBackendOptions(currentOpts),
      code: readStringOpt(currentOpts, "code"),
      password: readStringOpt(currentOpts, "password"),
      phone,
    });
    if (result.state === "ready") {
      return result;
    }
    if (result.state === "awaiting_code") {
      currentOpts = {
        ...currentOpts,
        code: await promptForValue("Telegram login code: "),
      };
      continue;
    }
    if (result.state === "awaiting_password") {
      currentOpts = {
        ...currentOpts,
        password: await promptForSecret("Telegram 2FA password: "),
      };
      continue;
    }
    assertNever(result.state, "Unsupported Telegram login state");
  }
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

export async function telegramUserLoginCommand(opts: Record<string, unknown>, runtime: RuntimeEnv) {
  const json = readBooleanOpt(opts, "json");
  const phone = readStringOpt(opts, "phone");
  const code = readStringOpt(opts, "code");
  const password = readLoginPasswordFromEnv();
  const interactive = !json && !code && !password;
  if (json && !phone) {
    throw new Error("Telegram user login requires --phone when --json is enabled.");
  }
  const result = interactive
    ? await completeInteractiveTelegramUserLogin(opts)
    : await runTelegramUserLogin({
        ...resolveBackendOptions(opts),
        code,
        password,
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
