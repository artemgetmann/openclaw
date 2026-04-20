import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function withTelegramUserBase(command: Command) {
  return command
    .option("--env-file <path>", "Read Telegram user creds from this env file")
    .option("--session <path>", "Override Telethon session path")
    .option("--json", "Output JSON", false);
}

function runTelegramUserCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerTelegramUserCli(program: Command) {
  const telegramUser = program
    .command("telegram-user")
    .description(
      "Telegram-as-me MTProto tooling for login, session health, and real-account messaging",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            'pnpm openclaw:local telegram-user login --phone "+15551234567"',
            "Start login, prompt for OTP/2FA when needed, and store the session locally.",
          ],
          [
            'OPENCLAW_TELEGRAM_USER_LOGIN_PASSWORD="hunter2" pnpm openclaw:local telegram-user login --phone "+15551234567" --code 12345 --json',
            "Finish a 2FA step non-interactively without exposing the password in process arguments.",
          ],
          [
            "pnpm openclaw:local telegram-user status --json",
            "Inspect whether the Telegram-as-me session is ready, expired, or awaiting reauth.",
          ],
          [
            'pnpm openclaw:local telegram-user send --chat @jarvis_tester_1_bot --message "hello"',
            "Send as the Telegram user account.",
          ],
          [
            "pnpm openclaw:local telegram-user read --chat @jarvis_tester_1_bot --limit 5 --json",
            "Read recent DM messages with raw metadata.",
          ],
          [
            "pnpm openclaw:local telegram-user inbox --unread --dm-only --limit 10 --json",
            "List inbox dialogs for unread DM triage with raw metadata.",
          ],
          [
            "pnpm openclaw:local telegram-user wait --chat @jarvis_tester_1_bot --after-id 123 --sender-id 456 --json",
            "Wait for a matching reply with structured diagnostics.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/channels/telegram",
          "docs.openclaw.ai/channels/telegram",
        )}\n`,
    )
    .action(() => {
      telegramUser.help({ error: true });
    });

  withTelegramUserBase(
    telegramUser
      .command("status")
      .description("Inspect Telegram user login/session state and optional chat resolution"),
  )
    .option("--chat <target>", "Resolve and validate this chat target when session is healthy")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserStatusCommand } = await import("../commands/telegram-user.js");
        await telegramUserStatusCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("login")
      .description("Connect a real Telegram account and persist the local user session"),
  )
    .option("--phone <e164>", "Telegram phone number in international format")
    .option("--code <otp>", "Telegram login code from Telegram")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserLoginCommand } = await import("../commands/telegram-user.js");
        await telegramUserLoginCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("logout")
      .description("Clear the persisted Telegram user session and pending login state"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserLogoutCommand } = await import("../commands/telegram-user.js");
      await telegramUserLogoutCommand(opts, defaultRuntime);
    });
  });

  withTelegramUserBase(
    telegramUser
      .command("precheck")
      .description("Validate Telegram user session and optional chat"),
  )
    .option("--chat <target>", "Resolve and validate this chat target")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserPrecheckCommand } = await import("../commands/telegram-user.js");
        await telegramUserPrecheckCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("send")
      .description("Send a Telegram DM or message as the user account")
      .requiredOption("--chat <target>", "Target chat username or id")
      .requiredOption("--message <text>", "Message body"),
  )
    .option("--reply-to <id>", "Reply to this message id")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserSendCommand } = await import("../commands/telegram-user.js");
        await telegramUserSendCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("read")
      .description("Read recent Telegram user-visible messages with thread metadata")
      .requiredOption("--chat <target>", "Target chat username or id"),
  )
    .option("--limit <n>", "Read up to this many recent messages", "20")
    .option("--after-id <id>", "Only include messages newer than this id")
    .option("--before-id <id>", "Only include messages older than this id")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserReadCommand } = await import("../commands/telegram-user.js");
        await telegramUserReadCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser.command("inbox").description("List Telegram dialogs with unread triage metadata"),
  )
    .option("--unread", "Only include dialogs with unread counts, mentions, or reactions", false)
    .option("--dm-only", "Only include direct-message dialogs", false)
    .option("--limit <n>", "List up to this many dialogs", "20")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserInboxCommand } = await import("../commands/telegram-user.js");
        await telegramUserInboxCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("wait")
      .description("Poll recent Telegram messages until a reply matches")
      .requiredOption("--chat <target>", "Target chat username or id"),
  )
    .option("--after-id <id>", "Only consider messages newer than this id", "0")
    .option("--sender-id <id>", "Require this sender id", "0")
    .option("--thread-anchor <id>", "Match reply_to_top_id, reply_to_msg_id, or DM topic id")
    .option("--contains <text>", "Require this substring")
    .option("--limit <n>", "Read up to this many recent messages per poll", "80")
    .option("--timeout-ms <ms>", "Overall wait timeout in milliseconds", "45000")
    .option("--poll-interval-ms <ms>", "Polling interval in milliseconds", "1000")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserWaitCommand } = await import("../commands/telegram-user.js");
        await telegramUserWaitCommand(opts, defaultRuntime);
      });
    });
}
