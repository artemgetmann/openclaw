import { describe, expect, it } from "vitest";
import { resolveSessionMemoryScope, resolveStoredSessionMemoryScope } from "./memory-scope.js";

describe("resolveSessionMemoryScope", () => {
  it("treats direct chats without trust metadata as personal", () => {
    expect(
      resolveSessionMemoryScope({
        ChatType: "direct",
      }),
    ).toBe("personal");
  });

  it("treats owner-only conversation allowlists as personal", () => {
    expect(
      resolveSessionMemoryScope({
        ChatType: "group",
        OwnerAllowFrom: ["telegram:100"],
        ContextAllowFrom: ["100"],
      }),
    ).toBe("personal");
  });

  it("treats mixed allowlists as shared", () => {
    expect(
      resolveSessionMemoryScope({
        ChatType: "group",
        OwnerAllowFrom: ["100"],
        ContextAllowFrom: ["100", "200"],
      }),
    ).toBe("shared");
  });

  it("treats wildcard contexts as shared", () => {
    expect(
      resolveSessionMemoryScope({
        ChatType: "direct",
        ContextAllowFrom: ["*"],
      }),
    ).toBe("shared");
  });
});

describe("resolveStoredSessionMemoryScope", () => {
  it("prefers persisted memoryScope", () => {
    expect(resolveStoredSessionMemoryScope({ memoryScope: "shared", chatType: "direct" })).toBe(
      "shared",
    );
  });

  it("falls back to direct chats as personal for legacy entries", () => {
    expect(resolveStoredSessionMemoryScope({ chatType: "direct" })).toBe("personal");
    expect(resolveStoredSessionMemoryScope({ chatType: "group" })).toBe("shared");
  });
});
