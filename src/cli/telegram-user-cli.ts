import { Option, type Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { discoverTelegramUserRuntimeEnv } from "../telegram-user/runtime-env.js";
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
  return runCommandWithRuntime(
    defaultRuntime,
    async () => {
      await discoverTelegramUserRuntimeEnv();
      await action();
    },
    (err) => {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    },
  );
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
            'openclaw telegram-user login --phone "+15551234567"',
            "Start login, prompt for OTP/2FA when needed, and store the session locally.",
          ],
          [
            "openclaw telegram-user status --json",
            "Inspect whether the Telegram-as-me session is ready, expired, or awaiting reauth.",
          ],
          [
            "openclaw telegram-user doctor --json",
            "Explain setup state and next steps without repairing or exposing secrets.",
          ],
          [
            'openclaw telegram-user send --chat @jarvis_tester_1_bot --message "hello"',
            "Send as the Telegram user account.",
          ],
          [
            "printf '%s' \"$message\" | openclaw telegram-user send --chat @jarvis_tester_1_bot --message-file -",
            "Send generated or multiline text without shell escape rewriting.",
          ],
          [
            "printf '%s' \"$caption\" | openclaw telegram-user send --chat @jarvis_tester_1_bot --media /tmp/proof.pdf --caption-file -",
            "Send a generated media caption without shell escape rewriting.",
          ],
          [
            'openclaw telegram-user send --chat -1003783709877 --topic-anchor 15250 --message "hello topic" --json',
            "Send into a forum topic by using the topic anchor returned by topic-create.",
          ],
          [
            'openclaw telegram-user topic-create --chat -1003783709877 --title "voice proof" --json',
            "Create a forum topic and return its topic anchor for follow-up replies.",
          ],
          [
            "openclaw telegram-user topic-delete --chat -1003783709877 --topic-anchor 15250 --json",
            "Delete a temporary forum topic after bounded live proof cleanup.",
          ],
          [
            'openclaw telegram-user topic-resolve --chat -1003783709877 --title "Gmail Keychain Auth RCA" --json',
            "Resolve one exact forum-topic title to its authoritative topic anchor.",
          ],
          [
            "openclaw telegram-user read --chat -1003783709877 --topic-anchor 15250 --limit 20 --format compact",
            "Read only one validated forum topic; messages from sibling topics cannot leak in.",
          ],
          [
            "openclaw telegram-user read --chat @jarvis_tester_1_bot --contains proof --limit 5 --format compact",
            "Read matching recent DM messages in compact agent-friendly rows; add --json only when raw metadata is needed.",
          ],
          [
            "openclaw telegram-user mark-read --chat @jarvis_tester_1_bot --json",
            "Acknowledge the chat's current message history as read.",
          ],
          [
            "openclaw telegram-user mark-unread --chat @jarvis_tester_1_bot --json",
            "Set the dialog unread flag without rewinding message history.",
          ],
          [
            "openclaw telegram-user download --chat @jarvis_tester_1_bot --message-id 52830 --output /tmp/openclaw-media --json",
            "Download media from a known Telegram message id before running generic media tools.",
          ],
          [
            'openclaw telegram-user button-click --chat @jarvis_tester_1_bot --message-id 52831 --button-text "Queue" --expected-callback-data "queue:proof" --json',
            "Click only when one exact message has exactly one button matching both visible text and callback data.",
          ],
          [
            'openclaw telegram-user button-click --chat @jarvis_tester_1_bot --message-id 52832 --button-text "Participant chat" --expected-url "https://t.me/+exact-invite" --json',
            "Join one exact Telegram public chat or invite without opening a browser.",
          ],
          [
            "openclaw telegram-user inbox --contains Artem --unread --dm-only --limit 10 --json",
            "List matching inbox dialogs for unread DM triage with raw metadata.",
          ],
          [
            "openclaw telegram-user wait --chat @jarvis_tester_1_bot --after-id 123 --sender-id 456 --json",
            "Wait for a matching reply with structured diagnostics.",
          ],
          [
            "openclaw telegram-user monitor-listen --chat @jarvis_tester_1_bot --after-id 123 --json",
            "Read until one new inbound Telegram-as-me message appears, then print a monitor event envelope.",
          ],
          [
            "openclaw telegram-user monitor-poll --watch --cron-store /tmp/cron.json --hook-url http://127.0.0.1:18789/hooks/telegram-user-monitor-event --json",
            "Poll durable goal-bound Telegram-as-me monitors in the foreground, dispatching through the gateway hook only when configured.",
          ],
          [
            "openclaw telegram-user monitor-service install --hook-url http://127.0.0.1:18789/hooks/telegram-user-monitor-event",
            "Install the foreground monitor poller as an opt-in supervised service.",
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
      .command("topic-resolve")
      .description("Resolve one exact Telegram forum-topic title to its authoritative anchor")
      .requiredOption("--chat <target>", "Target forum chat username or id")
      .requiredOption("--title <title>", "Exact forum topic title"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserTopicResolveCommand } = await import("../commands/telegram-user.js");
      await telegramUserTopicResolveCommand(opts, defaultRuntime);
    });
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
      .command("doctor")
      .description("Explain Telegram-as-me setup state and next steps without repairing it"),
  )
    .option("--chat <target>", "Resolve and validate this chat target when session is healthy")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserDoctorCommand } = await import("../commands/telegram-user.js");
        await telegramUserDoctorCommand(opts, defaultRuntime);
      });
    });

  const owner = telegramUser
    .command("owner")
    .description("Inspect or claim the one machine-wide Telegram user-session owner")
    .action(() => {
      owner.help({ error: true });
    });

  owner
    .command("claim")
    .description("Claim one existing authorized owner without moving credentials")
    .requiredOption("--source <name>", "Recognized candidate source from an ambiguity diagnostic")
    .option("--env-file <path>", "Read Telegram user creds from this env file")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserOwnerClaimCommand } = await import("../commands/telegram-user.js");
        await telegramUserOwnerClaimCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("login")
      .description("Connect a real Telegram account and persist the local user session"),
  )
    .option("--phone <e164>", "Telegram phone number in international format")
    // Internal bridge for the macOS SecureField. Hiding this prevents the
    // product from advertising a generic agent/tool secret-submission surface.
    .addOption(new Option("--secret-stdin <kind>").hideHelp())
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
      .option("--message <text>", "Single-line message body, or caption when --media is present")
      .option(
        "--message-file <path>",
        "Read the exact message body from a UTF-8 file; use - for stdin",
      ),
  )
    .option("--media <path-or-url>", "Upload this media file or URL")
    .option(
      "--caption <text>",
      "Single-line caption for --media; overrides --message when both are present",
    )
    .option(
      "--caption-file <path>",
      "Read the exact media caption from a UTF-8 file; use - for stdin",
    )
    .option("--voice", "Send uploaded audio as a Telegram voice note", false)
    .option("--audio-as-voice", "Alias for --voice", false)
    .option("--reply-to <id>", "Reply to this message id")
    .option("--topic-anchor <id>", "Forum topic anchor returned by topic-create")
    .option("--topic-id <id>", "Alias for --topic-anchor")
    .action(async (opts) => {
      const { telegramUserSendCommand, validateTelegramSendInputShape } =
        await import("../commands/telegram-user.js");
      // Reject unsafe inline text before runtime discovery touches the shared
      // Telegram session owner or its machine lock.
      validateTelegramSendInputShape(opts);
      await runTelegramUserCommand(async () => {
        await telegramUserSendCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("topic-create")
      .description("Create a Telegram forum topic as the user account")
      .requiredOption("--chat <target>", "Target forum chat username or id")
      .requiredOption("--title <title>", "Forum topic title"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserTopicCreateCommand } = await import("../commands/telegram-user.js");
      await telegramUserTopicCreateCommand(opts, defaultRuntime);
    });
  });

  withTelegramUserBase(
    telegramUser
      .command("topic-delete")
      .description("Delete a Telegram forum topic by anchor as the user account")
      .requiredOption("--chat <target>", "Target forum chat username or id")
      .option("--topic-anchor <id>", "Forum topic anchor returned by topic-create")
      .option("--topic-id <id>", "Alias for --topic-anchor"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserTopicDeleteCommand } = await import("../commands/telegram-user.js");
      await telegramUserTopicDeleteCommand(opts, defaultRuntime);
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
    .option("--contains <text>", "Only include messages containing this substring")
    .option("--topic-anchor <id>", "Read only this validated forum topic")
    .option("--format <format>", "Output format: table or compact", "table")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserReadCommand } = await import("../commands/telegram-user.js");
        await telegramUserReadCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("download")
      .description("Download media from one Telegram message by chat and message id")
      .requiredOption("--chat <target>", "Target chat username or id")
      .requiredOption("--message-id <id>", "Message id containing downloadable media")
      .requiredOption("--output <path>", "Output file path or directory"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserDownloadCommand } = await import("../commands/telegram-user.js");
      await telegramUserDownloadCommand(opts, defaultRuntime);
    });
  });

  withTelegramUserBase(
    telegramUser
      .command("button-click")
      .description("Select one exact inline callback or URL button on one exact Telegram message")
      .requiredOption("--chat <target>", "Exact target chat username or id")
      .requiredOption("--message-id <id>", "Exact positive message id")
      .requiredOption("--button-text <text>", "Exact visible button text")
      .option(
        "--expected-callback-data <data>",
        "Exact UTF-8 callback data expected behind the button",
      )
      .option(
        "--expected-url <url>",
        "Exact Telegram public-chat or invite URL to join without opening a browser",
      ),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserButtonClickCommand } = await import("../commands/telegram-user.js");
      await telegramUserButtonClickCommand(opts, defaultRuntime);
    });
  });

  withTelegramUserBase(
    telegramUser
      .command("mark-read")
      .description("Acknowledge current Telegram chat history as read")
      .requiredOption("--chat <target>", "Target chat username or id"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserMarkReadCommand } = await import("../commands/telegram-user.js");
      await telegramUserMarkReadCommand(opts, defaultRuntime);
    });
  });

  withTelegramUserBase(
    telegramUser
      .command("mark-unread")
      .description("Set the Telegram dialog unread flag")
      .requiredOption("--chat <target>", "Target chat username or id"),
  ).action(async (opts) => {
    await runTelegramUserCommand(async () => {
      const { telegramUserMarkUnreadCommand } = await import("../commands/telegram-user.js");
      await telegramUserMarkUnreadCommand(opts, defaultRuntime);
    });
  });

  withTelegramUserBase(
    telegramUser.command("inbox").description("List Telegram dialogs with unread triage metadata"),
  )
    .option("--unread", "Only include dialogs with unread counts, mentions, or reactions", false)
    .option("--dm-only", "Only include direct-message dialogs", false)
    .option("--limit <n>", "List up to this many dialogs", "20")
    .option("--contains <text>", "Only include dialogs whose title, username, or last text matches")
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

  withTelegramUserBase(
    telegramUser
      .command("monitor-listen")
      .description("Poll until one new inbound message appears and emit a monitor event envelope")
      .requiredOption("--chat <target>", "Target chat username or id")
      .requiredOption("--after-id <id>", "Only consider messages newer than this id"),
  )
    .option("--account-id <id>", "Optional Telegram-as-me account id for routing")
    .option("--thread-anchor <id>", "Match reply_to_top_id, reply_to_msg_id, or DM topic id")
    .option("--contains <text>", "Require this substring")
    .option("--limit <n>", "Read up to this many recent messages per poll", "80")
    .option("--timeout-ms <ms>", "Overall listen timeout in milliseconds", "45000")
    .option("--poll-interval-ms <ms>", "Polling interval in milliseconds", "1000")
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserMonitorListenCommand } = await import("../commands/telegram-user.js");
        await telegramUserMonitorListenCommand(opts, defaultRuntime);
      });
    });

  withTelegramUserBase(
    telegramUser
      .command("monitor-poll")
      .description("Poll durable goal-bound Telegram-as-me monitor cursors once"),
  )
    .option("--cron-store <path>", "Cron store path; monitor/cursor stores default beside it")
    .option("--monitor-store <path>", "Monitor store path; overrides derivation from --cron-store")
    .option("--cursor-store <path>", "Cursor store path; overrides derivation from monitor store")
    .option("--hook-url <url>", "Full gateway hook URL for dispatching matched monitor events")
    .option("--hook-token <token>", "Bearer token for --hook-url")
    .option("--limit <n>", "Read up to this many recent messages per monitor", "80")
    .option("--watch", "Keep polling in the foreground until interrupted", false)
    .option("--poll-interval-ms <ms>", "Delay between --watch polls", "1000")
    .option("--max-runs <n>", "Stop --watch after this many polls; intended for smoke tests")
    .option(
      "--commit-without-dispatch",
      "Advance event cursors without dispatching; intended for explicit observe-only maintenance",
      false,
    )
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { telegramUserMonitorPollCommand } = await import("../commands/telegram-user.js");
        await telegramUserMonitorPollCommand(opts, defaultRuntime);
      });
    });

  const monitorService = telegramUser
    .command("monitor-service")
    .description("Install and manage the Telegram-as-me monitor poller service");

  monitorService
    .command("status")
    .description("Show Telegram monitor service status")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { runTelegramMonitorServiceStatus } =
          await import("./telegram-user-monitor-service.js");
        await runTelegramMonitorServiceStatus(opts);
      });
    });

  monitorService
    .command("install")
    .description("Install the Telegram monitor poller service (launchd/systemd)")
    .option("--cron-store <path>", "Cron store path; monitor/cursor stores default beside it")
    .option("--monitor-store <path>", "Monitor store path; overrides derivation from --cron-store")
    .option("--cursor-store <path>", "Cursor store path; overrides derivation from monitor store")
    .option("--env-file <path>", "Read Telegram user creds from this env file")
    .option("--session <path>", "Override Telethon session path")
    .option("--hook-url <url>", "Gateway hook URL for dispatching matched monitor events")
    .option("--poll-interval-ms <ms>", "Delay between poll runs", "1000")
    .option("--limit <n>", "Read up to this many recent messages per monitor", "80")
    .option("--runtime <runtime>", "Service runtime (node|bun). Default: node")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { runTelegramMonitorServiceInstall } =
          await import("./telegram-user-monitor-service.js");
        await runTelegramMonitorServiceInstall(opts);
      });
    });

  monitorService
    .command("uninstall")
    .description("Uninstall the Telegram monitor poller service")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { runTelegramMonitorServiceUninstall } =
          await import("./telegram-user-monitor-service.js");
        await runTelegramMonitorServiceUninstall(opts);
      });
    });

  monitorService
    .command("stop")
    .description("Stop the Telegram monitor poller service")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { runTelegramMonitorServiceStop } =
          await import("./telegram-user-monitor-service.js");
        await runTelegramMonitorServiceStop(opts);
      });
    });

  monitorService
    .command("restart")
    .description("Restart the Telegram monitor poller service")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runTelegramUserCommand(async () => {
        const { runTelegramMonitorServiceRestart } =
          await import("./telegram-user-monitor-service.js");
        await runTelegramMonitorServiceRestart(opts);
      });
    });
}
