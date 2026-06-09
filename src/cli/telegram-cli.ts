import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function addTelegramHarnessOptions(command: Command, { requireChat }: { requireChat: boolean }) {
  // Keep every live harness entrypoint on the same option surface so scenario
  // implementations can derive the tester bot/chat when the operator omits it.
  const withChat = requireChat
    ? command.requiredOption("--chat <target>", "Target chat username or id")
    : command.option("--chat <target>", "Target chat username or id");

  return withChat
    .option("--env-file <path>", "Read Telegram user creds from this env file")
    .option("--session <path>", "Override Telethon session path")
    .option("--message <text>", "Override the smoke message text")
    .option("--text <message>", "Override the smoke message text")
    .option("--timeout <seconds>", "Reply timeout in seconds", "120")
    .option("--topic-id <id>", "Optional topic/thread anchor")
    .option("--deterministic", "Use deterministic product-path injection when supported", false)
    .option("--json", "Output JSON", false);
}

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
          [
            "openclaw telegram scenario progress-plus-tts --json",
            "Run a reusable live scenario against the claimed tester bot.",
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

  addTelegramHarnessOptions(
    smoke.command("dm-reply").description("Send one DM and wait for the first real reply"),
    {
      requireChat: true,
    },
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const { telegramSmokeDmReplyCommand } = await import("../commands/telegram.js");
      await telegramSmokeDmReplyCommand(opts, defaultRuntime);
    });
  });

  addTelegramHarnessOptions(
    smoke
      .command("baseline")
      .description("Run the reusable Telegram baseline smoke against the claimed tester bot"),
    { requireChat: false },
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const { telegramSmokeBaselineCommand } = await import("../commands/telegram.js");
      await telegramSmokeBaselineCommand(opts, defaultRuntime);
    });
  });

  const scenario = telegram
    .command("scenario")
    .description("Run reusable Telegram live E2E scenarios with stable proof output")
    .action(() => {
      scenario.help({ error: true });
    });

  addTelegramHarnessOptions(
    scenario
      .command("tts-final-caption")
      .description("Run the TTS final-caption Telegram live scenario"),
    { requireChat: false },
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const { telegramScenarioTtsFinalCaptionCommand } = await import("../commands/telegram.js");
      await telegramScenarioTtsFinalCaptionCommand(opts, defaultRuntime);
    });
  });

  addTelegramHarnessOptions(
    scenario
      .command("progress-long-task")
      .description("Run the progress long-task Telegram live scenario"),
    { requireChat: false },
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const { telegramScenarioProgressLongTaskCommand } = await import("../commands/telegram.js");
      await telegramScenarioProgressLongTaskCommand(opts, defaultRuntime);
    });
  });

  addTelegramHarnessOptions(
    scenario
      .command("progress-plus-tts")
      .description("Run the progress-plus-TTS Telegram live scenario"),
    { requireChat: false },
  ).action(async (opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const { telegramScenarioProgressPlusTtsCommand } = await import("../commands/telegram.js");
      await telegramScenarioProgressPlusTtsCommand(opts, defaultRuntime);
    });
  });
}
