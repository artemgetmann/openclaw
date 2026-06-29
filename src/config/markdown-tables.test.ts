import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_MODES, resolveMarkdownTableMode } from "./markdown-tables.js";

describe("DEFAULT_TABLE_MODES", () => {
  it("mattermost mode is off", () => {
    expect(DEFAULT_TABLE_MODES.get("mattermost")).toBe("off");
  });

  it("signal mode is bullets", () => {
    expect(DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
  });

  it("whatsapp mode is bullets", () => {
    expect(DEFAULT_TABLE_MODES.get("whatsapp")).toBe("bullets");
  });
});

describe("resolveMarkdownTableMode", () => {
  it("only returns block mode for block-aware renderers", () => {
    const cfg = { channels: { telegram: { markdown: { tables: "block" as const } } } };

    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("code");
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram", supportsBlockTables: true })).toBe(
      "block",
    );
  });
});
