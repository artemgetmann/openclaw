import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramUserInboxCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/telegram-user.js", () => ({
  telegramUserInboxCommand,
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
});
