import { Command, Option } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramUserButtonClickCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserInboxCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserDoctorCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserMonitorListenCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserMonitorPollCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserMarkReadCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserMarkUnreadCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserReadCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserDownloadCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserSendCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserTopicCreateCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserTopicDeleteCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserTopicResolveCommand = vi.fn().mockResolvedValue(undefined);
const runTelegramMonitorServiceInstall = vi.fn().mockResolvedValue(undefined);
const runTelegramMonitorServiceRestart = vi.fn().mockResolvedValue(undefined);
const runTelegramMonitorServiceStatus = vi.fn().mockResolvedValue(undefined);
const runTelegramMonitorServiceStop = vi.fn().mockResolvedValue(undefined);
const runTelegramMonitorServiceUninstall = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/telegram-user.js", () => ({
  telegramUserButtonClickCommand,
  telegramUserDoctorCommand,
  telegramUserInboxCommand,
  telegramUserMonitorListenCommand,
  telegramUserMonitorPollCommand,
  telegramUserMarkReadCommand,
  telegramUserMarkUnreadCommand,
  telegramUserReadCommand,
  telegramUserDownloadCommand,
  telegramUserSendCommand,
  telegramUserTopicCreateCommand,
  telegramUserTopicDeleteCommand,
  telegramUserTopicResolveCommand,
}));

vi.mock("./telegram-user-monitor-service.js", () => ({
  runTelegramMonitorServiceInstall,
  runTelegramMonitorServiceRestart,
  runTelegramMonitorServiceStatus,
  runTelegramMonitorServiceStop,
  runTelegramMonitorServiceUninstall,
}));

describe("telegram-user cli", () => {
  let registerTelegramUserCli: (typeof import("./telegram-user-cli.js"))["registerTelegramUserCli"];

  beforeAll(async () => {
    ({ registerTelegramUserCli } = await import("./telegram-user-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("teaches the installed openclaw telegram-user path in command help", async () => {
    const program = new Command();
    let help = "";

    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        help += text;
      },
      writeErr: (text) => {
        help += text;
      },
    });
    registerTelegramUserCli(program);

    await expect(program.parseAsync(["telegram-user", "--help"], { from: "user" })).rejects.toThrow(
      "outputHelp",
    );

    expect(help).toContain("openclaw telegram-user status --json");
    expect(help).toContain("openclaw telegram-user doctor --json");
    expect(help).toContain("openclaw telegram-user send --chat @jarvis_tester_1_bot");
    expect(help).toContain("openclaw telegram-user send --chat -1003783709877 --topic-anchor");
    expect(help).toContain("openclaw telegram-user topic-delete --chat -1003783709877");
    expect(help).toContain("openclaw telegram-user topic-resolve --chat -1003783709877");
    expect(help).toContain("read --chat -1003783709877 --topic-anchor 15250");
    expect(help).toContain(
      "openclaw telegram-user read --chat @jarvis_tester_1_bot --contains proof",
    );
    expect(help).toContain("--format compact");
    expect(help).toContain("openclaw telegram-user mark-read --chat @jarvis_tester_1_bot --json");
    expect(help).toContain("openclaw telegram-user mark-unread --chat @jarvis_tester_1_bot --json");
    expect(help).toContain(
      "openclaw telegram-user download --chat @jarvis_tester_1_bot --message-id 52830",
    );
    expect(help).toContain(
      "openclaw telegram-user button-click --chat @jarvis_tester_1_bot --message-id 52831",
    );
    expect(help).toContain("compact agent-friendly rows");
    expect(help).toContain("openclaw telegram-user monitor-listen --chat @jarvis_tester_1_bot");
    expect(help).toContain(
      "openclaw telegram-user monitor-poll --watch --cron-store /tmp/cron.json",
    );
    expect(help).toContain("openclaw telegram-user monitor-service install --hook-url");
    expect(help).not.toContain("pnpm openclaw:local telegram-user");
  });

  it("registers button-click and forwards every exact selector", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("button-click");

    await program.parseAsync(
      [
        "telegram-user",
        "button-click",
        "--chat",
        "@jarvis_tester_1_bot",
        "--message-id",
        "52831",
        "--button-text",
        "Queue",
        "--expected-callback-data",
        "queue:proof",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserButtonClickCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        buttonText: "Queue",
        chat: "@jarvis_tester_1_bot",
        expectedCallbackData: "queue:proof",
        json: true,
        messageId: "52831",
      }),
      expect.any(Object),
    );
  });

  it("registers doctor and forwards optional chat/state flags", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("doctor");

    await program.parseAsync(
      [
        "telegram-user",
        "doctor",
        "--chat",
        "@jarvis_tester_1_bot",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserDoctorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        envFile: "/tmp/tg.env",
        json: true,
        session: "/tmp/userbot.session",
      }),
      expect.any(Object),
    );
  });

  it("registers monitor-listen and forwards listener options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("monitor-listen");

    await program.parseAsync(
      [
        "telegram-user",
        "monitor-listen",
        "--chat",
        "@jarvis_tester_1_bot",
        "--after-id",
        "123",
        "--account-id",
        "personal",
        "--thread-anchor",
        "7001",
        "--contains",
        "reply",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserMonitorListenCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "personal",
        afterId: "123",
        chat: "@jarvis_tester_1_bot",
        contains: "reply",
        json: true,
        threadAnchor: "7001",
      }),
      expect.anything(),
    );
  });

  it("registers monitor-poll and forwards cursor/dispatch options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("monitor-poll");

    await program.parseAsync(
      [
        "telegram-user",
        "monitor-poll",
        "--cron-store",
        "/tmp/cron.json",
        "--monitor-store",
        "/tmp/monitors.json",
        "--cursor-store",
        "/tmp/cursors.json",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--hook-url",
        "http://127.0.0.1:18789/hooks/telegram-user-monitor-event",
        "--hook-token",
        "secret",
        "--limit",
        "12",
        "--watch",
        "--poll-interval-ms",
        "2500",
        "--max-runs",
        "3",
        "--commit-without-dispatch",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserMonitorPollCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commitWithoutDispatch: true,
        cronStore: "/tmp/cron.json",
        cursorStore: "/tmp/cursors.json",
        hookToken: "secret",
        hookUrl: "http://127.0.0.1:18789/hooks/telegram-user-monitor-event",
        json: true,
        limit: "12",
        maxRuns: "3",
        monitorStore: "/tmp/monitors.json",
        pollIntervalMs: "2500",
        watch: true,
      }),
      expect.anything(),
    );
  });

  it("registers monitor-service install and forwards service options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    const monitorService = telegramUser?.commands.find(
      (command) => command.name() === "monitor-service",
    );
    expect(monitorService?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["install", "status", "restart", "stop", "uninstall"]),
    );
    expect(monitorService?.commands.map((command) => command.name())).not.toContain("start");

    await program.parseAsync(
      [
        "telegram-user",
        "monitor-service",
        "install",
        "--cron-store",
        "/tmp/cron.json",
        "--monitor-store",
        "/tmp/monitors.json",
        "--cursor-store",
        "/tmp/cursors.json",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--hook-url",
        "http://127.0.0.1:18789/hooks/telegram-user-monitor-event",
        "--poll-interval-ms",
        "2500",
        "--limit",
        "12",
        "--runtime",
        "node",
        "--force",
        "--json",
      ],
      { from: "user" },
    );

    expect(runTelegramMonitorServiceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        cronStore: "/tmp/cron.json",
        cursorStore: "/tmp/cursors.json",
        envFile: "/tmp/tg.env",
        force: true,
        hookUrl: "http://127.0.0.1:18789/hooks/telegram-user-monitor-event",
        json: true,
        limit: "12",
        monitorStore: "/tmp/monitors.json",
        pollIntervalMs: "2500",
        runtime: "node",
        session: "/tmp/userbot.session",
      }),
    );
  });

  it("registers the inbox command and forwards unread triage flags", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser).toBeTruthy();
    expect(telegramUser?.commands.map((command) => command.name())).toContain("inbox");

    await program.parseAsync(
      [
        "telegram-user",
        "inbox",
        "--contains",
        "urgent",
        "--unread",
        "--dm-only",
        "--limit",
        "7",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserInboxCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        contains: "urgent",
        dmOnly: true,
        envFile: "/tmp/tg.env",
        json: true,
        limit: "7",
        session: "/tmp/userbot.session",
        unread: true,
      }),
      expect.any(Object),
    );
  });

  it("registers read --contains and forwards structured text filters", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    await program.parseAsync(
      [
        "telegram-user",
        "read",
        "--chat",
        "@jarvis_tester_1_bot",
        "--contains",
        "proof",
        "--topic-anchor",
        "15250",
        "--limit",
        "5",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserReadCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        contains: "proof",
        json: true,
        limit: "5",
        topicAnchor: "15250",
      }),
      expect.any(Object),
    );
  });

  it("registers exact topic resolution and forwards the named chat topic", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    await program.parseAsync(
      [
        "telegram-user",
        "topic-resolve",
        "--chat",
        "-1003783709877",
        "--title",
        "Gmail Keychain Auth RCA",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserTopicResolveCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        json: true,
        title: "Gmail Keychain Auth RCA",
      }),
      expect.any(Object),
    );
  });

  it("registers read-state commands and forwards chat/backend options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["mark-read", "mark-unread"]),
    );

    await program.parseAsync(
      [
        "telegram-user",
        "mark-read",
        "--chat",
        "@jarvis_tester_1_bot",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--json",
      ],
      { from: "user" },
    );
    await program.parseAsync(
      ["telegram-user", "mark-unread", "--chat", "-1003783709877", "--json"],
      { from: "user" },
    );

    expect(telegramUserMarkReadCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        envFile: "/tmp/tg.env",
        json: true,
        session: "/tmp/userbot.session",
      }),
      expect.any(Object),
    );
    expect(telegramUserMarkUnreadCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        json: true,
      }),
      expect.any(Object),
    );
  });

  it("registers topic-create and forwards chat/title options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("topic-create");

    await program.parseAsync(
      [
        "telegram-user",
        "topic-create",
        "--chat",
        "-1003783709877",
        "--title",
        "voice proof",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserTopicCreateCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        envFile: "/tmp/tg.env",
        json: true,
        session: "/tmp/userbot.session",
        title: "voice proof",
      }),
      expect.any(Object),
    );
  });

  it("registers topic-delete and forwards chat/topic anchor options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("topic-delete");

    await program.parseAsync(
      [
        "telegram-user",
        "topic-delete",
        "--chat",
        "-1003783709877",
        "--topic-anchor",
        "15250",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserTopicDeleteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        envFile: "/tmp/tg.env",
        json: true,
        session: "/tmp/userbot.session",
        topicAnchor: "15250",
      }),
      expect.any(Object),
    );
  });

  it("accepts topic-delete --topic-id as an alias without --topic-anchor", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    await program.parseAsync(
      [
        "telegram-user",
        "topic-delete",
        "--chat",
        "-1003783709877",
        "--topic-id",
        "15250",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserTopicDeleteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        json: true,
        topicId: "15250",
      }),
      expect.any(Object),
    );
  });

  it("registers download and forwards chat/message/output options", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    expect(telegramUser?.commands.map((command) => command.name())).toContain("download");

    await program.parseAsync(
      [
        "telegram-user",
        "download",
        "--chat",
        "@jarvis_tester_1_bot",
        "--message-id",
        "52830",
        "--output",
        "/tmp/openclaw-media",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserDownloadCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        json: true,
        messageId: "52830",
        output: "/tmp/openclaw-media",
      }),
      expect.any(Object),
    );
  });

  it("allows send media, optional caption, and explicit voice mode without requiring text", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    const telegramUser = program.commands.find((command) => command.name() === "telegram-user");
    const send = telegramUser?.commands.find((command) => command.name() === "send");
    const messageOption = send?.options.find((option: Option) => option.long === "--message");
    expect(messageOption?.mandatory).toBe(false);

    await program.parseAsync(
      [
        "telegram-user",
        "send",
        "--chat",
        "@jarvis_tester_1_bot",
        "--media",
        "/tmp/proof.ogg",
        "--caption",
        "voice caption",
        "--voice",
        "--reply-to",
        "15248",
        "--topic-anchor",
        "15248",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "voice caption",
        chat: "@jarvis_tester_1_bot",
        json: true,
        media: "/tmp/proof.ogg",
        replyTo: "15248",
        topicAnchor: "15248",
        voice: true,
      }),
      expect.any(Object),
    );
  });

  it("registers send topic aliases and forwards them to the command layer", async () => {
    const program = new Command();
    registerTelegramUserCli(program);

    await program.parseAsync(
      [
        "telegram-user",
        "send",
        "--chat",
        "-1003783709877",
        "--topic-id",
        "18327",
        "--message",
        "seed prompt",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramUserSendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "-1003783709877",
        json: true,
        message: "seed prompt",
        topicId: "18327",
      }),
      expect.any(Object),
    );
  });
});
