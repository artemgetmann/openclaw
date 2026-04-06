import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

export function registerTelegramCli(program: Command) {
  const telegram = program
    .command("telegram")
    .description("Operator workflows for Telegram live runtime checks and smoke tests")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw telegram doctor --chat @jarvis_consumer_bot", "Validate this worktree lane."],
          ["openclaw telegram runtime ensure", "Ensure the isolated Telegram tester runtime."],
          [
            "openclaw telegram smoke dm-reply --chat @jarvis_consumer_bot --json",
            "Send one DM and wait for a real reply with proof output.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/channels/telegram",
          "docs.openclaw.ai/channels/telegram",
        )}\n`,
    )
    .action(() => {
      telegram.help({ error: true });
    });

  telegram
    .command("doctor")
    .description("Validate worktree ownership, runtime health, and Telegram userbot readiness")
    .option("--env-file <path>", "Read Telegram user creds from this env file")
    .option("--session <path>", "Override Telethon session path")
    .option("--chat <target>", "Validate this Telegram chat target")
    .option("--topic-id <id>", "Validate this topic/thread id when relevant")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { telegramDoctorCommand } = await import("../commands/telegram.js");
        await telegramDoctorCommand(opts, defaultRuntime);
      });
    });

  const runtime = telegram
    .command("runtime")
    .description("Manage the isolated Telegram live runtime for this worktree")
    .action(() => {
      runtime.help({ error: true });
    });

  runtime
    .command("ensure")
    .description("Ensure this worktree owns a healthy isolated Telegram runtime")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { telegramRuntimeEnsureCommand } = await import("../commands/telegram.js");
        await telegramRuntimeEnsureCommand(opts, defaultRuntime);
      });
    });

  runtime
    .command("release")
    .description("Release this worktree runtime and tester bot claim")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { telegramRuntimeReleaseCommand } = await import("../commands/telegram.js");
        await telegramRuntimeReleaseCommand(opts, defaultRuntime);
      });
    });

  const smoke = telegram
    .command("smoke")
    .description("Run Telegram live smoke scenarios with stable proof output")
    .action(() => {
      smoke.help({ error: true });
    });

  smoke
    .command("dm-reply")
    .description("Send one DM and wait for the first real reply")
    .requiredOption("--chat <target>", "Target chat username or id")
    .option("--env-file <path>", "Read Telegram user creds from this env file")
    .option("--session <path>", "Override Telethon session path")
    .option("--message <text>", "Override the smoke message text")
    .option("--text <message>", "Override the smoke message text")
    .option("--timeout <seconds>", "Reply timeout in seconds", "120")
    .option("--topic-id <id>", "Optional topic/thread anchor")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { telegramSmokeDmReplyCommand } = await import("../commands/telegram.js");
        await telegramSmokeDmReplyCommand(opts, defaultRuntime);
      });
    });
}
