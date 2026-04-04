import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, updateSessionStore } from "../../../src/config/sessions.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const tempDirs: string[] = [];

// Mock recordInboundSession to capture updateLastRoute parameter
const recordInboundSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation,
    });
  }

  function getUpdateLastRoute(): unknown {
    const callArgs = recordInboundSessionMock.mock.calls.at(-1)?.[0] as {
      updateLastRoute?: unknown;
    };
    return callArgs?.updateLastRoute;
  }

  function getLastRecordInboundSessionCall(): {
    createIfMissing?: boolean;
    updateLastRoute?: unknown;
  } {
    return (
      (recordInboundSessionMock.mock.calls.at(-1)?.[0] as {
        createIfMissing?: boolean;
        updateLastRoute?: unknown;
      }) ?? {}
    );
  }

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeStorePath() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-dm-topic-seed-"));
    tempDirs.push(dir);
    return path.join(dir, "sessions.json");
  }

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42, // DM Topic ID
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute includes threadId
    const updateLastRoute = getUpdateLastRoute() as { threadId?: string; to?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBe("42");
  });

  it("passes threadId to updateLastRoute when only direct_messages_topic is present", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        direct_messages_topic: { topic_id: 55 },
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    const updateLastRoute = getUpdateLastRoute() as { threadId?: string; to?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBe("55");
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute does NOT include threadId
    const updateLastRoute = getUpdateLastRoute() as { threadId?: string; to?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBeUndefined();
  });

  it("does not set updateLastRoute for group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        text: "@bot hello",
        message_thread_id: 99,
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    // Check that updateLastRoute is undefined for groups
    expect(getUpdateLastRoute()).toBeUndefined();
  });

  it("seeds first plain DM-topic messages from parent future-thread defaults", async () => {
    const storePath = await makeStorePath();
    await updateSessionStore(storePath, (store) => {
      store["agent:main:telegram:default:direct:1234"] = {
        sessionId: "parent-direct",
        updatedAt: Date.now(),
        futureThreadProviderOverride: "anthropic",
        futureThreadModelOverride: "claude-sonnet-4-6",
        futureThreadThinkingLevelOverride: "adaptive",
      };
      return null;
    });

    const cfg = {
      agents: { defaults: { model: "openai-codex/gpt-5.4", workspace: "/tmp/openclaw" } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
      session: { store: storePath, dmScope: "per-account-channel-peer" },
    };

    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        chat: { id: 1234, type: "private" },
        from: { id: 1234, first_name: "Artem" },
        text: "test",
        message_thread_id: 55,
        is_topic_message: true,
      },
    });

    expect(ctx).not.toBeNull();

    const store = loadSessionStore(storePath);
    expect(store["agent:main:telegram:default:direct:1234:thread:1234:55"]).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      thinkingLevel: "adaptive",
    });
    expect(getLastRecordInboundSessionCall().createIfMissing).toBe(false);
  });
});
