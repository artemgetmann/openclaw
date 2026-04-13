import { describe, expect, it } from "vitest";
import { getCliSessionId, setCliSessionId } from "./cli-session.js";

describe("cli-session", () => {
  it("does not read persisted cli session ids for claude-bridge", () => {
    expect(
      getCliSessionId(
        {
          sessionId: "s1",
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
      cliSessionIds: { "claude-cli": "kept-cli-session" },
      claudeCliSessionId: "legacy-claude-session",
    };

    setCliSessionId(entry, "claude-bridge", "new-bridge-session");

    expect(entry.cliSessionIds).toEqual({ "claude-cli": "kept-cli-session" });
    expect(entry.claudeCliSessionId).toBe("legacy-claude-session");
  });
});
