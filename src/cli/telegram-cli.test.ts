import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const telegramDoctorCommand = vi.fn().mockResolvedValue(undefined);
const telegramRuntimeEnsureCommand = vi.fn().mockResolvedValue(undefined);
const telegramRuntimeReleaseCommand = vi.fn().mockResolvedValue(undefined);
const telegramScenarioProgressLongTaskCommand = vi.fn().mockResolvedValue(undefined);
const telegramScenarioProgressPlusTtsCommand = vi.fn().mockResolvedValue(undefined);
const telegramScenarioTtsFinalCaptionCommand = vi.fn().mockResolvedValue(undefined);
const telegramSmokeBaselineCommand = vi.fn().mockResolvedValue(undefined);
const telegramSmokeDmReplyCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/telegram.js", () => ({
  telegramDoctorCommand,
  telegramRuntimeEnsureCommand,
  telegramRuntimeReleaseCommand,
  telegramScenarioProgressLongTaskCommand,
  telegramScenarioProgressPlusTtsCommand,
  telegramScenarioTtsFinalCaptionCommand,
  telegramSmokeBaselineCommand,
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
      expect.arrayContaining(["doctor", "runtime", "scenario", "smoke"]),
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

  it("registers smoke and scenario harness commands", () => {
    const program = new Command();
    registerTelegramCli(program);

    const telegram = program.commands.find((command) => command.name() === "telegram");
    const smoke = telegram?.commands.find((command) => command.name() === "smoke");
    const scenario = telegram?.commands.find((command) => command.name() === "scenario");

    expect(smoke?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["baseline", "dm-reply"]),
    );
    expect(scenario?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["progress-long-task", "progress-plus-tts", "tts-final-caption"]),
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

  it("passes harness options to smoke baseline without requiring chat", async () => {
    const program = new Command();
    registerTelegramCli(program);

    await program.parseAsync(
      [
        "telegram",
        "smoke",
        "baseline",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--message",
        "baseline ping",
        "--text",
        "baseline text",
        "--timeout",
        "60",
        "--topic-id",
        "42",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramSmokeBaselineCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        envFile: "/tmp/tg.env",
        json: true,
        message: "baseline ping",
        session: "/tmp/userbot.session",
        text: "baseline text",
        timeout: "60",
        topicId: "42",
      }),
      expect.any(Object),
    );
  });

  it("passes harness options to tts final-caption scenario", async () => {
    const program = new Command();
    registerTelegramCli(program);

    await program.parseAsync(
      [
        "telegram",
        "scenario",
        "tts-final-caption",
        "--chat",
        "@jarvis_tester_1_bot",
        "--message",
        "read this",
        "--timeout",
        "90",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramScenarioTtsFinalCaptionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: "@jarvis_tester_1_bot",
        json: true,
        message: "read this",
        timeout: "90",
      }),
      expect.any(Object),
    );
  });

  it("passes harness options to progress scenarios without requiring chat", async () => {
    const program = new Command();
    registerTelegramCli(program);

    await program.parseAsync(
      [
        "telegram",
        "scenario",
        "progress-long-task",
        "--text",
        "summarize slowly",
        "--timeout",
        "180",
        "--topic-id",
        "77",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramScenarioProgressLongTaskCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        json: true,
        text: "summarize slowly",
        timeout: "180",
        topicId: "77",
      }),
      expect.any(Object),
    );

    await program.parseAsync(
      [
        "telegram",
        "scenario",
        "progress-plus-tts",
        "--env-file",
        "/tmp/tg.env",
        "--session",
        "/tmp/userbot.session",
        "--message",
        "narrate progress",
        "--json",
      ],
      { from: "user" },
    );

    expect(telegramScenarioProgressPlusTtsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        envFile: "/tmp/tg.env",
        json: true,
        message: "narrate progress",
        session: "/tmp/userbot.session",
      }),
      expect.any(Object),
    );
  });
});
