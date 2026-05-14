import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runCliAgent } from "./cli-runner.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";

const supervisorSpawnMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const bridgeRunMock = vi.fn();
const prepareCliBundleMcpConfigMock = vi.fn();
const ZERO_TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../gateway/mcp-http.js", () => ({
  ensureMcpLoopbackServer: vi.fn(async () => ({ port: 9123, close: vi.fn() })),
  getActiveMcpLoopbackRuntime: vi.fn(() => ({
    port: 9123,
    ownerToken: "owner-token",
    nonOwnerToken: "non-owner-token",
  })),
  registerMcpLoopbackConfigOverride: vi.fn(() => vi.fn()),
  createMcpLoopbackServerConfig: (port: number) => ({
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
      },
    },
  }),
}));

vi.mock("./claude-bridge.js", () => ({
  runClaudeBridgeAgent: (...args: unknown[]) => bridgeRunMock(...args),
}));

vi.mock("./cli-runner/bundle-mcp.js", () => ({
  prepareCliBundleMcpConfig: (...args: unknown[]) => prepareCliBundleMcpConfigMock(...args),
}));

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

async function readTranscriptMessages(sessionFile: string) {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            stopReason?: string;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            content?: Array<{
              type?: string;
              text?: string;
              id?: string;
              name?: string;
              arguments?: unknown;
            }>;
          };
        },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function createTextClaudeCliConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        cliBackends: {
          "claude-cli": {
            command: "claude",
            args: ["-p"],
            resumeArgs: ["-p", "--resume", "{sessionId}"],
            output: "text",
            input: "arg",
            modelArg: "--model",
            sessionArg: "--session-id",
            sessionMode: "always",
            systemPromptArg: "--append-system-prompt",
            systemPromptWhen: "first",
            liveSession: undefined,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function appendTranscriptMessages(
  sessionFile: string,
  messages: Array<Parameters<SessionManager["appendMessage"]>[0]>,
) {
  const sessionManager = SessionManager.open(sessionFile);
  for (const message of messages) {
    sessionManager.appendMessage(message);
  }
}

function extractPromptArgFromSpawn(): string {
  const input = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
  const argv = input.argv ?? [];
  return argv[argv.length - 1] ?? "";
}

describe("runCliAgent with process supervisor", () => {
  const originalClaudeBridgePromptMode = process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE;
  const originalClaudeBridgeSplit = process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT;
  const originalClaudeBridgeUseNormalPromptStack =
    process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK;

  beforeEach(() => {
    supervisorSpawnMock.mockClear();
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    bridgeRunMock.mockClear();
    prepareCliBundleMcpConfigMock.mockReset();
    prepareCliBundleMcpConfigMock.mockImplementation(async ({ backend }: { backend: unknown }) => ({
      backend,
    }));
    if (originalClaudeBridgePromptMode === undefined) {
      delete process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE;
    } else {
      process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE = originalClaudeBridgePromptMode;
    }
    if (originalClaudeBridgeSplit === undefined) {
      delete process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT;
    } else {
      process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT = originalClaudeBridgeSplit;
    }
    if (originalClaudeBridgeUseNormalPromptStack === undefined) {
      delete process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK;
    } else {
      process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK =
        originalClaudeBridgeUseNormalPromptStack;
    }
  });

  it("runs CLI through supervisor and returns payload", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      mode?: string;
      timeoutMs?: number;
      noOutputTimeoutMs?: number;
      replaceExistingScope?: boolean;
      scopeKey?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv?.[0]).toBe("codex");
    expect(input.timeoutMs).toBe(1_000);
    expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(input.replaceExistingScope).toBe(true);
    expect(input.scopeKey).toContain("thread-123");
  });

  it("streams claude-cli stream-json text deltas through partial reply callbacks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-cli-bridge-prompt-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "# AGENTS.md - Test Workspace\n\nWorkspace bootstrap marker for Claude CLI source isolation.\n",
      "utf-8",
    );
    const stdout = [
      JSON.stringify({ type: "init", session_id: "claude-session-1" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " there" },
        },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "Hello there",
        usage: { input_tokens: 7, output_tokens: 2, cache_creation_input_tokens: 3 },
      }),
    ].join("\n");
    supervisorSpawnMock.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => ({
        runId: "run-supervisor",
        pid: 1234,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
            input.onStdout?.(`${stdout}\n`);
            cb?.();
          }),
          end: vi.fn(),
        },
        wait: vi.fn().mockImplementation(async () => {
          await new Promise(() => {});
          return {
            reason: "exit",
            exitCode: 0,
            exitSignal: null,
            durationMs: 50,
            stdout,
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          };
        }),
        cancel: vi.fn(),
      }),
    );
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();

    try {
      const result = await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir,
        config: createTextClaudeCliConfig(),
        prompt: "hi",
        provider: "claude-cli",
        model: "opus",
        timeoutMs: 1_000,
        runId: "run-stream",
        onAssistantMessageStart,
        onPartialReply,
      });

      expect(result.payloads?.[0]?.text).toBe("Hello there");
      expect(result.meta.agentMeta?.sessionId).toBe("claude-session-1");
      expect(result.meta.agentMeta?.usage?.cacheWrite).toBe(3);
      expect(result.meta.systemPromptReport?.injectedWorkspaceFiles?.[0]?.name).toBe("AGENTS.md");
      expect(result.meta.systemPromptReport?.systemPrompt.projectContextChars).toBe(0);
      expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
      expect(onPartialReply.mock.calls).toEqual([[{ text: "Hello" }], [{ text: "Hello there" }]]);
      const spawnInput = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
      const argv = spawnInput.argv ?? [];
      const systemPromptIndex = argv.indexOf("--append-system-prompt");
      expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
      const systemPrompt = argv[systemPromptIndex + 1] ?? "";
      expect(systemPrompt).toContain(
        "Your home is the runtime workspace at ~/.openclaw/workspace.",
      );
      expect(systemPrompt).toContain("~/.openclaw/workspace/AGENTS.md first");
      expect(systemPrompt).toContain("# OpenClaw Workspace Bootstrap");
      expect(systemPrompt).toContain("Do not treat Claude Code user-level memory");
      expect(systemPrompt).toContain(`${workspaceDir}/AGENTS.md`);
      expect(systemPrompt).toContain("Workspace bootstrap marker for Claude CLI source isolation.");
      expect(systemPrompt).not.toContain("# Project Context");
      expect(JSON.stringify(argv)).not.toContain("Tools are disabled");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes workspace skills in the bridge-safe claude-cli prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-skills-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "# AGENTS.md - Test Workspace\n\nBridge-safe skill injection test instructions.\n",
      "utf-8",
    );
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "tone-of-voice"),
      name: "tone-of-voice",
      description: "Artem tone guidance",
      body: "# Artem tone of voice\n\nUse direct, founder-mode language.\n",
    });

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      const result = await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir,
        config: createTextClaudeCliConfig(),
        prompt: "hi",
        provider: "claude-cli",
        model: "opus",
        timeoutMs: 1_000,
        runId: "run-skills",
      });

      const spawnInput = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
      const argv = spawnInput.argv ?? [];
      const systemPromptIndex = argv.indexOf("--append-system-prompt");
      expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
      const systemPrompt = argv[systemPromptIndex + 1] ?? "";
      expect(systemPrompt).toContain("Do not treat Claude Code user-level memory");
      expect(systemPrompt).toContain("<available_skills>");
      expect(systemPrompt).toContain("tone-of-voice");
      expect(systemPrompt).toContain("Artem tone guidance");
      expect(systemPrompt).toContain("Bridge-safe skill injection test instructions.");
      expect(result.meta.systemPromptReport?.skills.promptChars).toBeGreaterThan(0);
      expect(result.meta.systemPromptReport?.skills.entries.map((entry) => entry.name)).toContain(
        "tone-of-voice",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards streaming callbacks to the claude bridge backend", async () => {
    const preparedBackend = { command: "claude", args: ["--mcp-overlay"] };
    prepareCliBundleMcpConfigMock.mockResolvedValueOnce({ backend: preparedBackend });
    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        durationMs: 10,
        agentMeta: {
          sessionId: "bridge-session",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();

    await runCliAgent({
      sessionId: "s-bridge",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-bridge",
      onAssistantMessageStart,
      onPartialReply,
      onBlockReply,
    });

    expect(bridgeRunMock).toHaveBeenCalledTimes(1);
    expect(bridgeRunMock.mock.calls[0]?.[0]).toMatchObject({
      configBackend: preparedBackend,
      onAssistantMessageStart,
      onPartialReply,
      onBlockReply,
    });
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-2",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("produced no output");
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-2b",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(opts).toMatchObject({ sessionKey: "agent:main:main" });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-3",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("exceeded timeout");
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:retry",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-retry-failure",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("rate limit exceeded");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-agent workspace when workspaceDir is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-runner-"));
    const fallbackWorkspace = path.join(tempDir, "workspace-main");
    await fs.mkdir(fallbackWorkspace, { recursive: true });
    const cfg = {
      agents: {
        defaults: {
          workspace: fallbackWorkspace,
        },
      },
    } satisfies OpenClawConfig;

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:missing-workspace",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: undefined as unknown as string,
        config: cfg,
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-4",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { cwd?: string };
    expect(input.cwd).toBe(path.resolve(fallbackWorkspace));
  });

  it("mirrors successful one-shot CLI turns into the shared session transcript", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-transcript-"));
    const sessionFile = path.join(tempDir, "session.jsonl");

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "stored nonce",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s-cli",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "remember nonce N-1234",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-cli-transcript",
      });

      const messages = await readTranscriptMessages(sessionFile);
      expect(messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "remember nonce N-1234" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "stored nonce" }],
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects recent non-Claude shared transcript into a first claude-cli prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-cli-replay-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    appendTranscriptMessages(sessionFile, [
      {
        role: "user",
        content: [{ type: "text", text: "Remember setup nonce CODEX-771." }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Stored CODEX-771 from Codex." }],
        api: "openai-codex-responses",
        provider: "codex-cli",
        model: "gpt-5.5",
        usage: ZERO_TEST_USAGE,
        stopReason: "stop",
        timestamp: Date.now() + 1,
      },
    ]);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "claude ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s-claude-replay",
        sessionFile,
        workspaceDir: tempDir,
        config: createTextClaudeCliConfig(),
        prompt: "What was the setup nonce?",
        provider: "claude-cli",
        model: "haiku",
        timeoutMs: 1_000,
        runId: "run-claude-replay",
      });

      const prompt = extractPromptArgFromSpawn();
      expect(prompt).toContain("Recent shared OpenClaw session history");
      expect(prompt).toContain("User:\nRemember setup nonce CODEX-771.");
      expect(prompt).toContain("Assistant (codex-cli/gpt-5.5):\nStored CODEX-771 from Codex.");
      expect(prompt).toContain("Current user message:\nWhat was the setup nonce?");
      expect(prompt.match(/What was the setup nonce\?/g)).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps newest replay turns verbatim when older transcript turns are compacted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-cli-replay-compact-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const originalReplayMaxChars = process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_MAX_CHARS;
    process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_MAX_CHARS = "2200";
    appendTranscriptMessages(sessionFile, [
      {
        role: "user",
        content: [{ type: "text", text: `Older setup ${"old ".repeat(700)}` }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Older Codex reply ${"noise ".repeat(700)}` }],
        api: "openai-codex-responses",
        provider: "codex-cli",
        model: "gpt-5.5",
        usage: ZERO_TEST_USAGE,
        stopReason: "stop",
        timestamp: Date.now() + 1,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Newest user nonce KEEP-NEWEST-42." }],
        timestamp: Date.now() + 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Newest assistant answer KEEP-NEWEST-42." }],
        api: "openai-codex-responses",
        provider: "codex-cli",
        model: "gpt-5.5",
        usage: ZERO_TEST_USAGE,
        stopReason: "stop",
        timestamp: Date.now() + 3,
      },
    ]);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "claude ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s-claude-replay-compact",
        sessionFile,
        workspaceDir: tempDir,
        config: createTextClaudeCliConfig(),
        prompt: "Use the newest nonce.",
        provider: "claude-cli",
        model: "haiku",
        timeoutMs: 1_000,
        runId: "run-claude-replay-compact",
      });

      const prompt = extractPromptArgFromSpawn();
      expect(prompt).toContain("Older turns compacted because the replay exceeded the budget");
      expect(prompt).toContain("User:\nNewest user nonce KEEP-NEWEST-42.");
      expect(prompt).toContain(
        "Assistant (codex-cli/gpt-5.5):\nNewest assistant answer KEEP-NEWEST-42.",
      );
    } finally {
      if (originalReplayMaxChars === undefined) {
        delete process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_MAX_CHARS;
      } else {
        process.env.OPENCLAW_CLAUDE_CLI_TRANSCRIPT_REPLAY_MAX_CHARS = originalReplayMaxChars;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("truncates huge tool results in claude-cli shared transcript replay", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-cli-replay-tool-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    appendTranscriptMessages(sessionFile, [
      {
        role: "user",
        content: [{ type: "text", text: "Run the large tool." }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-call-1",
            name: "read",
            arguments: { path: "large.log" },
          },
        ],
        api: "openai-codex-responses",
        provider: "codex-cli",
        model: "gpt-5.5",
        usage: ZERO_TEST_USAGE,
        stopReason: "toolUse",
        timestamp: Date.now() + 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "read",
        content: [{ type: "text", text: `TOOL-HEAD ${"x".repeat(5_000)} TOOL-TAIL` }],
        isError: false,
        timestamp: Date.now() + 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Tool result reviewed." }],
        api: "openai-codex-responses",
        provider: "codex-cli",
        model: "gpt-5.5",
        usage: ZERO_TEST_USAGE,
        stopReason: "stop",
        timestamp: Date.now() + 3,
      },
    ]);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "claude ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s-claude-replay-tool",
        sessionFile,
        workspaceDir: tempDir,
        config: createTextClaudeCliConfig(),
        prompt: "What did the tool show?",
        provider: "claude-cli",
        model: "haiku",
        timeoutMs: 1_000,
        runId: "run-claude-replay-tool",
      });

      const prompt = extractPromptArgFromSpawn();
      expect(prompt).toContain("[tool request omitted: read]");
      expect(prompt).toContain("Tool result (read):\nTOOL-HEAD");
      expect(prompt).toContain("[tool output truncated: omitted");
      expect(prompt).not.toContain("TOOL-TAIL");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not inject replay into a resumed claude-cli follow-up with only Claude-native history", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-cli-native-resume-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    appendTranscriptMessages(sessionFile, [
      {
        role: "user",
        content: [{ type: "text", text: "Claude-native setup." }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Claude-native answer." }],
        api: "anthropic-messages",
        provider: "claude-cli",
        model: "haiku",
        usage: ZERO_TEST_USAGE,
        stopReason: "stop",
        timestamp: Date.now() + 1,
      },
    ]);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "claude resumed ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s-claude-native-resume",
        sessionFile,
        workspaceDir: tempDir,
        config: createTextClaudeCliConfig(),
        prompt: "Continue natively.",
        provider: "claude-cli",
        model: "haiku",
        timeoutMs: 1_000,
        runId: "run-claude-native-resume",
        cliSessionId: "claude-native-session",
      });

      const prompt = extractPromptArgFromSpawn();
      expect(prompt).toBe("Continue natively.");
      expect(prompt).not.toContain("Recent shared OpenClaw session history");
      expect(prompt).not.toContain("Claude-native answer.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "neutral_full",
      envValue: "neutral_full",
      splitValue: undefined,
      expectedIncludes: ["general-purpose software and operations assistant"],
      expectedExcludes: ["OpenClaw", "Jarvis", "# Project Context", "AGENTS.md", "CONSUMER.md"],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "bridge_pointer_condensed",
      envValue: "bridge_pointer_condensed",
      splitValue: undefined,
      expectedIncludes: [
        "Your home is the runtime workspace at ~/.openclaw/workspace.",
        "Start with ~/.openclaw/workspace/AGENTS.md, then follow its workspace contract precisely.",
        "~/.openclaw/workspace/SOUL.md next",
        "~/.openclaw/workspace/memory/YYYY-MM-DD.md for today and yesterday at session start for continuity",
        "~/.openclaw/workspace/HEARTBEAT.md only for heartbeat runs",
      ],
      expectedExcludes: ["Jarvis", "# Project Context", "docs/agent-guides/workflow.md"],
      minLength: 300,
      maxLength: 2_500,
    },
    {
      label: "openclaw_full",
      envValue: "openclaw_full",
      splitValue: undefined,
      expectedIncludes: [
        "You are a personal assistant running inside OpenClaw.",
        "OpenClaw assistant",
      ],
      expectedExcludes: ["Jarvis", "# Project Context", "AGENTS.md", "CONSUMER.md"],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "openclaw_no_brand",
      envValue: "openclaw_no_brand",
      splitValue: undefined,
      expectedIncludes: [
        "You are Jarvis, a personal assistant running inside a bridge session.",
        "Jarvis",
      ],
      expectedExcludes: ["OpenClaw", "# Project Context", "AGENTS.md", "CONSUMER.md"],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "openclaw_exact_old",
      envValue: "openclaw_exact_old",
      splitValue: undefined,
      expectedIncludes: [
        "You are a personal assistant running inside OpenClaw.",
        "The user is working inside the OpenClaw repository.",
      ],
      expectedExcludes: ["Jarvis", "# Project Context", "AGENTS.md", "CONSUMER.md"],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "openclaw_exact_old_split_ab",
      envValue: "openclaw_exact_old_split",
      splitValue: "AB",
      expectedIncludes: [
        "You are a personal assistant running inside OpenClaw.",
        "The user is working inside the OpenClaw repository.",
        "Respect existing OpenClaw work in progress",
      ],
      expectedExcludes: ["Jarvis", "# Project Context", "AGENTS.md", "CONSUMER.md"],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "openclaw_exact_old_split_a",
      envValue: "openclaw_exact_old_split",
      splitValue: "A",
      expectedIncludes: [
        "You are a personal assistant running inside OpenClaw.",
        "The user is working inside the OpenClaw repository.",
      ],
      expectedExcludes: [
        "Jarvis",
        "Respect existing OpenClaw work in progress",
        "# Project Context",
        "AGENTS.md",
        "CONSUMER.md",
      ],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "openclaw_exact_old_split_b",
      envValue: "openclaw_exact_old_split",
      splitValue: "B",
      expectedIncludes: [
        "Respect existing OpenClaw work in progress",
        "When asked for recommendations",
      ],
      expectedExcludes: [
        "Jarvis",
        "You are a personal assistant running inside OpenClaw.",
        "The user is working inside the OpenClaw repository.",
        "# Project Context",
        "AGENTS.md",
        "CONSUMER.md",
      ],
      minLength: 17_000,
      maxLength: undefined,
    },
    {
      label: "unknown_falls_back_to_neutral_full",
      envValue: "definitely-unknown",
      splitValue: "banana",
      expectedIncludes: [
        "Your home is the runtime workspace at ~/.openclaw/workspace.",
        "~/.openclaw/workspace/AGENTS.md first",
      ],
      expectedExcludes: ["Jarvis", "# Project Context", "docs/agent-guides/workflow.md"],
      minLength: 300,
      maxLength: 2_500,
    },
  ])("routes claude-bridge to the experimental bridge runner for $label", async (testCase) => {
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK;
    process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE = testCase.envValue;
    if (testCase.splitValue === undefined) {
      delete process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT;
    } else {
      process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT = testCase.splitValue;
    }
    const preparedBackend = { command: "claude", args: ["--bundle-mcp"] };
    prepareCliBundleMcpConfigMock.mockResolvedValueOnce({ backend: preparedBackend });
    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "bridge-ok" }],
      meta: {
        durationMs: 12,
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          sessionId: "s1",
          provider: "claude-bridge",
          model: "sonnet",
          workspaceDir: "/tmp",
          bootstrapMaxChars: 1,
          bootstrapTotalMaxChars: 1,
          sandbox: { mode: "off", sandboxed: false },
          systemPrompt: "",
          bootstrapFiles: [],
          injectedFiles: [],
          skillsPrompt: "",
          tools: [],
        },
        agentMeta: {
          sessionId: "bridge-session",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });

    const result = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-bridge",
      cliSessionId: "persisted-bridge-session",
    });

    expect(bridgeRunMock).toHaveBeenCalledTimes(1);
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    const bridgeParams = bridgeRunMock.mock.calls[0]?.[0] as {
      cliSessionId?: string;
      configBackend?: unknown;
      systemPrompt?: string;
      systemPromptReport?: {
        injectedWorkspaceFiles?: unknown[];
        systemPrompt?: {
          chars?: number;
          projectContextChars?: number;
        };
      };
    };
    expect(bridgeParams.configBackend).toBe(preparedBackend);
    expect(bridgeParams.systemPrompt).not.toContain(
      "Tools are disabled in this session. Do not call tools.",
    );
    expect(bridgeParams.cliSessionId).toBeUndefined();
    for (const fragment of testCase.expectedIncludes) {
      expect(bridgeParams.systemPrompt).toContain(fragment);
    }
    for (const fragment of testCase.expectedExcludes) {
      expect(bridgeParams.systemPrompt).not.toContain(fragment);
    }
    expect(bridgeParams.systemPrompt?.length).toBeGreaterThanOrEqual(testCase.minLength);
    if (testCase.maxLength !== undefined) {
      expect(bridgeParams.systemPrompt?.length).toBeLessThanOrEqual(testCase.maxLength);
    }
    expect(bridgeParams.systemPromptReport?.injectedWorkspaceFiles).toEqual([]);
    expect(bridgeParams.systemPromptReport?.systemPrompt?.chars).toBeGreaterThanOrEqual(
      testCase.minLength,
    );
    expect(bridgeParams.systemPromptReport?.systemPrompt?.projectContextChars).toBe(0);
    expect(result.payloads?.[0]?.text).toBe("bridge-ok");
  });

  it("routes claude-bridge through the normal OpenClaw prompt stack when env flag is enabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-normal-stack-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "# AGENTS.md - Test Workspace\n\nBridge normal stack test instructions.\n",
      "utf-8",
    );

    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "bridge-normal-stack-ok" }],
      meta: {
        durationMs: 12,
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          sessionId: "s1",
          provider: "claude-bridge",
          model: "sonnet",
          workspaceDir,
          bootstrapMaxChars: 1,
          bootstrapTotalMaxChars: 1,
          sandbox: { mode: "off", sandboxed: false },
          systemPrompt: "",
          bootstrapFiles: [],
          injectedFiles: [],
          skillsPrompt: "",
          tools: [],
        },
        agentMeta: {
          sessionId: "bridge-session",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });

    process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK = "1";
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE;
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT;

    try {
      const result = await runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir,
        prompt: "hi",
        provider: "claude-bridge",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-bridge-normal-stack",
      });

      expect(bridgeRunMock).toHaveBeenCalledTimes(1);
      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      const bridgeParams = bridgeRunMock.mock.calls[0]?.[0] as {
        systemPrompt?: string;
        systemPromptReport?: {
          injectedWorkspaceFiles?: Array<{ name?: string }>;
          systemPrompt?: {
            chars?: number;
            projectContextChars?: number;
          };
        };
      };
      expect(bridgeParams.systemPrompt).toContain("# Project Context");
      expect(bridgeParams.systemPrompt).toContain(`${workspaceDir}/AGENTS.md`);
      expect(bridgeParams.systemPrompt).toContain("Bridge normal stack test instructions.");
      expect(bridgeParams.systemPromptReport?.systemPrompt?.projectContextChars).toBeGreaterThan(0);
      expect(bridgeParams.systemPromptReport?.injectedWorkspaceFiles?.length).toBeGreaterThan(0);
      expect(bridgeParams.systemPromptReport?.injectedWorkspaceFiles?.[0]?.name).toBe("AGENTS.md");
      expect(result.payloads?.[0]?.text).toBe("bridge-normal-stack-ok");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not inject the tools-disabled line when claude-bridge uses the normal prompt stack", async () => {
    process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK = "1";
    const preparedBackend = { command: "claude", args: ["--bundle-mcp"] };
    prepareCliBundleMcpConfigMock.mockResolvedValueOnce({ backend: preparedBackend });
    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "bridge-ok" }],
      meta: {
        durationMs: 12,
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          sessionId: "s1",
          provider: "claude-bridge",
          model: "sonnet",
          workspaceDir: "/tmp",
          bootstrapMaxChars: 1,
          bootstrapTotalMaxChars: 1,
          sandbox: { mode: "off", sandboxed: false },
          systemPrompt: "",
          bootstrapFiles: [],
          injectedFiles: [],
          skillsPrompt: "",
          tools: [],
        },
        agentMeta: {
          sessionId: "bridge-session",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-bridge-normal-stack",
      extraSystemPrompt: "extra bridge rule",
    });

    const bridgeParams = bridgeRunMock.mock.calls[0]?.[0] as {
      configBackend?: unknown;
      systemPrompt?: string;
    };
    expect(bridgeParams.configBackend).toBe(preparedBackend);
    expect(bridgeParams.systemPrompt).toContain("extra bridge rule");
    expect(bridgeParams.systemPrompt).not.toContain(
      "Tools are disabled in this session. Do not call tools.",
    );
  });

  it("defaults claude-bridge to the condensed pointer prompt when no mode env is set", async () => {
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE;
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT;
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK;

    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "bridge-default-ok" }],
      meta: {
        durationMs: 12,
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          sessionId: "s1",
          provider: "claude-bridge",
          model: "sonnet",
          workspaceDir: "/tmp",
          bootstrapMaxChars: 1,
          bootstrapTotalMaxChars: 1,
          sandbox: { mode: "off", sandboxed: false },
          systemPrompt: "",
          bootstrapFiles: [],
          injectedFiles: [],
          skillsPrompt: "",
          tools: [],
        },
        agentMeta: {
          sessionId: "bridge-session",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-bridge",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-bridge-default",
    });

    const bridgeParams = bridgeRunMock.mock.calls[0]?.[0] as {
      systemPrompt?: string;
      systemPromptReport?: {
        systemPrompt?: {
          chars?: number;
          projectContextChars?: number;
        };
      };
    };
    expect(bridgeParams.systemPrompt).toContain(
      "Your home is the runtime workspace at ~/.openclaw/workspace.",
    );
    expect(bridgeParams.systemPrompt).toContain("~/.openclaw/workspace/AGENTS.md first");
    expect(bridgeParams.systemPrompt).toContain(
      "~/.openclaw/workspace/memory/YYYY-MM-DD.md for today and yesterday at session start for continuity",
    );
    expect(bridgeParams.systemPromptReport?.systemPrompt?.chars).toBeLessThanOrEqual(2_500);
    expect(bridgeParams.systemPromptReport?.systemPrompt?.projectContextChars).toBe(0);
  });

  it("mirrors successful claude-bridge turns into the shared session transcript", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-transcript-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_PROMPT_MODE;
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_SPLIT;
    delete process.env.OPENCLAW_CLAUDE_BRIDGE_USE_NORMAL_PROMPT_STACK;

    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "N-9901" }],
      transcriptMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "bridge-call-1",
              name: " exec ",
              arguments: { command: "printf N-9901" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "bridge-call-1",
          content: [{ type: "text", text: "N-9901" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "N-9901" }],
        },
      ],
      meta: {
        durationMs: 12,
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          sessionId: "s-bridge",
          provider: "claude-bridge",
          model: "sonnet",
          workspaceDir: tempDir,
          bootstrapMaxChars: 1,
          bootstrapTotalMaxChars: 1,
          sandbox: { mode: "off", sandboxed: false },
          systemPrompt: "",
          bootstrapFiles: [],
          injectedFiles: [],
          skillsPrompt: "",
          tools: [],
        },
        agentMeta: {
          sessionId: "bridge-session",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });

    try {
      await runCliAgent({
        sessionId: "s-bridge",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "Remember nonce N-9901",
        provider: "claude-bridge",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-bridge-transcript",
      });

      const messages = await readTranscriptMessages(sessionFile);
      expect(messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Remember nonce N-9901" }],
        }),
        expect.objectContaining({
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "bridge-call-1",
              name: "exec",
              arguments: { command: "printf N-9901" },
            },
          ],
        }),
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "bridge-call-1",
          toolName: "exec",
          content: [{ type: "text", text: "N-9901" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "N-9901" }],
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs bridge tool turns before persistence so replay continuity keeps a paired toolResult", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-repair-"));
    const sessionFile = path.join(tempDir, "session.jsonl");

    bridgeRunMock.mockResolvedValueOnce({
      payloads: [{ text: "final reply" }],
      transcriptMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "bridge-call-missing-result",
              name: " read ",
              arguments: { path: "/tmp/demo.txt" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "final reply" }],
        },
      ],
      meta: {
        durationMs: 12,
        systemPromptReport: {
          source: "run",
          generatedAt: Date.now(),
          sessionId: "s-bridge-repair",
          provider: "claude-bridge",
          model: "sonnet",
          workspaceDir: tempDir,
          bootstrapMaxChars: 1,
          bootstrapTotalMaxChars: 1,
          sandbox: { mode: "off", sandboxed: false },
          systemPrompt: "",
          bootstrapFiles: [],
          injectedFiles: [],
          skillsPrompt: "",
          tools: [],
        },
        agentMeta: {
          sessionId: "bridge-session-repair",
          provider: "claude-bridge",
          model: "sonnet",
        },
      },
    });

    try {
      await runCliAgent({
        sessionId: "s-bridge-repair",
        sessionFile,
        workspaceDir: tempDir,
        prompt: "Read the file then answer.",
        provider: "claude-bridge",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-bridge-repair",
      });

      const messages = await readTranscriptMessages(sessionFile);
      expect(messages).toEqual([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "bridge-call-missing-result",
              name: "read",
              arguments: { path: "/tmp/demo.txt" },
            },
          ],
        }),
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "bridge-call-missing-result",
          toolName: "read",
          isError: true,
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("missing tool result"),
            }),
          ],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "final reply" }],
        }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });
});
