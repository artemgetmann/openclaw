import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyFutureThreadModelDefault,
  applyFutureThreadThinkingDefault,
  applyFutureThreadVerboseDefault,
  seedSessionEntryFromFutureThreadDefaults,
} from "./future-thread-defaults.js";

describe("future-thread default history", () => {
  it("records boundary snapshots and seeds older untouched topics from the correct historical default", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:group:-100123": {
        sessionId: "parent-session",
        updatedAt: Date.now() - 5_000,
      },
    };
    const parentSessionKey = "agent:main:telegram:group:-100123";

    applyFutureThreadModelDefault({
      store,
      parentSessionKey,
      selection: {
        provider: "openai-codex",
        model: "gpt-5.3-codex",
      },
      afterThreadId: 84,
    });
    applyFutureThreadThinkingDefault({
      store,
      parentSessionKey,
      level: "medium",
      afterThreadId: 84,
    });
    applyFutureThreadModelDefault({
      store,
      parentSessionKey,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      afterThreadId: 90,
    });
    applyFutureThreadThinkingDefault({
      store,
      parentSessionKey,
      level: "adaptive",
      afterThreadId: 90,
    });

    const parentEntry = store[parentSessionKey];
    expect(parentEntry.futureThreadDefaultsHistory).toHaveLength(2);

    const olderTopicEntry: SessionEntry = {
      sessionId: "older-topic",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: olderTopicEntry,
      parentEntry,
      childThreadId: 89,
    });

    expect(olderTopicEntry.providerOverride).toBe("openai-codex");
    expect(olderTopicEntry.modelOverride).toBe("gpt-5.3-codex");
    expect(olderTopicEntry.thinkingLevel).toBe("medium");
    expect(olderTopicEntry.execSecurity).toBeUndefined();
    expect(olderTopicEntry.execAsk).toBeUndefined();

    const newerTopicEntry: SessionEntry = {
      sessionId: "newer-topic",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: newerTopicEntry,
      parentEntry,
      childThreadId: 97,
    });

    expect(newerTopicEntry.providerOverride).toBe("anthropic");
    expect(newerTopicEntry.modelOverride).toBe("claude-sonnet-4-6");
    expect(newerTopicEntry.thinkingLevel).toBe("adaptive");
    expect(newerTopicEntry.execSecurity).toBeUndefined();
    expect(newerTopicEntry.execAsk).toBeUndefined();
  });

  it("does not retroactively seed topics that predate every recorded boundary", () => {
    const parentEntry: SessionEntry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      futureThreadProviderOverride: "anthropic",
      futureThreadModelOverride: "claude-sonnet-4-6",
      futureThreadThinkingLevelOverride: "adaptive",
      futureThreadDefaultsHistory: [
        {
          afterThreadId: 84,
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.3-codex",
          thinkingLevelOverride: "medium",
          updatedAt: Date.now(),
        },
      ],
    };
    const entry: SessionEntry = {
      sessionId: "older-topic",
      updatedAt: Date.now(),
    };

    seedSessionEntryFromFutureThreadDefaults({
      entry,
      parentEntry,
      childThreadId: 81,
    });

    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.thinkingLevel).toBeUndefined();
  });

  it("uses current parent defaults beyond history without rewriting explicit children", () => {
    const now = Date.now();
    const parentEntry: SessionEntry = {
      sessionId: "parent-session",
      updatedAt: now,
      // The managed model override was cleared when Sol became the global
      // default, while Adaptive remains an explicit parent preference.
      futureThreadThinkingLevelOverride: "adaptive",
      futureThreadDefaultsHistory: [
        {
          afterThreadId: 25_040,
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.4",
          thinkingLevelOverride: "medium",
          updatedAt: now - 2_000,
        },
        {
          afterThreadId: 25_042,
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.5",
          thinkingLevelOverride: "adaptive",
          updatedAt: now - 1_000,
        },
      ],
    };

    const historicalChild: SessionEntry = {
      sessionId: "historical-child",
      updatedAt: now,
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: historicalChild,
      parentEntry,
      childThreadId: 25_041,
    });
    expect(historicalChild.providerOverride).toBe("openai-codex");
    expect(historicalChild.modelOverride).toBe("gpt-5.4");
    expect(historicalChild.thinkingLevel).toBe("medium");

    const explicitExistingChild: SessionEntry = {
      sessionId: "existing-child",
      updatedAt: now,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.5",
      thinkingLevel: "adaptive",
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: explicitExistingChild,
      parentEntry,
      childThreadId: 25_043,
    });
    expect(explicitExistingChild.providerOverride).toBe("openai-codex");
    expect(explicitExistingChild.modelOverride).toBe("gpt-5.5");
    expect(explicitExistingChild.thinkingLevel).toBe("adaptive");

    const newChild: SessionEntry = {
      sessionId: "new-child",
      updatedAt: now,
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: newChild,
      parentEntry,
      childThreadId: 25_044,
    });
    expect(newChild.providerOverride).toBeUndefined();
    expect(newChild.modelOverride).toBeUndefined();
    expect(newChild.thinkingLevel).toBe("adaptive");
  });

  it("copies exec overrides into future thread snapshots", () => {
    const parentEntry: SessionEntry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      execSecurity: "full",
      execAsk: "off",
      futureThreadDefaultsHistory: [
        {
          afterThreadId: 84,
          execSecurity: "full",
          execAsk: "off",
          updatedAt: Date.now(),
        },
      ],
    };
    const entry: SessionEntry = {
      sessionId: "child-topic",
      updatedAt: Date.now(),
    };

    seedSessionEntryFromFutureThreadDefaults({
      entry,
      parentEntry,
      childThreadId: 97,
    });

    expect(entry.execSecurity).toBe("full");
    expect(entry.execAsk).toBe("off");
  });

  it("seeds new thread sessions from the parent verbose default", () => {
    const store: Record<string, SessionEntry> = {};
    const parentSessionKey = "agent:main:telegram:default:direct:1336356696";

    applyFutureThreadVerboseDefault({
      store,
      parentSessionKey,
      level: "off",
    });

    const entry: SessionEntry = {
      sessionId: "child-thread",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry,
      parentEntry: store[parentSessionKey],
      childThreadId: 49628,
    });

    expect(store[parentSessionKey]?.verboseLevel).toBe("off");
    expect(entry.verboseLevel).toBe("off");
  });

  it("records verbose defaults in thread history so older topics do not inherit later changes", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:default:direct:1336356696": {
        sessionId: "parent-session",
        updatedAt: Date.now(),
      },
    };
    const parentSessionKey = "agent:main:telegram:default:direct:1336356696";

    applyFutureThreadVerboseDefault({
      store,
      parentSessionKey,
      level: "off",
      afterThreadId: 49645,
    });

    const olderThreadEntry: SessionEntry = {
      sessionId: "older-child-thread",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: olderThreadEntry,
      parentEntry: store[parentSessionKey],
      childThreadId: 49628,
    });

    const newerThreadEntry: SessionEntry = {
      sessionId: "newer-child-thread",
      updatedAt: Date.now(),
    };
    seedSessionEntryFromFutureThreadDefaults({
      entry: newerThreadEntry,
      parentEntry: store[parentSessionKey],
      childThreadId: 49646,
    });

    expect(olderThreadEntry.verboseLevel).toBeUndefined();
    expect(newerThreadEntry.verboseLevel).toBe("off");
  });
});
