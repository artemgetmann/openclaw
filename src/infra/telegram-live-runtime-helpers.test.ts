import { describe, expect, it } from "vitest";
import {
  buildTelegramLiveRuntimeConfig,
  extractTelegramBotTokensFromConfig,
  selectTelegramTesterToken,
} from "../../scripts/lib/telegram-live-runtime-helpers.mjs";

describe("telegram live runtime helpers", () => {
  it("extracts reserved Telegram bot tokens from base config", () => {
    const tokens = extractTelegramBotTokensFromConfig({
      channels: {
        telegram: {
          botToken: "default-token",
          accounts: {
            coder: { botToken: "coder-token" },
            empty: { enabled: true },
            finance: { botToken: "finance-token" },
          },
        },
      },
    });

    expect(tokens).toEqual(["default-token", "coder-token", "finance-token"]);
  });

  it("reassigns when the current tester token is reserved by the main runtime", () => {
    const result = selectTelegramTesterToken({
      poolTokens: ["prod-token", "tester-a", "tester-b"],
      claimedTokens: ["tester-a"],
      reservedTokens: ["prod-token"],
      currentToken: "prod-token",
    });

    expect(result).toMatchObject({
      ok: true,
      action: "assign",
      reason: "reassign_conflict_or_invalid",
      selectedToken: "tester-b",
    });
  });

  it("builds a Telegram-only runtime config that disables ACP and uses API-key model routing", () => {
    const config = buildTelegramLiveRuntimeConfig({
      baseConfig: {
        env: {
          OPENAI_API_KEY: "sk-live-test",
        },
        acp: {
          backend: "acpx",
          dispatch: { enabled: true },
        },
        channels: {
          telegram: {
            enabled: false,
            requireMention: false,
            accounts: {
              coder: { botToken: "prod-token" },
            },
          },
          slack: { enabled: true },
        },
        plugins: {
          allow: ["slack"],
          deny: ["legacy"],
          entries: {
            acpx: { enabled: true },
            slack: { enabled: true },
          },
          slots: {
            memory: "default",
          },
        },
      },
      assignedToken: "tester-token",
      runtimePort: 24567,
      workspaceDir: "/tmp/openclaw-live-onboarding",
      dmPolicy: "open",
    });

    expect(config.gateway).toMatchObject({
      port: 24567,
      bind: "loopback",
      mode: "local",
      controlUi: { enabled: false },
    });
    expect(config.channels).toEqual({
      telegram: {
        allowFrom: ["*"],
        enabled: true,
        requireMention: false,
        dmPolicy: "open",
        botToken: "tester-token",
      },
    });
    expect(config.agents?.defaults?.model).toMatchObject({
      primary: "openai/gpt-5.4",
      fallbacks: [],
    });
    expect(config.agents?.defaults?.workspace).toBe("/tmp/openclaw-live-onboarding");
    expect(config.agents?.list).toEqual([{ id: "main" }]);
    expect(config.acp).toEqual({
      enabled: false,
      dispatch: { enabled: false },
    });
    expect(config.bindings).toEqual([]);
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["telegram"],
      slots: { memory: "none" },
    });
    expect(config.plugins?.deny).toEqual(["acpx"]);
    expect(config.plugins?.entries?.telegram).toMatchObject({ enabled: true });
    expect(config.plugins?.entries?.acpx).toMatchObject({ enabled: false });
  });
});
