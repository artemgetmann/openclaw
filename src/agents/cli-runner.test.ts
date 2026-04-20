import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runCliAgent } from "./cli-runner.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";

const supervisorSpawnMock = vi.fn();
const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const bridgeRunMock = vi.fn();
const prepareCliBundleMcpConfigMock = vi.fn();

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
            content?: Array<{ type?: string; text?: string }>;
          };
        },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
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
          content: [{ type: "text", text: "N-9901" }],
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
