import crypto from "node:crypto";
import type { CliBackendConfig } from "../../config/types.js";
import type { ManagedRun, ProcessSupervisor } from "../../process/supervisor/types.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import {
  createCliJsonlStreamingParser,
  parseCliJsonl,
  type CliOutput,
  type CliStreamingDelta,
} from "./helpers.js";

type ClaudeLiveContext = {
  backendId: string;
  backend: CliBackendConfig;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
  normalizedModel: string;
  timeoutMs: number;
  systemPrompt: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  replyOperation?: {
    attachBackend?: (handle: ReplyBackendHandle) => void;
    detachBackend?: (handle: ReplyBackendHandle) => void;
  };
  abortSignal?: AbortSignal;
};

type ReplyBackendHandle = {
  kind: "cli";
  cancel: () => void;
  isStreaming: () => boolean;
};

type ClaudeLiveTurn = {
  backend: CliBackendConfig;
  startedAtMs: number;
  rawLines: string[];
  rawChars: number;
  sessionId?: string;
  noOutputTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  streamingParser: ReturnType<typeof createCliJsonlStreamingParser>;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
};

type ClaudeLiveSession = {
  key: string;
  fingerprint: string;
  managedRun: ManagedRun;
  providerId: string;
  modelId: string;
  noOutputTimeoutMs: number;
  stderr: string;
  stdoutBuffer: string;
  currentTurn: ClaudeLiveTurn | null;
  idleTimer: NodeJS.Timeout | null;
  cleanup: () => Promise<void>;
  cleanupDone: boolean;
  closing: boolean;
};

const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_LIVE_MAX_SESSIONS = 16;
const CLAUDE_LIVE_MAX_STDERR_CHARS = 64 * 1024;
const CLAUDE_LIVE_MAX_TURN_RAW_CHARS = 2 * 1024 * 1024;
const CLAUDE_LIVE_MAX_TURN_LINES = 5_000;
const liveSessions = new Map<string, ClaudeLiveSession>();
const liveSessionCreates = new Map<string, Promise<ClaudeLiveSession>>();

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function resetClaudeLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    closeLiveSession(session, "restart");
  }
  liveSessions.clear();
  liveSessionCreates.clear();
}

export function getClaudeLiveSessionSnapshotsForTest(): Array<{
  key: string;
  fingerprint: string;
  pid?: number;
  startedAtMs: number;
  providerId: string;
  modelId: string;
  hasCurrentTurn: boolean;
}> {
  return [...liveSessions.values()].map((session) => ({
    key: session.key,
    fingerprint: session.fingerprint,
    pid: session.managedRun.pid,
    startedAtMs: session.managedRun.startedAtMs,
    providerId: session.providerId,
    modelId: session.modelId,
    hasCurrentTurn: Boolean(session.currentTurn),
  }));
}

export function shouldUseClaudeLiveSession(context: ClaudeLiveContext): boolean {
  return (
    context.backendId === "claude-cli" &&
    context.backend.liveSession === "claude-stdio" &&
    context.backend.output === "jsonl" &&
    context.backend.input === "stdin"
  );
}

function upsertArgValue(args: string[], flag: string, value: string): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === flag) {
      i += 1;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  normalized.push(flag, value);
  return normalized;
}

function appendArg(args: string[], flag: string): string[] {
  return args.includes(flag) ? args : [...args, flag];
}

function stripArgValues(args: string[], flags: Set<string>): string[] {
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (flags.has(arg)) {
      i += 1;
      continue;
    }
    if ([...flags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function buildClaudeLiveArgs(params: {
  args: string[];
  backend: CliBackendConfig;
  useResume: boolean;
}): string[] {
  const flagsToStrip = new Set(
    [
      params.backend.sessionArg,
      "--session-id",
      params.useResume ? params.backend.systemPromptArg : undefined,
      params.useResume ? params.backend.systemPromptFileArg : undefined,
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  return appendArg(
    upsertArgValue(
      upsertArgValue(stripArgValues(params.args, flagsToStrip), "--input-format", "stream-json"),
      "--permission-prompt-tool",
      "stdio",
    ),
    "--replay-user-messages",
  );
}

function buildClaudeLiveKey(context: ClaudeLiveContext): string {
  return `${context.backendId}:${sha256(
    JSON.stringify({
      agentId: context.agentId,
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
    }),
  )}`;
}

function buildClaudeLiveFingerprint(params: {
  context: ClaudeLiveContext;
  argv: string[];
  env: Record<string, string>;
}): string {
  const omittedValueFlags = new Set(
    [
      params.context.backend.modelArg,
      params.context.backend.systemPromptArg,
      params.context.backend.systemPromptFileArg,
      "--model",
      "--resume",
      "-r",
    ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
  );
  const unstableValueFlags = new Set(
    [params.context.backend.sessionArg, "--session-id", "--mcp-config"].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    ),
  );
  const stableArgv: string[] = [];
  for (let i = 0; i < params.argv.length; i += 1) {
    const entry = params.argv[i] ?? "";
    if (omittedValueFlags.has(entry)) {
      i += 1;
      continue;
    }
    if ([...omittedValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      continue;
    }
    if (unstableValueFlags.has(entry)) {
      stableArgv.push("<unstable>");
      i += 1;
      continue;
    }
    if ([...unstableValueFlags].some((flag) => entry.startsWith(`${flag}=`))) {
      stableArgv.push("<unstable>");
      continue;
    }
    stableArgv.push(entry);
  }
  return JSON.stringify({
    command: params.context.backend.command,
    workspaceDirHash: sha256(params.context.workspaceDir),
    provider: params.context.provider,
    model: params.context.normalizedModel,
    systemPromptHash: sha256(params.context.systemPrompt),
    mcpConfigHash: params.context.mcpConfigHash,
    mcpResumeHash: params.context.mcpResumeHash,
    argv: stableArgv,
    env: buildClaudeLiveEnvFingerprint(params.env),
  });
}

function shouldFingerprintClaudeLiveEnvKey(key: string): boolean {
  return (
    key === "HOME" ||
    key === "PATH" ||
    key === "SHELL" ||
    key === "TMPDIR" ||
    key === "HTTP_PROXY" ||
    key === "HTTPS_PROXY" ||
    key === "NO_PROXY" ||
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_") ||
    key.startsWith("OPENCLAW_MCP_")
  );
}

function buildClaudeLiveEnvFingerprint(env: Record<string, string>): Array<[string, string]> {
  return Object.keys(env)
    .filter(shouldFingerprintClaudeLiveEnvKey)
    .toSorted()
    .map((key) => [key, env[key] ? sha256(env[key]) : ""]);
}

function createAbortError(): Error {
  const error = new Error("CLI run aborted");
  error.name = "AbortError";
  return error;
}

function clearTurnTimers(turn: ClaudeLiveTurn): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
  if (turn.timeoutTimer) {
    clearTimeout(turn.timeoutTimer);
    turn.timeoutTimer = null;
  }
}

function finishTurn(session: ClaudeLiveSession, output: CliOutput): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  session.currentTurn = null;
  turn.resolve(output);
  scheduleIdleClose(session);
}

function failTurn(session: ClaudeLiveSession, error: unknown): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  clearTurnTimers(turn);
  turn.streamingParser.finish();
  session.currentTurn = null;
  turn.reject(error);
}

function cleanupLiveSession(session: ClaudeLiveSession): void {
  if (session.cleanupDone) {
    return;
  }
  session.cleanupDone = true;
  void session.cleanup();
}

function closeLiveSession(
  session: ClaudeLiveSession,
  reason: "idle" | "restart" | "abort",
  error?: unknown,
): void {
  if (session.closing) {
    return;
  }
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  if (error) {
    failTurn(session, error);
  }
  session.managedRun.cancel(reason === "abort" ? "manual-cancel" : "manual-cancel");
  cleanupLiveSession(session);
}

function scheduleIdleClose(session: ClaudeLiveSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(() => {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
    }
  }, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
}

function createTimeoutError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("timeout"),
  });
}

function createOutputLimitError(session: ClaudeLiveSession, message: string): FailoverError {
  return new FailoverError(message, {
    reason: "format",
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus("format"),
  });
}

function resetNoOutputTimer(session: ClaudeLiveSession): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      session,
      "abort",
      createTimeoutError(
        session,
        `CLI produced no output for ${Math.round(session.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, session.noOutputTimeoutMs);
}

function parseSessionId(parsed: Record<string, unknown>): string | undefined {
  const sessionId =
    typeof parsed.session_id === "string"
      ? parsed.session_id.trim()
      : typeof parsed.sessionId === "string"
        ? parsed.sessionId.trim()
        : "";
  return sessionId || undefined;
}

function parseClaudeLiveJsonLine(
  session: ClaudeLiveSession,
  trimmed: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function createResultError(
  session: ClaudeLiveSession,
  parsed: Record<string, unknown>,
  raw: string,
): FailoverError {
  const result = typeof parsed.result === "string" ? parsed.result.trim() : "";
  const message = result || raw || "Claude CLI failed.";
  const reason = classifyFailoverReason(message) ?? "unknown";
  return new FailoverError(message, {
    reason,
    provider: session.providerId,
    model: session.modelId,
    status: resolveFailoverStatus(reason),
  });
}

function handleClaudeLiveLine(session: ClaudeLiveSession, line: string): void {
  const turn = session.currentTurn;
  const trimmed = line.trim();
  if (!trimmed || !turn) {
    return;
  }
  const parsed = parseClaudeLiveJsonLine(session, trimmed);
  if (!parsed) {
    return;
  }
  turn.rawChars += trimmed.length + 1;
  if (
    turn.rawChars > CLAUDE_LIVE_MAX_TURN_RAW_CHARS ||
    turn.rawLines.length >= CLAUDE_LIVE_MAX_TURN_LINES
  ) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI turn output exceeded limit."),
    );
    return;
  }
  turn.rawLines.push(trimmed);
  turn.streamingParser.push(`${trimmed}\n`);
  turn.sessionId = parseSessionId(parsed) ?? turn.sessionId;
  if (parsed.type !== "result") {
    return;
  }
  const raw = turn.rawLines.join("\n");
  if (parsed.is_error === true) {
    failTurn(session, createResultError(session, parsed, raw));
    scheduleIdleClose(session);
    return;
  }
  finishTurn(
    session,
    parseCliJsonl(raw, turn.backend, session.providerId) ?? {
      text: raw,
      sessionId: turn.sessionId,
    },
  );
}

function handleClaudeStdout(session: ClaudeLiveSession, chunk: string): void {
  resetNoOutputTimer(session);
  session.stdoutBuffer += chunk;
  if (session.stdoutBuffer.length > CLAUDE_LIVE_MAX_TURN_RAW_CHARS) {
    closeLiveSession(
      session,
      "abort",
      createOutputLimitError(session, "Claude CLI JSONL line exceeded output limit."),
    );
    return;
  }
  const lines = session.stdoutBuffer.split(/\r?\n/g);
  session.stdoutBuffer = lines.pop() ?? "";
  try {
    for (const line of lines) {
      handleClaudeLiveLine(session, line);
    }
  } catch (error) {
    closeLiveSession(session, "abort", error);
  }
}

function handleClaudeExit(session: ClaudeLiveSession, exitCode: number | null): void {
  session.closing = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
  cleanupLiveSession(session);
  if (!session.currentTurn) {
    return;
  }
  if (session.stdoutBuffer.trim()) {
    try {
      handleClaudeLiveLine(session, session.stdoutBuffer);
    } catch (error) {
      session.stdoutBuffer = "";
      failTurn(session, error);
      return;
    }
    session.stdoutBuffer = "";
  }
  if (!session.currentTurn) {
    return;
  }
  const stderr = session.stderr.trim();
  const fallbackMessage =
    exitCode === 0 ? "Claude CLI exited before completing the turn." : "Claude CLI failed.";
  const message = stderr || fallbackMessage;
  if (exitCode === 0) {
    failTurn(session, new Error(message));
    return;
  }
  const reason = classifyFailoverReason(message) ?? "unknown";
  failTurn(
    session,
    new FailoverError(message, {
      reason,
      provider: session.providerId,
      model: session.modelId,
      status: resolveFailoverStatus(reason),
    }),
  );
}

function createClaudeUserInputMessage(content: string): string {
  return `${JSON.stringify({
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  })}\n`;
}

async function writeTurnInput(session: ClaudeLiveSession, prompt: string): Promise<void> {
  const stdin = session.managedRun.stdin;
  if (!stdin) {
    throw new Error("Claude CLI live session stdin is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(createClaudeUserInputMessage(prompt), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createClaudeLiveSession(params: {
  context: ClaudeLiveContext;
  argv: string[];
  env: Record<string, string>;
  fingerprint: string;
  key: string;
  noOutputTimeoutMs: number;
  supervisor: ProcessSupervisor;
  cleanup: () => Promise<void>;
}): Promise<ClaudeLiveSession> {
  let session: ClaudeLiveSession | null = null;
  const managedRun = await params.supervisor.spawn({
    sessionId: params.context.sessionId,
    backendId: params.context.backendId,
    scopeKey: `claude-live:${params.key}`,
    replaceExistingScope: true,
    mode: "child",
    argv: params.argv,
    cwd: params.context.workspaceDir,
    env: params.env,
    stdinMode: "pipe-open",
    captureOutput: false,
    onStdout: (chunk) => {
      if (session) {
        handleClaudeStdout(session, chunk);
      }
    },
    onStderr: (chunk) => {
      if (!session) {
        return;
      }
      session.stderr += chunk;
      if (session.stderr.length > CLAUDE_LIVE_MAX_STDERR_CHARS) {
        closeLiveSession(
          session,
          "abort",
          createOutputLimitError(session, "Claude CLI stderr exceeded limit."),
        );
        return;
      }
      resetNoOutputTimer(session);
    },
  });
  session = {
    key: params.key,
    fingerprint: params.fingerprint,
    managedRun,
    providerId: params.context.provider,
    modelId: params.context.modelId,
    noOutputTimeoutMs: params.noOutputTimeoutMs,
    stderr: "",
    stdoutBuffer: "",
    currentTurn: null,
    idleTimer: null,
    cleanup: params.cleanup,
    cleanupDone: false,
    closing: false,
  };
  void managedRun.wait().then(
    (exit) => handleClaudeExit(session, exit.exitCode),
    (error) => closeLiveSession(session, "abort", error),
  );
  liveSessions.set(params.key, session);
  return session;
}

function createTurn(params: {
  context: ClaudeLiveContext;
  noOutputTimeoutMs: number;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  session: ClaudeLiveSession;
  resolve: (output: CliOutput) => void;
  reject: (error: unknown) => void;
}): ClaudeLiveTurn {
  const turn: ClaudeLiveTurn = {
    backend: params.context.backend,
    startedAtMs: Date.now(),
    rawLines: [],
    rawChars: 0,
    noOutputTimer: null,
    timeoutTimer: null,
    streamingParser: createCliJsonlStreamingParser({
      backend: params.context.backend,
      providerId: params.context.backendId,
      onAssistantDelta: params.onAssistantDelta,
    }),
    resolve: params.resolve,
    reject: params.reject,
  };
  turn.noOutputTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI produced no output for ${Math.round(params.noOutputTimeoutMs / 1000)}s and was terminated.`,
      ),
    );
  }, params.noOutputTimeoutMs);
  turn.timeoutTimer = setTimeout(() => {
    closeLiveSession(
      params.session,
      "abort",
      createTimeoutError(
        params.session,
        `CLI exceeded timeout (${Math.round(params.context.timeoutMs / 1000)}s) and was terminated.`,
      ),
    );
  }, params.context.timeoutMs);
  return turn;
}

function closeOldestIdleSession(): boolean {
  for (const session of liveSessions.values()) {
    if (!session.currentTurn) {
      closeLiveSession(session, "idle");
      return true;
    }
  }
  return false;
}

function ensureLiveSessionCapacity(key: string, context: ClaudeLiveContext): void {
  if (
    liveSessions.has(key) ||
    liveSessionCreates.has(key) ||
    liveSessions.size + liveSessionCreates.size < CLAUDE_LIVE_MAX_SESSIONS
  ) {
    return;
  }
  if (closeOldestIdleSession()) {
    return;
  }
  throw new FailoverError("Too many Claude CLI live sessions are active.", {
    reason: "rate_limit",
    provider: context.provider,
    model: context.modelId,
    status: resolveFailoverStatus("rate_limit"),
  });
}

export async function runClaudeLiveSessionTurn(params: {
  context: ClaudeLiveContext;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  useResume: boolean;
  noOutputTimeoutMs: number;
  getProcessSupervisor: () => ProcessSupervisor;
  onAssistantDelta: (delta: CliStreamingDelta) => void;
  cleanup: () => Promise<void>;
}): Promise<{ output: CliOutput }> {
  const key = buildClaudeLiveKey(params.context);
  const argv = [
    params.context.backend.command,
    ...buildClaudeLiveArgs({
      args: params.args,
      backend: params.context.backend,
      useResume: params.useResume,
    }),
  ];
  const fingerprint = buildClaudeLiveFingerprint({
    context: params.context,
    argv,
    env: params.env,
  });
  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    await params.cleanup();
  };

  let session = liveSessions.get(key) ?? null;
  if (session && session.fingerprint !== fingerprint) {
    closeLiveSession(session, "restart");
    session = null;
  }
  let cleanupTurnArtifacts = Boolean(session);
  try {
    ensureLiveSessionCapacity(key, params.context);
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (!session) {
    const pendingSession = liveSessionCreates.get(key);
    if (pendingSession) {
      try {
        session = await pendingSession;
      } catch (error) {
        await cleanup();
        throw error;
      }
      if (session.fingerprint !== fingerprint) {
        closeLiveSession(session, "restart");
        session = null;
      } else {
        cleanupTurnArtifacts = true;
      }
    }
    if (!session) {
      const createSession = createClaudeLiveSession({
        context: params.context,
        argv,
        env: params.env,
        fingerprint,
        key,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        supervisor: params.getProcessSupervisor(),
        cleanup,
      }).finally(() => {
        if (liveSessionCreates.get(key) === createSession) {
          liveSessionCreates.delete(key);
        }
      });
      liveSessionCreates.set(key, createSession);
      try {
        session = await createSession;
      } catch (error) {
        await cleanup();
        throw error;
      }
    }
  }

  if (cleanupTurnArtifacts && session) {
    await cleanup();
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
  if (session.closing) {
    await cleanup();
    throw new Error("Claude CLI live session closed before handling the turn");
  }
  if (session.currentTurn) {
    throw new Error("Claude CLI live session is already handling a turn");
  }

  const liveSession = session;
  liveSession.noOutputTimeoutMs = params.noOutputTimeoutMs;
  liveSession.stderr = "";

  const outputPromise = new Promise<CliOutput>((resolve, reject) => {
    liveSession.currentTurn = createTurn({
      context: params.context,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      onAssistantDelta: params.onAssistantDelta,
      session: liveSession,
      resolve,
      reject,
    });
  });
  const abort = () => closeLiveSession(liveSession, "abort", createAbortError());
  let replyBackendCompleted = false;
  const replyBackendHandle: ReplyBackendHandle | undefined = params.context.replyOperation
    ? {
        kind: "cli",
        cancel: abort,
        isStreaming: () => !replyBackendCompleted,
      }
    : undefined;
  params.context.abortSignal?.addEventListener("abort", abort, { once: true });
  if (replyBackendHandle) {
    params.context.replyOperation?.attachBackend?.(replyBackendHandle);
  }
  try {
    // The watchdog owns turn completion once timers are armed; a wedged stdin write
    // must not block the caller from observing timeout/no-output rejection.
    const writePromise = (async () => {
      if (params.context.abortSignal?.aborted) {
        abort();
        return;
      }
      await writeTurnInput(liveSession, params.prompt);
    })();
    void writePromise.catch((error) => {
      closeLiveSession(liveSession, "abort", error);
    });
    await Promise.race([outputPromise, writePromise]);
    return { output: await outputPromise };
  } finally {
    replyBackendCompleted = true;
    params.context.abortSignal?.removeEventListener("abort", abort);
    if (replyBackendHandle) {
      params.context.replyOperation?.detachBackend?.(replyBackendHandle);
    }
  }
}
