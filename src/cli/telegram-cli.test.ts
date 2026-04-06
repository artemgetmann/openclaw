import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramDoctorCommand = vi.fn().mockResolvedValue(undefined);
const telegramRuntimeEnsureCommand = vi.fn().mockResolvedValue(undefined);
const telegramRuntimeReleaseCommand = vi.fn().mockResolvedValue(undefined);
const telegramSmokeDmReplyCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/telegram.js", () => ({
  telegramDoctorCommand,
  telegramRuntimeEnsureCommand,
  telegramRuntimeReleaseCommand,
  telegramSmokeDmReplyCommand,
}));

describe("telegram cli", () => {
  let registerTelegramCli: (typeof import("./telegram-cli.js"))["registerTelegramCli"];

  beforeAll(async () => {
    ({ registerTelegramCli } = await import("./telegram-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the telegram namespace and doctor command", async () => {
    const program = new Command();
    registerTelegramCli(program);

    const telegram = program.commands.find((command) => command.name() === "telegram");
    expect(telegram).toBeTruthy();
    expect(telegram?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["doctor", "runtime", "smoke"]),
    );

    await program.parseAsync(
      [
        "telegram",
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

    expect(telegramDoctorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        envFile: "/tmp/tg.env",
        json: true,
        session: "/tmp/userbot.session",
      }),
      expect.any(Object),
    );
  });

  it("passes message and timeout to smoke dm-reply", async () => {
    const program = new Command();
    registerTelegramCli(program);

    await program.parseAsync(
      [
        "telegram",
        "smoke",
        "dm-reply",
        "--chat",
        "@jarvis_tester_1_bot",
        "--message",
        "ping",
        "--timeout",
        "45",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramSmokeDmReplyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        json: true,
        message: "ping",
        timeout: "45",
      }),
      expect.any(Object),
    );
  });
});
