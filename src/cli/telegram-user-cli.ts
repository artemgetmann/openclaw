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
    .description("Operator-grade Telegram user MTProto tooling for local E2E")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            'pnpm openclaw:local telegram-user send --chat @jarvis_tester_1_bot --message "hello"',
            "Send as the Telegram user account.",
          ],
          [
            "pnpm openclaw:local telegram-user read --chat @jarvis_tester_1_bot --limit 5 --json",
            "Read recent DM messages with raw metadata.",
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
