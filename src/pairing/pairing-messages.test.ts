import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    process.env.OPENCLAW_PROFILE = "isolated";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  const cases = [
    {
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
    },
    {
      channel: "discord",
      idLine: "Your Discord user id: 1",
      code: "ABC123",
    },
    {
      channel: "slack",
      idLine: "Your Slack user id: U1",
      code: "DEF456",
    },
    {
      channel: "signal",
      idLine: "Your Signal number: +15550001111",
      code: "GHI789",
    },
    {
      channel: "imessage",
      idLine: "Your iMessage sender id: +15550002222",
      code: "JKL012",
    },
    {
      channel: "whatsapp",
      idLine: "Your WhatsApp phone number: +15550003333",
      code: "MNO345",
    },
  ] as const;

  for (const testCase of cases) {
    it(`formats pairing reply for ${testCase.channel}`, () => {
      const text = buildPairingReply(testCase);
      expect(text).toContain(testCase.idLine);
      expect(text).toContain("Pairing code:");
      expect(text).toContain(`\n\`\`\`\n${testCase.code}\n\`\`\`\n`);
      // CLI commands should respect OPENCLAW_PROFILE when set (most tests run with isolated profile)
      const commandRe = new RegExp(
        `(?:openclaw|openclaw) --profile isolated pairing approve ${testCase.channel} ${testCase.code}`,
      );
      expect(text).toMatch(commandRe);
      expect(text).toContain("\n```\n");
    });
  }

  it("prefers the isolated runtime state/config context when available", () => {
    process.env.OPENCLAW_PROFILE = "consumer-main-durable-lane-20260405";
    process.env.OPENCLAW_STATE_DIR =
      "/Users/user/.openclaw/telegram-live-worktrees/tg-live-4e6457c4be";
    process.env.OPENCLAW_CONFIG_PATH =
      "/Users/user/.openclaw/telegram-live-worktrees/tg-live-4e6457c4be/openclaw.telegram-live.json";

    const text = buildPairingReply({
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
    });

    expect(text).toContain(
      "OPENCLAW_STATE_DIR=/Users/user/.openclaw/telegram-live-worktrees/tg-live-4e6457c4be OPENCLAW_CONFIG_PATH=/Users/user/.openclaw/telegram-live-worktrees/tg-live-4e6457c4be/openclaw.telegram-live.json openclaw pairing approve telegram QRS678",
    );
    expect(text).not.toContain(
      "consumer-main-durable-lane-20260405 pairing approve telegram QRS678",
    );
  });
});
