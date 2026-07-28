import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import { releaseDirectTurnRestartContinuation } from "../../infra/restart-continuation.js";
import { drainSystemEventEntries } from "../../infra/system-events.js";
import type { FollowupRun } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const routeReplyMock = vi.fn();
const isRoutableChannelMock = vi.fn();

vi.mock(
  "../../agents/model-fallback.js",
  async () => await import("../../test-utils/model-fallback.mock.js"),
);

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./route-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./route-reply.js")>();
  return {
    ...actual,
    isRoutableChannel: (...args: unknown[]) => isRoutableChannelMock(...args),
    routeReply: (...args: unknown[]) => routeReplyMock(...args),
  };
});

import { createFollowupRunner } from "./followup-runner.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import {
  ackDurableFollowup,
  hydrateDurableFollowup,
  loadDurableFollowups,
  markDurableFollowupRestartContinuationDelivering,
  markDurableFollowupRestartContinuationFailed,
  markDurableFollowupRestartReceiptDelivered,
  markDurableFollowupRestartReceiptDelivering,
  persistDurableFollowup,
  persistDurableFollowupDelivery,
  RESTART_CONTINUATION_UNSTARTED_ERROR,
  terminalizeDurableFollowupRestartContinuationIfStale,
} from "./queue/durable-store.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { RESTART_INTERRUPTED_TURN_PAYLOAD } from "./restart-recovery.js";

const ROUTABLE_TEST_CHANNELS = new Set([
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "whatsapp",
  "feishu",
]);

beforeEach(() => {
  routeReplyMock.mockReset();
  routeReplyMock.mockResolvedValue({ ok: true });
  isRoutableChannelMock.mockReset();
  isRoutableChannelMock.mockImplementation((ch: string | undefined) =>
    Boolean(ch?.trim() && ROUTABLE_TEST_CHANNELS.has(ch.trim().toLowerCase())),
  );
});

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  createMockFollowupRun({ run: { messageProvider } });

function createQueuedRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  return createMockFollowupRun(overrides);
}

function mockCompactionRun(params: {
  willRetry: boolean;
  result: {
    payloads: Array<{ text: string }>;
    meta: Record<string, unknown>;
  };
}) {
  runEmbeddedPiAgentMock.mockImplementationOnce(
    async (args: {
      onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    }) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: params.willRetry, completed: true },
      });
      return params.result;
    },
  );
}

function createAsyncReplySpy() {
  return vi.fn(async () => {});
}

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    mockCompactionRun({
      willRetry: true,
      result: { payloads: [{ text: "final" }], meta: {} },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });

  it("tracks auto-compaction from embedded result metadata even when no compaction event is emitted", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-meta-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          compactionCount: 2,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(2);
  });

  it("does not count failed compaction end events in followup runs", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-failed-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (args) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: false },
      });
      return {
        payloads: [{ text: "final" }],
        meta: {
          agentMeta: {
            compactionCount: 0,
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
          },
        },
      };
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toBe("final");
    expect(sessionStore.main.compactionCount).toBeUndefined();
  });
});

describe("createFollowupRunner bootstrap warning dedupe", () => {
  it("passes stored warning signature history to embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 1,
          projectContextChars: 0,
          nonProjectContextChars: 1,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 0,
          entries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 0,
          entries: [],
        },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    const sessionStore: Record<string, SessionEntry> = { main: sessionEntry };

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | {
          bootstrapPromptWarningSignaturesSeen?: string[];
          bootstrapPromptWarningSignature?: string;
        }
      | undefined;
    expect(call?.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(call?.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  function createMessagingDedupeRunner(
    onBlockReply: (payload: unknown) => Promise<void>,
    overrides: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
      liveReplyRoute: Pick<
        FollowupRun,
        "originatingChannel" | "originatingTo" | "originatingAccountId" | "originatingThreadId"
      >;
    }> = {},
  ) {
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
      sessionEntry: overrides.sessionEntry,
      sessionStore: overrides.sessionStore,
      sessionKey: overrides.sessionKey,
      storePath: overrides.storePath,
      liveReplyRoute: overrides.liveReplyRoute,
    });
  }

  async function runMessagingCase(params: {
    agentResult: Record<string, unknown>;
    queued?: FollowupRun;
    runnerOverrides?: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
      liveReplyRoute: Pick<
        FollowupRun,
        "originatingChannel" | "originatingTo" | "originatingAccountId" | "originatingThreadId"
      >;
    }>;
  }) {
    const onBlockReply = createAsyncReplySpy();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...params.agentResult,
    });
    const queued = params.queued ?? baseQueuedRun();
    const runner = createMessagingDedupeRunner(onBlockReply, {
      liveReplyRoute: queued,
      ...params.runnerOverrides,
    });
    await runner(queued);
    return { onBlockReply };
  }

  function makeTextReplyDedupeResult(overrides?: Record<string, unknown>) {
    return {
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      ...overrides,
    };
  }

  it("drops payloads already sent via messaging tool", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ text: "hello world!" }],
        messagingToolSentTexts: ["hello world!"],
      },
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: makeTextReplyDedupeResult(),
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses replies when provider is synthetic but originating channel matches", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
      } as FollowupRun,
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress replies for same target when account differs", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [
          { tool: "telegram", provider: "telegram", to: "268300329", accountId: "work" },
        ],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingAccountId: "personal",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "268300329",
        accountId: "personal",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("preserves same-channel Telegram progress lifecycle for queued followups", async () => {
    const commentaryChannelData = { openclaw: { assistantPhase: "commentary" } };
    const finalChannelData = { openclaw: { assistantPhase: "final_answer" } };
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [
          { text: "Checking the live thread.", channelData: commentaryChannelData },
          { text: "Preparing the approved send.", channelData: commentaryChannelData },
          { text: "Sent with proof.", channelData: finalChannelData },
        ],
      },
      queued: {
        ...baseQueuedRun("telegram"),
        originatingChannel: "telegram",
        originatingTo: "-100123:topic:456",
        originatingThreadId: "456",
      } as FollowupRun,
    });

    // The Telegram dispatcher folds commentary into one mutable Work log and
    // recognizes the explicit final boundary. Generic routeReply has no such
    // lifecycle and was the source of one durable message per payload.
    expect(routeReplyMock).not.toHaveBeenCalled();
    const deliveredPayloads = onBlockReply.mock.calls as unknown as Array<
      [{ text?: string; channelData?: Record<string, unknown> }]
    >;
    expect(deliveredPayloads.map(([payload]) => payload)).toEqual([
      { text: "Checking the live thread.", channelData: commentaryChannelData },
      { text: "Preparing the approved send.", channelData: commentaryChannelData },
      { text: "Sent with proof.", channelData: finalChannelData },
    ]);
  });

  it("drops media URL from payload when messaging tool already sent it", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/img.png"],
      },
    });

    // Media stripped → payload becomes non-renderable → not delivered.
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers media payload when not a duplicate", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/other.png"],
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
        meta: {
          agentMeta: {
            usage: { input: 1_000, output: 50 },
            lastCallUsage: { input: 400, output: 20 },
            model: "claude-opus-4-5",
            provider: "anthropic",
          },
        },
      },
      runnerOverrides: {
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    // totalTokens should reflect the last call usage snapshot, not the accumulated input.
    expect(store[sessionKey]?.totalTokens).toBe(400);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(store[sessionKey]?.inputTokens).toBe(1_000);
    expect(store[sessionKey]?.outputTokens).toBe(50);
  });

  it("does not fall back to dispatcher when cross-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "forced route failure",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("prefers the live dispatcher for same-channel origin routing", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun(" Feishu "),
        originatingChannel: "FEISHU",
        originatingTo: "ou_abc123",
      } as FollowupRun,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world!" }));
  });

  it("does not reuse a same-channel dispatcher bound to another destination", async () => {
    routeReplyMock.mockResolvedValueOnce({ ok: false, error: "adapter unavailable" });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "private reply" }] },
      queued: {
        ...baseQueuedRun("telegram"),
        originatingChannel: "telegram",
        originatingTo: "chat:queued",
        originatingAccountId: "work",
        originatingThreadId: "42",
      } as FollowupRun,
      runnerOverrides: {
        liveReplyRoute: {
          originatingChannel: "telegram",
          originatingTo: "chat:dispatcher",
          originatingAccountId: "work",
          originatingThreadId: "42",
        },
      },
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "chat:queued",
        accountId: "work",
        threadId: "42",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("routes followups with originating account/thread metadata", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C1",
        accountId: "work",
        threadId: "1739142736.000100",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

describe("createFollowupRunner typing cleanup", () => {
  async function runTypingCase(agentResult: Record<string, unknown>) {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...agentResult,
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());
    return typing;
  }

  function expectTypingCleanup(typing: ReturnType<typeof createMockTypingController>) {
    expect(typing.markRunComplete).toHaveBeenCalled();
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  }

  it("calls both markRunComplete and markDispatchIdle on NO_REPLY", async () => {
    const typing = await runTypingCase({ payloads: [{ text: "NO_REPLY" }] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on empty payloads", async () => {
    const typing = await runTypingCase({ payloads: [] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on agent error", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("agent exploded"));

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expectTypingCleanup(typing);
  });

  it("keeps absorbing non-durable model failures in durable-only recovery mode", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("legacy agent failure"));
    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner(baseQueuedRun())).resolves.toBeUndefined();
    expectTypingCleanup(typing);
  });

  it("rejects unrecovered route failures in recovery mode", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {},
    });
    routeReplyMock.mockResolvedValueOnce({ ok: false, error: "adapter unavailable" });
    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });
    const queued = {
      ...baseQueuedRun("webchat"),
      durableId: "durable-route-failure",
      // A restored delivery stage routes directly and must still reject so its
      // carrier record is not acknowledged by the drain.
      deliveryPayloads: [{ text: "hello world!" }],
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    } as FollowupRun;

    await expect(runner(queued)).rejects.toThrow("adapter unavailable");
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on successful delivery", async () => {
    const typing = createMockTypingController();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalled();
    expectTypingCleanup(typing);
  });
});

describe("createFollowupRunner durable delivery recovery", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-delivery-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    runEmbeddedPiAgentMock.mockReset();
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("rejects model failures after staging a visible restart receipt", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun();
    const input = await persistDurableFollowup({
      queueKey: "durable-model-failure",
      run: queued,
      settings,
    });
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("agent exploded"));
    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner({ ...queued, durableId: input.id })).rejects.toThrow("agent exploded");
    const [record] = await loadDurableFollowups();
    expect(record?.delivery?.payloads).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Jarvis restarted") }),
    ]);
    expect(record?.restartRecovery?.ownerExecution).toBe("started");
    expect(typing.markRunComplete).toHaveBeenCalled();
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  });

  it("stages one restart receipt for a synthetic durable batch before model work", async () => {
    const settings = { mode: "collect" as const, debounceMs: 0, cap: 20 };
    const firstRun = createQueuedRun({ messageId: "first" });
    const secondRun = createQueuedRun({ messageId: "second" });
    const first = await persistDurableFollowup({
      queueKey: "synthetic-model-failure",
      run: firstRun,
      settings,
    });
    const second = await persistDurableFollowup({
      queueKey: "synthetic-model-failure",
      run: secondRun,
      settings,
    });
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("synthetic agent exploded"));
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner({ ...secondRun, durableIds: [first.id, second.id] })).rejects.toThrow(
      "synthetic agent exploded",
    );
    const [carrier] = await loadDurableFollowups();
    expect(carrier?.delivery?.sourceDurableIds).toEqual([first.id, second.id]);
    expect(carrier?.delivery?.payloads).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Jarvis restarted") }),
    ]);
  });

  it("routes a staged restart blocker without replaying model or tool work", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const directTurn = createQueuedRun({
      messageId: "telegram:25606",
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
      originatingAccountId: "default",
      originatingThreadId: 21876,
    });
    const input = await persistDurableFollowup({
      queueKey: "direct-turn-restart-blocker",
      run: directTurn,
      settings,
    });
    const staged = await persistDurableFollowupDelivery({
      run: { ...directTurn, durableId: input.id },
      payloads: [RESTART_INTERRUPTED_TURN_PAYLOAD],
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    const restored = hydrateDurableFollowup(staged!, {});
    await expect(runner(restored)).rejects.toThrow("awaiting terminal delivery");
    const firstWake = drainSystemEventEntries(restored.run.sessionKey ?? "");
    const [reconciledRecord] = await loadDurableFollowups();
    await expect(runner(hydrateDurableFollowup(reconciledRecord, {}))).rejects.toThrow(
      "awaiting terminal delivery",
    );

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("Jarvis restarted"),
        }),
        channel: "telegram",
        to: "-1003783709877",
        accountId: "default",
        threadId: 21876,
        mirror: true,
        mirrorIdempotencyKey: `restart-recovery:${input.id}`,
        skipQueue: true,
      }),
    );
    expect(routeReplyMock.mock.calls[0]?.[0]?.payload.text).not.toContain("Continue");
    expect(firstWake).toEqual([
      expect.objectContaining({
        contextKey: `restart-followup:${input.id}`,
        text: expect.stringContaining("Continue from the saved conversation"),
      }),
    ]);
    // The first heartbeat has drained its event but has not delivered yet.
    // A durable queue retry must not enqueue a second recovery run.
    expect(drainSystemEventEntries(restored.run.sessionKey ?? "")).toEqual([]);
    const [recovering] = await loadDurableFollowups();
    expect(recovering?.restartRecovery).toEqual(
      expect.objectContaining({ receipt: "delivered", continuation: "delivering" }),
    );
    releaseDirectTurnRestartContinuation(input.id);
  });

  it("does not resend a restart receipt left at an ambiguous provider boundary", async () => {
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
    });
    const record = await persistDurableFollowup({
      queueKey: "ambiguous-restart-receipt",
      run: queued,
      settings: { mode: "followup", debounceMs: 0, cap: 20 },
      deliveryPayloads: [RESTART_INTERRUPTED_TURN_PAYLOAD],
    });
    await markDurableFollowupRestartReceiptDelivering(record.id);
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner(hydrateDurableFollowup(record, {}))).rejects.toThrow(
      "awaiting terminal delivery",
    );

    expect(routeReplyMock).not.toHaveBeenCalled();
    const [reconciled] = await loadDurableFollowups();
    expect(reconciled?.restartRecovery).toEqual(
      expect.objectContaining({ receipt: "delivered", continuation: "delivering" }),
    );
    releaseDirectTurnRestartContinuation(record.id);
    drainSystemEventEntries(queued.run.sessionKey ?? "");
  });

  it("does not resend a restart receipt after an ambiguous provider error", async () => {
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
    });
    const record = await persistDurableFollowup({
      queueKey: "errored-restart-receipt",
      run: queued,
      settings: { mode: "followup", debounceMs: 0, cap: 20 },
      deliveryPayloads: [RESTART_INTERRUPTED_TURN_PAYLOAD],
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });
    routeReplyMock.mockResolvedValueOnce({ ok: false, error: "provider timeout" });

    await expect(runner(hydrateDurableFollowup(record, {}))).rejects.toThrow("provider timeout");
    const [ambiguous] = await loadDurableFollowups();
    expect(ambiguous?.restartRecovery?.receipt).toBe("delivering");

    await expect(runner(hydrateDurableFollowup(ambiguous, {}))).rejects.toThrow(
      "awaiting terminal delivery",
    );
    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    releaseDirectTurnRestartContinuation(record.id);
    drainSystemEventEntries(queued.run.sessionKey ?? "");
  });

  it("defers recovery while the process that accepted the turn is still alive", async () => {
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
    });
    const record = await persistDurableFollowup({
      queueKey: "live-owner-restart-recovery",
      run: queued,
      settings: { mode: "followup", debounceMs: 0, cap: 20 },
      deliveryPayloads: [RESTART_INTERRUPTED_TURN_PAYLOAD],
    });
    const filePath = path.join(stateDir, "followup-queue", `${record.id}.json`);
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    // PID 1 is the live init/launchd process in supported runtime environments
    // and cannot be this Vitest worker.
    persisted.activeOwnerPid = 1;
    await fs.writeFile(filePath, JSON.stringify(persisted));
    const [ownedByOtherProcess] = await loadDurableFollowups();
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner(hydrateDurableFollowup(ownedByOtherProcess, {}))).rejects.toThrow(
      "active process 1",
    );

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(drainSystemEventEntries(queued.run.sessionKey ?? "")).toEqual([]);
  });

  it("drains later voice and text in FIFO order after terminalizing only the stale carrier", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queueKey = `stale-restart-head-${Date.now()}`;
    const carrierRun = createQueuedRun({
      messageId: "telegram:restart-carrier",
      prompt: "ambiguous original turn",
      originatingChannel: "telegram",
      originatingTo: "123",
    });
    const voiceRun = createQueuedRun({
      messageId: "telegram:voice",
      prompt: "[Audio] later voice",
      originatingChannel: "telegram",
      originatingTo: "123",
    });
    const textRun = createQueuedRun({
      messageId: "telegram:text",
      prompt: "later text",
      originatingChannel: "telegram",
      originatingTo: "123",
    });
    const carrier = await persistDurableFollowup({
      queueKey,
      run: carrierRun,
      settings,
      deliveryPayloads: [RESTART_INTERRUPTED_TURN_PAYLOAD],
      restartOwnerExecution: "not-started",
    });
    const voice = await persistDurableFollowup({ queueKey, run: voiceRun, settings });
    const text = await persistDurableFollowup({ queueKey, run: textRun, settings });
    for (const [record, createdAt] of [
      [carrier, 1],
      [voice, 2],
      [text, 3],
    ] as const) {
      const filePath = path.join(stateDir, "followup-queue", `${record.id}.json`);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      raw.createdAt = createdAt;
      await fs.writeFile(filePath, JSON.stringify(raw));
    }
    const carrierPath = path.join(stateDir, "followup-queue", `${carrier.id}.json`);
    const persisted = JSON.parse(await fs.readFile(carrierPath, "utf8"));
    persisted.activeOwnerPid = 98_765;
    await fs.writeFile(carrierPath, JSON.stringify(persisted));
    await markDurableFollowupRestartReceiptDelivered(carrier.id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await markDurableFollowupRestartContinuationDelivering(carrier.id);
      await markDurableFollowupRestartContinuationFailed({
        id: carrier.id,
        sessionKey: carrierRun.run.sessionKey!,
        error: RESTART_CONTINUATION_UNSTARTED_ERROR,
      });
    }
    await expect(
      terminalizeDurableFollowupRestartContinuationIfStale({
        id: carrier.id,
        sessionKey: carrierRun.run.sessionKey!,
        currentPid: 12_345,
        isProcessAlive: () => false,
      }),
    ).resolves.toBe(true);

    const [terminalCarrier, restoredVoice, restoredText] = await loadDurableFollowups();
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });
    runEmbeddedPiAgentMock.mockImplementation(async (params: { prompt: string }) => ({
      payloads: [{ text: `handled:${params.prompt}` }],
      meta: {},
    }));
    enqueueFollowupRun(queueKey, hydrateDurableFollowup(terminalCarrier, {}), settings, "none");
    enqueueFollowupRun(queueKey, hydrateDurableFollowup(restoredVoice, {}), settings, "none");
    enqueueFollowupRun(queueKey, hydrateDurableFollowup(restoredText, {}), settings, "none");

    scheduleFollowupDrain(queueKey, runner);
    await vi.waitFor(() => expect(getExistingFollowupQueue(queueKey)).toBeUndefined(), {
      timeout: 5_000,
    });

    expect(
      runEmbeddedPiAgentMock.mock.calls.map(([params]) => (params as { prompt: string }).prompt),
    ).toEqual(["[Audio] later voice", "later text"]);
    expect(routeReplyMock.mock.calls.map(([params]) => params.payload.text)).toEqual([
      "handled:[Audio] later voice",
      "handled:later text",
    ]);
    // The already delivered restart receipt was converted to an empty stage:
    // it is neither resent nor allowed to consume either later durable record.
    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });

  it("awaits explicit provider routing for a durable same-channel followup", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
      originatingAccountId: "default",
      originatingThreadId: 24176,
    });
    const input = await persistDurableFollowup({
      queueKey: "durable-same-channel-provider-ack",
      run: queued,
      settings,
    });
    let acceptProviderDelivery: (() => void) | undefined;
    routeReplyMock.mockImplementationOnce(
      async () =>
        await new Promise<{ ok: true }>((resolve) => {
          acceptProviderDelivery = () => resolve({ ok: true });
        }),
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Visible queued final." }],
      meta: {},
    });
    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      liveReplyRoute: {
        originatingChannel: "telegram",
        originatingTo: "-1003783709877",
        originatingAccountId: "default",
        originatingThreadId: 24176,
      },
      failureMode: "throw-durable",
    });

    let completed = false;
    const running = runner({ ...queued, durableId: input.id }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(routeReplyMock).toHaveBeenCalledTimes(1));

    expect(completed).toBe(false);
    expect(onBlockReply).not.toHaveBeenCalled();
    acceptProviderDelivery?.();
    await running;
    expect(completed).toBe(true);
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: false, skipQueue: true }),
    );
  });

  it("keeps the restart receipt while durable model and tool work is running", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
      originatingThreadId: 24176,
    });
    const input = await persistDurableFollowup({
      queueKey: "durable-running-restart-receipt",
      run: queued,
      settings,
    });
    let finishAgent: (() => void) | undefined;
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async () =>
        await new Promise<{ payloads: Array<{ text: string }>; meta: Record<string, never> }>(
          (resolve) => {
            finishAgent = () => resolve({ payloads: [{ text: "Exact final." }], meta: {} });
          },
        ),
    );
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    const running = runner({ ...queued, durableId: input.id });
    await vi.waitFor(() => expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1));
    const [active] = await loadDurableFollowups();
    expect(active?.delivery?.payloads).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Jarvis restarted") }),
    ]);

    finishAgent?.();
    await running;
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { text: "Exact final." } }),
    );
  });

  it("never treats live-dispatch enqueue as durable delivery fallback", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "-1003783709877",
      originatingAccountId: "default",
      originatingThreadId: 24176,
    });
    const input = await persistDurableFollowup({
      queueKey: "durable-same-channel-route-failure",
      run: queued,
      settings,
    });
    const staged = await persistDurableFollowupDelivery({
      run: { ...queued, durableId: input.id },
      payloads: [{ text: "Provider-confirmed final only." }],
    });
    routeReplyMock.mockResolvedValueOnce({ ok: false, error: "provider unavailable" });
    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      liveReplyRoute: {
        originatingChannel: "telegram",
        originatingTo: "-1003783709877",
        originatingAccountId: "default",
        originatingThreadId: 24176,
      },
      failureMode: "throw-durable",
    });

    await expect(runner(hydrateDurableFollowup(staged!, {}))).rejects.toThrow(
      "provider unavailable",
    );
    expect(onBlockReply).not.toHaveBeenCalled();
    const [record] = await loadDurableFollowups();
    expect(record?.delivery?.payloads).toEqual([{ text: "Provider-confirmed final only." }]);

    routeReplyMock.mockResolvedValueOnce({ ok: true });
    await runner(hydrateDurableFollowup(record, {}));
    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    const [delivered] = await loadDurableFollowups();
    expect(delivered?.delivery?.payloads).toEqual([]);
  });

  it.each([
    { label: "empty", payloads: [] },
    { label: "partial", payloads: [{ text: "incomplete result" }] },
  ])("rejects an aborted $label durable result before staging or sending", async ({ payloads }) => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      messageId: "telegram:assembled-first",
      originatingChannel: "telegram",
      originatingTo: "123",
    });
    const input = await persistDurableFollowup({
      queueKey: `aborted-${payloads.length ? "partial" : "empty"}`,
      run: queued,
      settings,
    });
    const secondInput = await persistDurableFollowup({
      queueKey: input.queueKey,
      run: {
        ...queued,
        prompt: "second assembled input",
        messageId: "telegram:assembled-second",
      },
      settings,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads,
      meta: { aborted: true },
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner({ ...queued, durableIds: [input.id, secondInput.id] })).rejects.toThrow(
      "Durable followup agent run aborted",
    );
    expect(routeReplyMock).not.toHaveBeenCalled();
    const [record] = await loadDurableFollowups();
    expect(record?.id).toBe(input.id);
    expect(record?.delivery?.sourceDurableIds).toEqual([input.id, secondInput.id]);
    expect(record?.delivery?.processedMessageKeys).toHaveLength(2);
    expect(record?.restartRecovery?.ownerExecution).toBe("started");
    expect(record?.delivery?.payloads).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Jarvis restarted") }),
    ]);

    // Retry the consolidated carrier exactly as a gateway restart would. The
    // partially executed batch stays delivery-only: neither its assembled
    // prompt nor persisted tool-result history is replayed through a second
    // model invocation. The tagged continuation will resume in the transcript.
    await expect(runner(hydrateDurableFollowup(record, {}))).rejects.toThrow(
      "awaiting terminal delivery",
    );
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    const [recovering] = await loadDurableFollowups();
    expect(recovering?.delivery?.sourceDurableIds).toEqual([input.id, secondInput.id]);
    expect(recovering?.restartRecovery).toEqual(
      expect.objectContaining({ receipt: "delivered", continuation: "delivering" }),
    );
    releaseDirectTurnRestartContinuation(input.id);
    drainSystemEventEntries(queued.run.sessionKey ?? "");
  });

  it("restores model-complete output and retries delivery without rerunning the agent", async () => {
    const settings = { mode: "collect" as const, debounceMs: 0, cap: 20 };
    const firstRun = createQueuedRun({
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: { config: { channels: { discord: { token: "runtime-secret" } } } },
    });
    const secondRun = createQueuedRun({
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    });
    const first = await persistDurableFollowup({
      queueKey: "delivery-retry",
      run: firstRun,
      settings,
    });
    const second = await persistDurableFollowup({
      queueKey: "delivery-retry",
      run: secondRun,
      settings,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "agent finished once" }],
      meta: {},
    });
    routeReplyMock.mockResolvedValueOnce({ ok: false, error: "adapter unavailable" });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });
    const synthetic = {
      ...firstRun,
      durableIds: [first.id, second.id],
      prompt: "synthetic collected prompt",
    };

    await expect(runner(synthetic)).rejects.toThrow("adapter unavailable");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const [deliveryRecord] = await loadDurableFollowups();
    expect(deliveryRecord?.delivery?.sourceDurableIds).toEqual([first.id, second.id]);

    // Simulate process restart: hydrate from disk with current runtime config,
    // then retry the route. The model/tool executor must remain untouched.
    routeReplyMock.mockResolvedValueOnce({ ok: true });
    await runner(hydrateDurableFollowup(deliveryRecord, {}));
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { text: "agent finished once" } }),
    );
    await Promise.all([first.id, second.id].map((id) => ackDurableFollowup(id)));
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });

  it("checkpoints a successful payload prefix before retrying a failed suffix", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "123",
    });
    const input = await persistDurableFollowup({
      queueKey: "delivery-prefix-checkpoint",
      run: queued,
      settings,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "a" }, { text: "b" }],
      meta: {},
    });
    routeReplyMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "media failed" });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner({ ...queued, durableId: input.id })).rejects.toThrow("media failed");
    const [deliveryRecord] = await loadDurableFollowups();
    expect(deliveryRecord?.delivery?.payloads).toEqual([{ text: "b" }]);

    routeReplyMock.mockResolvedValueOnce({ ok: true });
    await runner(hydrateDurableFollowup(deliveryRecord, {}));

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock.mock.calls.map(([call]) => call.payload.text)).toEqual(["a", "b", "b"]);
    await ackDurableFollowup(deliveryRecord?.id);
    await expect(loadDurableFollowups()).resolves.toEqual([]);
  });

  it("drains a same-process staged FIFO prefix before later collected input", async () => {
    const settings = { mode: "collect" as const, debounceMs: 0, cap: 20 };
    const queueKey = `delivery-retry-fifo-${Date.now()}`;
    const firstRun = createQueuedRun({
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    });
    const secondRun = createQueuedRun({
      messageId: "discord:second",
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    });
    const first = await persistDurableFollowup({
      queueKey,
      run: firstRun,
      settings,
    });
    const second = await persistDurableFollowup({
      queueKey,
      run: secondRun,
      settings,
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    enqueueFollowupRun(queueKey, { ...firstRun, durableId: first.id }, settings, "none");
    enqueueFollowupRun(queueKey, { ...secondRun, durableId: second.id }, settings, "none");

    // The collect drain builds A+B itself. Their agent/tool turn completes,
    // stages its delivery, then the first provider call fails while both
    // original items remain at the in-memory FIFO head.
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "original staged output" }],
      meta: {},
    });
    routeReplyMock.mockResolvedValueOnce({ ok: false, error: "adapter unavailable" });
    scheduleFollowupDrain(queueKey, runner);
    await vi.waitFor(() => {
      expect(routeReplyMock).toHaveBeenCalledTimes(1);
      // The drain immediately schedules its bounded retry, so `draining`
      // becomes true again. The persisted retry boundary proves the failed
      // attempt finished while its replacement is still waiting.
      expect(getExistingFollowupQueue(queueKey)?.nextAttemptAt).toBeTypeOf("number");
    });
    expect(getExistingFollowupQueue(queueKey)?.items.map((item) => item.durableId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    await expect(loadDurableFollowups()).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        delivery: expect.objectContaining({ sourceDurableIds: [first.id, second.id] }),
      }),
    ]);

    // C arrives before the scheduled retry. Exact-prefix discovery must select
    // only [A,B], even though collect mode now sees an expanded [A,B,C] queue.
    const laterRun = createQueuedRun({
      messageId: "discord:later",
      prompt: "later durable input",
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    });
    const later = await persistDurableFollowup({
      queueKey,
      run: laterRun,
      settings,
    });
    enqueueFollowupRun(queueKey, hydrateDurableFollowup(later, {}), settings, "none");
    let releaseLaterModel!: () => void;
    const laterModelGate = new Promise<void>((resolve) => {
      releaseLaterModel = resolve;
    });
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      // Hold C at model entry so the assertion below can prove that the staged
      // carrier completed by itself: C remains durable and has no outbound
      // delivery or acknowledgement until this distinct turn is released.
      await laterModelGate;
      return { payloads: [{ text: "later input output" }], meta: {} };
    });
    routeReplyMock.mockResolvedValue({ ok: true });

    scheduleFollowupDrain(queueKey, runner);
    await vi.waitFor(() => expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2), {
      // The durable retry floor is one second; leave headroom for a busy CI
      // worker instead of racing the test framework's one-second default.
      timeout: 5_000,
    });
    await expect(loadDurableFollowups()).resolves.toEqual([
      expect.objectContaining({
        id: later.id,
        delivery: expect.objectContaining({
          payloads: [
            expect.objectContaining({
              text: expect.stringContaining("Jarvis restarted"),
            }),
          ],
        }),
      }),
    ]);
    expect(getExistingFollowupQueue(queueKey)?.items.map((item) => item.durableId)).toEqual([
      later.id,
    ]);
    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    expect(routeReplyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ payload: { text: "original staged output" } }),
    );

    releaseLaterModel();
    await vi.waitFor(async () => {
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
      await expect(loadDurableFollowups()).resolves.toEqual([]);
    });

    // First retry sends A+B's staged payload without a second old model turn.
    // Only then does C execute and deliver in a distinct second model turn.
    expect(routeReplyMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ payload: { text: "later input output" } }),
    );
    expect(getExistingFollowupQueue(queueKey)).toBeUndefined();
    clearFollowupQueue(queueKey);
  });

  it("restores an empty completed stage without rerunning the agent", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "123",
    });
    const input = await persistDurableFollowup({
      queueKey: "empty-delivery-retry",
      run: queued,
      settings,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await runner({ ...queued, durableId: input.id });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const [deliveryRecord] = await loadDurableFollowups();
    expect(deliveryRecord?.delivery?.payloads).toEqual([]);

    // Restart hydration must preserve stage presence even though the payload
    // array is empty. NO_REPLY/suppressed work is complete, not missing.
    await runner(hydrateDurableFollowup(deliveryRecord, {}));
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).not.toHaveBeenCalled();
  });

  it("restores a suppressed automatic reply without rerunning the agent", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "268300329",
      run: { messageProvider: "heartbeat" },
    });
    const input = await persistDurableFollowup({
      queueKey: "suppressed-delivery-retry",
      run: queued,
      settings,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "automatic reply that must be suppressed" }],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      meta: {},
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await runner({ ...queued, durableId: input.id });
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const [deliveryRecord] = await loadDurableFollowups();
    expect(deliveryRecord?.delivery?.payloads).toEqual([]);

    await runner(hydrateDurableFollowup(deliveryRecord, {}));
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).not.toHaveBeenCalled();
  });

  it("retries staged compaction output after bookkeeping failure without rerunning tools", async () => {
    const settings = { mode: "followup" as const, debounceMs: 0, cap: 20 };
    const queued = createQueuedRun({
      originatingChannel: "telegram",
      originatingTo: "123",
      run: { verboseLevel: "on" },
    });
    const input = await persistDurableFollowup({
      queueKey: "bookkeeping-retry",
      run: queued,
      settings,
    });
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    // A directory cannot be atomically replaced by the JSON session writer.
    // This deterministically fails compaction bookkeeping after delivery stage
    // publication, exercising the crash/retry boundary without mocking it.
    const invalidStorePath = await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-store-dir-"));
    mockCompactionRun({
      willRetry: true,
      result: {
        payloads: [{ text: "agent finished once" }],
        meta: { agentMeta: { lastCallUsage: { input: 100, output: 20, total: 120 } } },
      },
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath: invalidStorePath,
      defaultModel: "anthropic/claude-opus-4-5",
      failureMode: "throw-durable",
    });

    await expect(runner({ ...queued, durableId: input.id })).rejects.toThrow();
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).not.toHaveBeenCalled();
    const [deliveryRecord] = await loadDurableFollowups();
    expect(deliveryRecord?.delivery?.payloads).toEqual([
      { text: "🧹 Auto-compaction complete (count 1)." },
      { text: "agent finished once" },
    ]);

    await runner(hydrateDurableFollowup(deliveryRecord, {}));
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    expect(routeReplyMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ payload: { text: "🧹 Auto-compaction complete (count 1)." } }),
    );
    expect(routeReplyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ payload: { text: "agent finished once" } }),
    );
    await fs.rm(invalidStorePath, { recursive: true, force: true });
  });
});

describe("createFollowupRunner agentDir forwarding", () => {
  it("passes queued run agentDir to runEmbeddedPiAgent", async () => {
    runEmbeddedPiAgentMock.mockClear();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });
    const agentDir = path.join("/tmp", "agent-dir");
    const queued = createQueuedRun();
    await runner({
      ...queued,
      run: {
        ...queued.run,
        agentDir,
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as { agentDir?: string };
    expect(call?.agentDir).toBe(agentDir);
  });
});
