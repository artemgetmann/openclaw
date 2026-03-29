import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext dm thread sessions", () => {
  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContextForTest({
      message,
    });

  it("uses thread session key for dm topics", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: 1234, type: "private" },
      date: 1700000000,
      text: "hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:42:42");
  });

  it("uses dm topic session key when Telegram sends direct_messages_topic only", async () => {
    const ctx = await buildContext({
      message_id: 10,
      chat: { id: 1234, type: "private" },
      date: 1700000010,
      text: "hello",
      direct_messages_topic: { topic_id: 314 },
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(314);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:42:314");
  });

  it("keeps dm topic session keys on the sender-derived peer when chat id is a wrapper", async () => {
    const ctx = await buildContext({
      message_id: 11,
      chat: { id: 777777777, type: "private" },
      date: 1700000011,
      text: "hello",
      direct_messages_topic: { topic_id: 314 },
      from: { id: 123456789, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(314);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:123456789:314");
  });

  it("keeps legacy dm session key when no thread id", async () => {
    const ctx = await buildContext({
      message_id: 2,
      chat: { id: 1234, type: "private" },
      date: 1700000001,
      text: "hello",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});

describe("buildTelegramMessageContext group sessions without forum", () => {
  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContextForTest({
      message,
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

  it("ignores message_thread_id for regular groups (not forums)", async () => {
    // When someone replies to a message in a non-forum group, Telegram sends
    // message_thread_id but this should NOT create a separate session
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42, // This is a reply thread, NOT a forum topic
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    // Session key should NOT include :topic:42
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890");
    // MessageThreadId should be undefined (not a forum)
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
  });

  it("keeps same session for regular group with and without message_thread_id", async () => {
    const ctxWithThread = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    const ctxWithoutThread = await buildContext({
      message_id: 2,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000001,
      text: "@bot world",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctxWithThread).not.toBeNull();
    expect(ctxWithoutThread).not.toBeNull();
    // Both messages should use the same session key
    expect(ctxWithThread?.ctxPayload?.SessionKey).toBe(ctxWithoutThread?.ctxPayload?.SessionKey);
  });

  it("uses topic session for forum groups with message_thread_id", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 99,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx).not.toBeNull();
    // Session key SHOULD include :topic:99 for forums
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(99);
  });
});

describe("buildTelegramMessageContext direct peer routing", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("isolates dm sessions by sender id when chat id differs", async () => {
    const runtimeCfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
      session: { dmScope: "per-channel-peer" as const },
    };
    setRuntimeConfigSnapshot(runtimeCfg);

    const baseMessage = {
      chat: { id: 777777777, type: "private" as const },
      date: 1700000000,
      text: "hello",
    };

    const first = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        ...baseMessage,
        message_id: 1,
        from: { id: 123456789, first_name: "Alice" },
      },
    });
    const second = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        ...baseMessage,
        message_id: 2,
        from: { id: 987654321, first_name: "Bob" },
      },
    });

    expect(first?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:123456789");
    expect(second?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:987654321");
  });

  it("uses the active DM sender as the conversation trust scope", async () => {
    const runtimeCfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: {
        telegram: {
          allowFrom: ["123456789", "987654321"],
        },
      },
      commands: {
        ownerAllowFrom: ["123456789"],
      },
      messages: { groupChat: { mentionPatterns: [] } },
      session: { dmScope: "per-channel-peer" as const },
    };
    setRuntimeConfigSnapshot(runtimeCfg);

    const ownerDm = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        message_id: 1,
        chat: { id: 777777777, type: "private" as const },
        date: 1700000000,
        text: "owner hello",
        from: { id: 123456789, first_name: "Owner" },
      },
    });
    const otherDm = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        message_id: 2,
        chat: { id: 777777777, type: "private" as const },
        date: 1700000001,
        text: "other hello",
        from: { id: 987654321, first_name: "Guest" },
      },
    });

    expect(ownerDm?.ctxPayload?.OwnerAllowFrom).toEqual(["123456789"]);
    expect(ownerDm?.ctxPayload?.ContextAllowFrom).toEqual(["123456789"]);
    expect(otherDm?.ctxPayload?.OwnerAllowFrom).toEqual(["123456789"]);
    expect(otherDm?.ctxPayload?.ContextAllowFrom).toEqual(["987654321"]);
  });
});
