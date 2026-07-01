import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_MODES, resolveMarkdownTableMode } from "./markdown-tables.js";

describe("DEFAULT_TABLE_MODES", () => {
  it("telegram mode is block for rich-message capable renderers", () => {
    expect(DEFAULT_TABLE_MODES.get("telegram")).toBe("block");
  });

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
  it("defaults telegram to native block mode only for block-aware renderers", () => {
    const cfg = { channels: { telegram: {} } };

    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("code");
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram", supportsBlockTables: true })).toBe(
      "block",
    );
  });

  it("normalizes block defaults when no config object is available", () => {
    expect(resolveMarkdownTableMode({ channel: "telegram" })).toBe("code");
    expect(resolveMarkdownTableMode({ channel: "telegram", supportsBlockTables: true })).toBe(
      "block",
    );
  });

  it("only returns block mode for block-aware renderers", () => {
    const cfg = { channels: { telegram: { markdown: { tables: "block" as const } } } };

    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("code");
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram", supportsBlockTables: true })).toBe(
      "block",
    );
  });
});
