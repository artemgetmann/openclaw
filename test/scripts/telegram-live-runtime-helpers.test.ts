import { describe, expect, it } from "vitest";
import {
  buildTelegramLiveRuntimeConfig,
  clearEnvAssignmentText,
  summarizeTelegramTesterTokenPool,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

describe("summarizeTelegramTesterTokenPool", () => {
  it("reports pool exhaustion after claimed and reserved tokens are removed", () => {
    const summary = summarizeTelegramTesterTokenPool({
      poolTokens: ["bot-1", "bot-2", "bot-3"],
      claimedEntries: [
        { token: "bot-1", worktreePath: "/tmp/wt-a" },
        { token: "bot-1", worktreePath: "/tmp/wt-a" },
      ],
      reservedTokens: ["bot-2", "bot-3"],
      currentToken: "",
    });

    expect(summary.poolCount).toBe(3);
    expect(summary.claimedCount).toBe(1);
    expect(summary.reservedCount).toBe(2);
    expect(summary.claimableCount).toBe(0);
    expect(summary.selection.ok).toBe(false);
    expect(summary.selection.reason).toBe("pool_exhausted");
  });

  it("treats a current token reserved by base config as unavailable", () => {
    const summary = summarizeTelegramTesterTokenPool({
      poolTokens: ["bot-1", "bot-2"],
      claimedEntries: [],
      reservedTokens: ["bot-1"],
      currentToken: "bot-1",
    });

    expect(summary.currentTokenStatus).toBe("reserved_by_base_config");
    expect(summary.selection.ok).toBe(true);
    expect(summary.selection.selectedToken).toBe("bot-2");
    expect(summary.selection.reason).toBe("reassign_conflict_or_invalid");
  });

  it("builds a tester runtime config without mutating the canonical source config", () => {
    const baseConfig = {
      env: {
        OPENAI_API_KEY: "sk-live-test",
      },
      channels: {
        telegram: {
          enabled: false,
          botToken: "99999:main-bot",
          accounts: {
            main: { botToken: "88888:main-account" },
          },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "sk-main-provider",
          },
        },
      },
    };

    const config = buildTelegramLiveRuntimeConfig({
      baseConfig,
      assignedToken: "tester-token",
      runtimePort: 24567,
    });

    expect(baseConfig.channels.telegram.botToken).toBe("99999:main-bot");
    expect(baseConfig.channels.telegram.accounts.main.botToken).toBe("88888:main-account");
    expect(baseConfig.env.OPENAI_API_KEY).toBe("sk-live-test");
    expect(baseConfig.models.providers.openai.apiKey).toBe("sk-main-provider");
    expect(config.channels.telegram.botToken).toBe("tester-token");
    expect(config.channels.telegram.accounts).toBeUndefined();
    expect(config.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.models.providers.openai.apiKey).toBeUndefined();
  });
});

describe("clearEnvAssignmentText", () => {
  it("removes every shadowed assignment for a key", () => {
    const result = clearEnvAssignmentText({
      key: "TELEGRAM_BOT_TOKEN",
      content: [
        "FOO=1",
        "TELEGRAM_BOT_TOKEN=bot-a",
        "BAR=2",
        "export TELEGRAM_BOT_TOKEN=bot-b",
        "",
      ].join("\n"),
    });

    expect(result.removed).toBe(true);
    expect(result.removedValue).toBe("bot-b");
    expect(result.content).toBe(["FOO=1", "BAR=2", ""].join("\n"));
  });
});
