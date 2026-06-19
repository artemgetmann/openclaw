import { Command, Option } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramUserInboxCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserDoctorCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserReadCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserDownloadCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserSendCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserTopicCreateCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/telegram-user.js", () => ({
  telegramUserDoctorCommand,
  telegramUserInboxCommand,
  telegramUserReadCommand,
  telegramUserDownloadCommand,
  telegramUserSendCommand,
  telegramUserTopicCreateCommand,
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
    expect(help).toContain(
      "openclaw telegram-user read --chat @jarvis_tester_1_bot --contains proof",
    );
    expect(help).toContain(
      "openclaw telegram-user download --chat @jarvis_tester_1_bot --message-id 52830",
    );
    expect(help).toContain("instead of piping JSON to grep");
    expect(help).not.toContain("pnpm openclaw:local telegram-user");
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
        voice: true,
      }),
      expect.any(Object),
    );
  });
});
