import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "./system-prompt.js";

function createMockSession() {
  const setSystemPrompt = vi.fn();
  const session = {
    agent: { setSystemPrompt },
  } as unknown as AgentSession;
  return { session, setSystemPrompt };
}

describe("applySystemPromptOverrideToSession", () => {
  it("applies a string override to the session system prompt", () => {
    const { session, setSystemPrompt } = createMockSession();
    const prompt = "You are a helpful assistant with custom context.";

    applySystemPromptOverrideToSession(session, prompt);

    expect(setSystemPrompt).toHaveBeenCalledWith(prompt);
    const mutable = session as unknown as { _baseSystemPrompt?: string };
    expect(mutable._baseSystemPrompt).toBe(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { session, setSystemPrompt } = createMockSession();

    applySystemPromptOverrideToSession(session, "  padded prompt  ");

    expect(setSystemPrompt).toHaveBeenCalledWith("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const { session, setSystemPrompt } = createMockSession();
    const override = createSystemPromptOverride("function-based prompt");

    applySystemPromptOverrideToSession(session, override);

    expect(setSystemPrompt).toHaveBeenCalledWith("function-based prompt");
  });

  it("sets _rebuildSystemPrompt that returns the override", () => {
    const { session } = createMockSession();
    applySystemPromptOverrideToSession(session, "rebuild test");

    const mutable = session as unknown as {
      _rebuildSystemPrompt?: (toolNames: string[]) => string;
    };
    expect(mutable._rebuildSystemPrompt?.(["tool1"])).toBe("rebuild test");
  });
});

describe("buildEmbeddedSystemPrompt", () => {
  it("carries the routine-restart setting into the live agent prompt", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      restartConfirmationRequired: false,
      runtimeInfo: {
        host: "test-host",
        os: "test-os",
        arch: "arm64",
        node: "v24",
        model: "test/model",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
    });

    expect(prompt).toContain(
      "This owner configured gateway action `restart` as a routine service-lifecycle step",
    );
    expect(prompt).not.toContain(
      "For restart-capable gateway actions in live chat (`restart`, `config.apply`, `config.patch`, `update.run`, `app.update.install`)",
    );
  });
});
