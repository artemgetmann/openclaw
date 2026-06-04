import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { clearCliSessionId, getCliSessionId, setCliSessionId } from "./cli-session.js";

describe("cli-session", () => {
  it("does not read persisted cli session ids for claude-bridge", () => {
    expect(
      getCliSessionId(
        {
          sessionId: "s1",
          updatedAt: 0,
          cliSessionIds: { "claude-bridge": "persisted-bridge-session" },
          claudeCliSessionId: "legacy-claude-session",
        },
        "claude-bridge",
      ),
    ).toBeUndefined();
  });

  it("does not persist cli session ids for claude-bridge", () => {
    const entry = {
      sessionId: "s1",
      updatedAt: 0,
      cliSessionIds: { "claude-cli": "kept-cli-session" },
      claudeCliSessionId: "legacy-claude-session",
    };

    setCliSessionId(entry, "claude-bridge", "new-bridge-session");

    expect(entry.cliSessionIds).toEqual({ "claude-cli": "kept-cli-session" });
    expect(entry.claudeCliSessionId).toBe("legacy-claude-session");
  });

  it("clears provider-specific resume ids after compaction", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      cliSessionIds: {
        "openai-codex": "codex-session",
        "claude-cli": "claude-session",
      },
      claudeCliSessionId: "claude-session",
    };

    clearCliSessionId(entry, "openai-codex");

    expect(getCliSessionId(entry, "openai-codex")).toBeUndefined();
    expect(getCliSessionId(entry, "claude-cli")).toBe("claude-session");
  });

  it("clears the legacy Claude CLI resume id with the provider map entry", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    setCliSessionId(entry, "claude-cli", "claude-session");

    clearCliSessionId(entry, "claude-cli");

    expect(getCliSessionId(entry, "claude-cli")).toBeUndefined();
    expect(entry.claudeCliSessionId).toBeUndefined();
  });
});
