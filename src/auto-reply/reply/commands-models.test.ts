import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveModelsCommandReply } from "./commands-models.js";

type TelegramButtonsPayload = {
  telegram?: {
    buttons?: Array<Array<{ text: string; callback_data: string }>>;
  };
};

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5" },
    { provider: "google", id: "gemini-3-flash-preview", name: "Gemini Flash" },
  ]),
}));

describe("resolveModelsCommandReply", () => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "openai-codex/gpt-5.5" },
      },
    },
  } satisfies OpenClawConfig;

  it("shows consumer model families first on Telegram", async () => {
    const reply = await resolveModelsCommandReply({
      cfg,
      commandBodyNormalized: "/models",
      surface: "telegram",
    });

    expect(reply?.text).toBe("Current: openai-codex/gpt-5.5");
    const buttons = (reply?.channelData as TelegramButtonsPayload | undefined)?.telegram?.buttons;
    expect(buttons).toEqual([
      [
        { text: "Claude", callback_data: "mdl_fam_claude" },
        { text: "ChatGPT", callback_data: "mdl_fam_chatgpt" },
      ],
      [{ text: "More", callback_data: "mdl_prov" }],
    ]);
  });

  it("keeps the advanced provider browser behind /models all", async () => {
    const reply = await resolveModelsCommandReply({
      cfg,
      commandBodyNormalized: "/models all",
      surface: "telegram",
    });

    const buttons =
      (reply?.channelData as TelegramButtonsPayload | undefined)?.telegram?.buttons ?? [];
    expect(reply?.text).toBe("Select a provider:");
    expect(buttons.flat().map((button) => button.callback_data)).toContain("mdl_list_google_1");
  });

  it("lists Claude CLI 1M variants as explicit advanced models", async () => {
    const reply = await resolveModelsCommandReply({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "claude-cli/sonnet" },
            models: {
              "claude-cli/sonnet": {},
              "claude-cli/sonnet[1m]": {},
              "claude-cli/opus": {},
              "claude-cli/opus[1m]": {},
            },
          },
        },
      } satisfies OpenClawConfig,
      commandBodyNormalized: "/models claude-cli all",
      surface: "whatsapp",
    });

    expect(reply?.text).toContain("Models (claude-cli)");
    expect(reply?.text).toContain("- claude-cli/sonnet");
    expect(reply?.text).toContain("- claude-cli/sonnet[1m]");
    expect(reply?.text).toContain("- claude-cli/opus");
    expect(reply?.text).toContain("- claude-cli/opus[1m]");
  });
});
