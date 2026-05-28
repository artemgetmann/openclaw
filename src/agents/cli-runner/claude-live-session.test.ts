import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import type { ManagedRun, ProcessSupervisor, SpawnInput } from "../../process/supervisor/types.js";
import {
  buildClaudeLiveArgs,
  getClaudeLiveSessionSnapshotsForTest,
  resetClaudeLiveSessionsForTest,
  runClaudeLiveSessionTurn,
  shouldUseClaudeLiveSession,
} from "./claude-live-session.js";

const backend = {
  command: "claude",
  args: [],
  output: "jsonl",
  input: "stdin",
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
  systemPromptFileArg: "--append-system-prompt-file",
  liveSession: "claude-stdio",
} satisfies CliBackendConfig;

describe("Claude CLI live session helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetClaudeLiveSessionsForTest();
  });

  it("adds stdio live-process flags without removing first-turn prompt args", () => {
    const args = buildClaudeLiveArgs({
      backend,
      useResume: false,
      args: [
        "-p",
        "--append-system-prompt",
        "safe prompt",
        "--session-id",
        "new-session",
        "--input-format",
        "text",
      ],
    });

    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("safe prompt");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("new-session");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
    expect(args).toContain("--replay-user-messages");
  });

  it("strips system prompt args on resumed live-process starts", () => {
    const args = buildClaudeLiveArgs({
      backend,
      useResume: true,
      args: [
        "-p",
        "--append-system-prompt",
        "safe prompt",
        "--append-system-prompt-file",
        "/tmp/prompt.txt",
        "--resume",
        "old-session",
      ],
    });

    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("safe prompt");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("/tmp/prompt.txt");
    expect(args).toContain("--resume");
    expect(args).toContain("old-session");
  });

  it("selects live sessions only for claude-cli stdin jsonl backends", () => {
    expect(
      shouldUseClaudeLiveSession({
        backendId: "claude-cli",
        backend,
        sessionId: "s1",
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "opus",
        normalizedModel: "opus",
        timeoutMs: 5_000,
        systemPrompt: "safe prompt",
      }),
    ).toBe(true);
    expect(
      shouldUseClaudeLiveSession({
        backendId: "claude-cli",
        backend: { ...backend, liveSession: undefined },
        sessionId: "s1",
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "opus",
        normalizedModel: "opus",
        timeoutMs: 1_000,
        systemPrompt: "safe prompt",
      }),
    ).toBe(false);
  });

  it("fails and cleans up when a live turn produces no output while stdin write is stuck", async () => {
    vi.useFakeTimers();
    const cancelMock = vi.fn();
    const cleanupMock = vi.fn(async () => {});
    const stdinWriteMock = vi.fn((_data: string, _cb?: (err?: Error | null) => void) => {
      // Simulate a wedged Claude process that never accepts the prompt write.
    });
    const managedRun = {
      runId: "run-stuck-stdin",
      pid: 4321,
      startedAtMs: Date.now(),
      stdin: {
        write: stdinWriteMock,
        end: vi.fn(),
      },
      wait: vi.fn(async () => await new Promise<never>(() => {})),
      cancel: cancelMock,
      touch: vi.fn(),
    } satisfies ManagedRun;
    const supervisor = {
      spawn: vi.fn(async (_input: SpawnInput) => managedRun),
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      reconcileOrphans: vi.fn(async () => {}),
      getRecord: vi.fn(),
    } satisfies ProcessSupervisor;

    const turnPromise = runClaudeLiveSessionTurn({
      context: {
        backendId: "claude-cli",
        backend,
        sessionId: "session-stuck-stdin",
        workspaceDir: "/tmp/openclaw-live-test",
        provider: "claude-cli",
        modelId: "haiku",
        normalizedModel: "haiku",
        timeoutMs: 1_000,
        systemPrompt: "safe prompt",
      },
      args: ["-p"],
      env: {},
      prompt: "remember this",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: () => supervisor,
      onAssistantDelta: vi.fn(),
      cleanup: cleanupMock,
    });

    const rejection = expect(turnPromise).rejects.toThrow(
      "CLI produced no output for 1s and was terminated.",
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await rejection;
    expect(stdinWriteMock).toHaveBeenCalledOnce();
    expect(cancelMock).toHaveBeenCalledWith("manual-cancel");
    expect(cleanupMock).toHaveBeenCalledOnce();
    expect(getClaudeLiveSessionSnapshotsForTest()).toEqual([]);
  });

  it("fails and cleans up when stdin accepts the prompt but Claude produces no output", async () => {
    vi.useFakeTimers();
    const cancelMock = vi.fn();
    const cleanupMock = vi.fn(async () => {});
    const stdinWriteMock = vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
      cb?.(null);
    });
    const managedRun = {
      runId: "run-silent-after-write",
      pid: 4322,
      startedAtMs: Date.now(),
      stdin: {
        write: stdinWriteMock,
        end: vi.fn(),
      },
      wait: vi.fn(async () => await new Promise<never>(() => {})),
      cancel: cancelMock,
      touch: vi.fn(),
    } satisfies ManagedRun;
    const supervisor = {
      spawn: vi.fn(async (_input: SpawnInput) => managedRun),
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      reconcileOrphans: vi.fn(async () => {}),
      getRecord: vi.fn(),
    } satisfies ProcessSupervisor;

    const turnPromise = runClaudeLiveSessionTurn({
      context: {
        backendId: "claude-cli",
        backend,
        sessionId: "session-silent-after-write",
        workspaceDir: "/tmp/openclaw-live-test",
        provider: "claude-cli",
        modelId: "haiku",
        normalizedModel: "haiku",
        timeoutMs: 1_000,
        systemPrompt: "safe prompt",
      },
      args: ["-p"],
      env: {},
      prompt: "echo this without tools",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: () => supervisor,
      onAssistantDelta: vi.fn(),
      cleanup: cleanupMock,
    });

    const rejection = expect(turnPromise).rejects.toThrow(
      "CLI produced no output for 1s and was terminated.",
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await rejection;
    expect(stdinWriteMock).toHaveBeenCalledOnce();
    expect(cancelMock).toHaveBeenCalledWith("manual-cancel");
    expect(cleanupMock).toHaveBeenCalledOnce();
    expect(getClaudeLiveSessionSnapshotsForTest()).toEqual([]);
  });

  it("fails startup when the Claude live process starts but spawn never resolves", async () => {
    vi.useFakeTimers();
    const cleanupMock = vi.fn(async () => {});
    const cancelScopeMock = vi.fn();
    const supervisor = {
      spawn: vi.fn(async (_input: SpawnInput) => await new Promise<ManagedRun>(() => {})),
      cancel: vi.fn(),
      cancelScope: cancelScopeMock,
      reconcileOrphans: vi.fn(async () => {}),
      getRecord: vi.fn(),
    } satisfies ProcessSupervisor;

    const turnPromise = runClaudeLiveSessionTurn({
      context: {
        backendId: "claude-cli",
        backend,
        sessionId: "session-startup-wedge",
        workspaceDir: "/tmp/openclaw-live-test",
        provider: "claude-cli",
        modelId: "haiku",
        normalizedModel: "haiku",
        timeoutMs: 1_000,
        systemPrompt: "safe prompt",
      },
      args: ["-p"],
      env: {},
      prompt: "echo this without tools",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: () => supervisor,
      onAssistantDelta: vi.fn(),
      cleanup: cleanupMock,
    });

    const rejection = expect(turnPromise).rejects.toThrow(
      "Claude CLI live session did not start within 1s and was terminated.",
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await rejection;
    expect(supervisor.spawn).toHaveBeenCalledOnce();
    expect(cancelScopeMock).toHaveBeenCalledWith(
      expect.stringMatching(/^claude-live:/),
      "no-output-timeout",
    );
    expect(cleanupMock).toHaveBeenCalledOnce();
    expect(getClaudeLiveSessionSnapshotsForTest()).toEqual([]);
  });
});
