import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  estimatePromptTokensForMemoryFlush,
  readPromptTokensFromSessionLog,
  runMemoryFlushIfNeeded,
} from "./agent-runner-memory.js";
import type { FollowupRun } from "./queue.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const tempDirs: string[] = [];

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => runWithModelFallbackMock(params),
}));

beforeEach(() => {
  runEmbeddedPiAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runWithModelFallbackMock.mockImplementation(
    async ({
      provider,
      model,
      run,
    }: {
      provider: string;
      model: string;
      run: (provider: string, model: string) => Promise<unknown>;
    }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }),
  );
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf-8",
  );
}

describe("runMemoryFlushIfNeeded", () => {
  it("does not resurrect a usage snapshot from before the latest compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-compaction-boundary-"));
    tempDirs.push(tmp);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1003783709877:topic:21876";
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      totalTokens: 177_807,
      totalTokensFresh: false,
      inputTokens: 4_061_906,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 1, id: "session" }),
        JSON.stringify({ usage: { input: 177_807, output: 7_807 } }),
        JSON.stringify({
          type: "compaction",
          id: "compaction-1",
          summary: "compressed",
          firstKeptEntryId: "message-1",
          tokensBefore: 185_614,
        }),
      ].join("\n"),
      "utf-8",
    );

    await expect(
      readPromptTokensFromSessionLog("session", sessionEntry, "agent:main:main", {
        storePath,
      }),
    ).resolves.toBeUndefined();

    const cfg = { agents: { defaults: {} } };
    const followupRun = {
      prompt: "continue",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: tmp,
        sessionId: "session",
        sessionKey,
        sessionFile,
        workspaceDir: tmp,
        config: cfg,
        skillsSnapshot: {},
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        persistedPromptTokens: 4_061_906,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;
    const updatedEntry = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx: {} as TemplateContext,
      defaultModel: "gpt-5.6-sol",
      agentCfgContextTokens: 272_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(followupRun.run.persistedPromptTokens).toBeUndefined();
    expect(updatedEntry?.totalTokens).toBeUndefined();
    expect(updatedEntry?.totalTokensFresh).toBe(false);
    expect(updatedEntry?.inputTokens).toBeUndefined();

    await fs.appendFile(
      sessionFile,
      `\n${JSON.stringify({ usage: { input: 1_200, output: 80 } })}`,
      "utf-8",
    );
    await expect(
      readPromptTokensFromSessionLog("session", sessionEntry, "agent:main:main", {
        storePath,
      }),
    ).resolves.toEqual({ promptTokens: 1_200, outputTokens: 80 });
  });

  it("drops stale queued preflight usage when a CLI transcript has only zero usage", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-zero-cli-usage-"));
    tempDirs.push(tmp);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1003783709877:topic:21876";
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      totalTokens: 177_807,
      totalTokensFresh: false,
      inputTokens: 4_061_906,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ usage: { input: 177_807, output: 7_807 } }),
        JSON.stringify({
          message: {
            role: "assistant",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );
    const cfg = { agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } };
    const followupRun = {
      prompt: "continue",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: tmp,
        sessionId: "session",
        sessionKey,
        sessionFile,
        workspaceDir: tmp,
        config: cfg,
        skillsSnapshot: {},
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        persistedPromptTokens: 4_061_906,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx: {} as TemplateContext,
      defaultModel: "gpt-5.6-sol",
      agentCfgContextTokens: 272_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(followupRun.run.persistedPromptTokens).toBeUndefined();
    expect(sessionStore[sessionKey].totalTokens).toBe(177_807);
    expect(sessionStore[sessionKey].totalTokensFresh).toBe(false);

    followupRun.run.persistedPromptTokens = 4_061_906;
    await fs.unlink(sessionFile);
    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx: {} as TemplateContext,
      defaultModel: "gpt-5.6-sol",
      agentCfgContextTokens: 272_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });
    expect(followupRun.run.persistedPromptTokens).toBe(4_061_906);

    await fs.writeFile(sessionFile, "{incomplete", "utf-8");
    await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx: {} as TemplateContext,
      defaultModel: "gpt-5.6-sol",
      agentCfgContextTokens: 272_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });
    expect(followupRun.run.persistedPromptTokens).toBe(4_061_906);
  });

  it("refreshes stale cumulative usage when memory flushing is disabled", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-reconcile-"));
    tempDirs.push(tmp);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1003783709877:topic:21876";
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      totalTokens: 177_807,
      totalTokensFresh: false,
      // Some providers accumulate this counter across tool turns. It is not a
      // trustworthy current-context measurement once transcript usage exists.
      inputTokens: 4_061_906,
      contextTokens: 272_000,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ usage: { input: 177_807, output: 7_807 } }),
      "utf-8",
    );

    const cfg = {
      agents: {
        defaults: {
          compaction: { memoryFlush: { enabled: false } },
        },
      },
    };
    const followupRun = {
      prompt: "repeat the final response",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: tmp,
        sessionId: "session",
        sessionKey,
        messageProvider: "telegram",
        sessionFile,
        workspaceDir: tmp,
        config: cfg,
        skillsSnapshot: {},
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        persistedPromptTokens: 4_061_906,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const updatedEntry = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: followupRun.prompt,
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "openai-codex/gpt-5.6-sol",
      agentCfgContextTokens: 272_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(followupRun.run.persistedPromptTokens).toBe(
      185_614 + (estimatePromptTokensForMemoryFlush(followupRun.prompt) ?? 0),
    );
    expect(updatedEntry?.totalTokens).toBe(177_807);
    expect(updatedEntry?.totalTokensFresh).toBe(true);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(177_807);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("refreshes stale cumulative usage when the sandbox workspace is read-only", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-reconcile-ro-"));
    tempDirs.push(tmp);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1003783709877:topic:21876";
    const sessionFile = path.join(tmp, "session.jsonl");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile,
      totalTokens: 177_807,
      totalTokensFresh: false,
      inputTokens: 4_061_906,
      contextTokens: 272_000,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });
    await fs.writeFile(
      sessionFile,
      JSON.stringify({ usage: { input: 177_807, output: 7_807 } }),
      "utf-8",
    );

    const cfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
          compaction: { reserveTokensFloor: 20_000 },
        },
      },
    } as const;
    const followupRun = {
      prompt: "repeat the final response",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: tmp,
        sessionId: "session",
        sessionKey,
        messageProvider: "telegram",
        sessionFile,
        workspaceDir: tmp,
        config: cfg,
        skillsSnapshot: {},
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        persistedPromptTokens: 4_061_906,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const updatedEntry = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: followupRun.prompt,
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "openai-codex/gpt-5.6-sol",
      agentCfgContextTokens: 272_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(followupRun.run.persistedPromptTokens).toBe(
      185_614 + (estimatePromptTokensForMemoryFlush(followupRun.prompt) ?? 0),
    );
    expect(updatedEntry?.totalTokens).toBe(177_807);
    expect(updatedEntry?.totalTokensFresh).toBe(true);
  });

  it("runs for over-budget CLI providers and clears the stale CLI resume id after compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-memory-flush-"));
    tempDirs.push(tmp);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 500_000,
      totalTokensFresh: true,
      inputTokens: 500_000,
      contextTokens: 200_000,
      compactionCount: 0,
      memoryFlushCompactionCount: 0,
      cliSessionIds: {
        "openai-codex": "oversized-codex-session",
      },
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(
      async (params: {
        prompt?: string;
        memoryFlushWritePath?: string;
        onAgentEvent?: (evt: {
          stream?: string;
          data?: { phase?: string; completed?: boolean };
        }) => void;
      }) => {
        params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", completed: true } });
        return { payloads: [], meta: {} };
      },
    );

    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "openai-codex": { command: "codex" },
          },
          compaction: {
            reserveTokensFloor: 20_000,
          },
        },
      },
    };
    const followupRun = {
      prompt: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: tmp,
        sessionId: "session",
        sessionKey,
        messageProvider: "telegram",
        sessionFile: path.join(tmp, "session.jsonl"),
        workspaceDir: tmp,
        config: cfg,
        skillsSnapshot: {},
        provider: "openai-codex",
        model: "gpt-5.5",
        persistedPromptTokens: 500_000,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const updatedEntry = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: "hello",
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "openai-codex/gpt-5.5",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | { prompt?: string; memoryFlushWritePath?: string }
      | undefined;
    expect(flushCall?.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall?.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    expect(stored[sessionKey].memoryFlushCompactionCount).toBe(1);
    expect(stored[sessionKey].cliSessionIds?.["openai-codex"]).toBeUndefined();
    expect(stored[sessionKey].totalTokens).toBeUndefined();
    expect(stored[sessionKey].totalTokensFresh).toBe(false);
    expect(followupRun.run.persistedPromptTokens).toBeUndefined();
    expect(updatedEntry?.totalTokens).toBeUndefined();
    expect(updatedEntry?.totalTokensFresh).toBe(false);
  });

  it("clears stale prompt tokens after a hard-reserve memory flush without compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-flush-hard-reserve-"));
    tempDirs.push(tmp);
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:telegram:group:-1003783709877:topic:17592";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 195_000,
      totalTokensFresh: true,
      inputTokens: 8_000,
      outputTokens: 512,
      cacheRead: 187_000,
      contextTokens: 200_000,
      compactionCount: 0,
      memoryFlushCompactionCount: 0,
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [], meta: {} });

    const cfg = {
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor: 20_000,
          },
        },
      },
    };
    const followupRun = {
      prompt: "continue the conversation",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: tmp,
        sessionId: "session",
        sessionKey,
        messageProvider: "telegram",
        sessionFile: path.join(tmp, "session.jsonl"),
        workspaceDir: tmp,
        config: cfg,
        skillsSnapshot: {},
        provider: "openai-codex",
        model: "gpt-5.5",
        persistedPromptTokens: 195_000,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const updatedEntry = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      promptForEstimate: "continue the conversation",
      sessionCtx: { Provider: "telegram" } as unknown as TemplateContext,
      defaultModel: "openai-codex/gpt-5.5",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(followupRun.run.persistedPromptTokens).toBeUndefined();
    expect(updatedEntry?.compactionCount).toBe(0);
    expect(updatedEntry?.memoryFlushCompactionCount).toBe(0);
    expect(updatedEntry?.totalTokens).toBeUndefined();
    expect(updatedEntry?.totalTokensFresh).toBe(false);
    expect(updatedEntry?.inputTokens).toBeUndefined();
    expect(updatedEntry?.cacheRead).toBeUndefined();

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(0);
    expect(stored[sessionKey].memoryFlushCompactionCount).toBe(0);
    expect(stored[sessionKey].totalTokens).toBeUndefined();
    expect(stored[sessionKey].totalTokensFresh).toBe(false);
    expect(stored[sessionKey].cacheRead).toBeUndefined();
  });
});
