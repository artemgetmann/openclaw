import { Command, Option } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramUserInboxCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserSendCommand = vi.fn().mockResolvedValue(undefined);
const telegramUserTopicCreateCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/telegram-user.js", () => ({
  telegramUserInboxCommand,
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
