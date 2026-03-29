import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/config/sessions.js";
import {
  migrateTelegramDmThreadStoreEntry,
  resolveTelegramDmThreadSessionRouting,
  resolveTelegramDmThreadStoreEntry,
} from "./dm-thread-session.js";

describe("resolveTelegramDmThreadSessionRouting", () => {
  it("returns the sender-derived canonical DM topic session key plus legacy aliases", () => {
    const resolved = resolveTelegramDmThreadSessionRouting({
      baseSessionKey: "agent:main:main",
      chatId: 777777777,
      senderId: 123456789,
      threadId: 55,
    });

    expect(resolved.sessionKey).toBe("agent:main:main:thread:123456789:55");
    expect(resolved.legacySessionKeys).toEqual([
      "agent:main:main:thread:777777777:55",
      "agent:main:main:thread:55",
    ]);
  });
});

describe("resolveTelegramDmThreadStoreEntry", () => {
  it("falls back to a legacy bare-thread session entry when canonical DM key is absent", () => {
    const legacyEntry: SessionEntry = {
      sessionId: "legacy-dm-topic",
      updatedAt: 1,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
    };
    const store: Record<string, SessionEntry> = {
      "agent:main:main:thread:55": legacyEntry,
    };

    const resolved = resolveTelegramDmThreadStoreEntry({
      store,
      sessionKey: "agent:main:main:thread:123456789:55",
      legacySessionKeys: ["agent:main:main:thread:777777777:55", "agent:main:main:thread:55"],
    });

    expect(resolved.existing).toBe(legacyEntry);
    expect(resolved.normalizedKey).toBe("agent:main:main:thread:123456789:55");
    expect(resolved.legacyKeys).toContain("agent:main:main:thread:55");
  });
});

describe("migrateTelegramDmThreadStoreEntry", () => {
  it("moves a legacy chat-derived DM topic entry onto the canonical sender-derived key", () => {
    const legacyEntry: SessionEntry = {
      sessionId: "legacy-chat-key",
      updatedAt: 1,
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
    };
    const store: Record<string, SessionEntry> = {
      "agent:main:main:thread:777777777:55": legacyEntry,
    };

    const migrated = migrateTelegramDmThreadStoreEntry({
      store,
      sessionKey: "agent:main:main:thread:123456789:55",
      legacySessionKeys: ["agent:main:main:thread:777777777:55", "agent:main:main:thread:55"],
    });

    expect(migrated.migrated).toBe(true);
    expect(store["agent:main:main:thread:123456789:55"]).toBe(legacyEntry);
    expect(store["agent:main:main:thread:777777777:55"]).toBeUndefined();
  });
});
