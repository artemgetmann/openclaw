import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
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

    await runMemoryFlushIfNeeded({
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
  });
});
