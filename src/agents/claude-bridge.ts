import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { CliBackendConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  collectClaudeBridgeText,
  isClaudeBridgeAssistantMessageStart,
  parseClaudeBridgeLine,
  readClaudeBridgeTextDelta,
  readClaudeBridgeUsage,
  type ClaudeBridgeUsage,
} from "./claude-bridge.stream.js";
import { normalizeCliModel } from "./cli-runner/helpers.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

type ClaudeBridgeTurnResult = {
  text: string;
  sessionId?: string;
  usage?: ClaudeBridgeUsage;
};

type ActiveTurn = {
  resolve: (value: ClaudeBridgeTurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  assistantTexts: string[];
  lastAssistantText: string;
  lastDeliveredPartialText: string;
  assistantStarted: boolean;
  callbackChain: Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: ReplyPayload) => void | Promise<void>;
  blockAccumulator: ReturnType<typeof createStreamingDirectiveAccumulator>;
};

type ClaudeBridgeSessionHandle = {
  key: string;
  child?: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  activeTurn: ActiveTurn | null;
  turnQueue: Promise<void>;
  currentClaudeSessionId?: string;
};

const log = createSubsystemLogger("agent/claude-bridge");
const SESSION_REGISTRY = new Map<string, ClaudeBridgeSessionHandle>();
const LOG_RAW_EVENTS = process.env.OPENCLAW_CLAUDE_BRIDGE_LOG_RAW === "1";

function buildBridgeArgs(params: {
  model: string;
  systemPrompt?: string;
  sessionId?: string;
}): string[] {
  const args = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    params.model,
  ];
  if (params.sessionId) {
    args.push("--resume", params.sessionId);
  }
  if (params.systemPrompt?.trim()) {
    args.push("--append-system-prompt", params.systemPrompt);
  }
  return args;
}

function buildBridgeEnv(backend: CliBackendConfig): NodeJS.ProcessEnv {
  const next = { ...process.env, ...backend.env };
  for (const key of backend.clearEnv ?? []) {
    delete next[key];
  }
  return next;
}

function createBridgeSessionHandle(key: string): ClaudeBridgeSessionHandle {
  return {
    key,
    stdoutBuffer: "",
    activeTurn: null,
    turnQueue: Promise.resolve(),
  };
}

function backendCommand(backend: CliBackendConfig): string {
  const command = backend.command.trim();
  if (!command) {
    throw new Error("Claude bridge backend command is required");
  }
  return command;
}

function failActiveTurn(handle: ClaudeBridgeSessionHandle, error: Error): void {
  const turn = handle.activeTurn;
  if (!turn) {
    return;
  }
  clearTimeout(turn.timer);
  handle.activeTurn = null;
  turn.reject(error);
}

function queueTurnCallback(
  handle: ClaudeBridgeSessionHandle,
  task: () => Promise<void> | void,
): void {
  const turn = handle.activeTurn;
  if (!turn) {
    return;
  }
  // Keep callback delivery serialized so typing, partial text, and block payloads
  // follow the same order Claude emitted them on stdout.
  turn.callbackChain = turn.callbackChain
    .then(async () => {
      await task();
    })
    .catch((err) => {
      log.warn(`claude bridge callback failed: session=${handle.key} ${String(err)}`);
    });
}

function handleBridgeLine(handle: ClaudeBridgeSessionHandle, rawLine: string): void {
  const trimmedLine = rawLine.trim();
  if (LOG_RAW_EVENTS && trimmedLine) {
    log.info(`claude bridge event: session=${handle.key} ${trimmedLine}`);
  }
  const event = parseClaudeBridgeLine(rawLine);
  if (!event || !handle.activeTurn) {
    return;
  }

  const turn = handle.activeTurn;

  // Claude can emit partial-message stream events before the final assistant or
  // result snapshot. Consume those first so callers can stream live progress.
  if (isClaudeBridgeAssistantMessageStart(event) && !turn.assistantStarted) {
    turn.assistantStarted = true;
    queueTurnCallback(handle, async () => {
      await turn.onAssistantMessageStart?.();
    });
    return;
  }

  const textDelta = readClaudeBridgeTextDelta(event);
  if (textDelta) {
    const nextText = `${turn.lastAssistantText}${textDelta}`;
    turn.lastAssistantText = nextText;

    if (!turn.assistantStarted) {
      turn.assistantStarted = true;
      queueTurnCallback(handle, async () => {
        await turn.onAssistantMessageStart?.();
      });
    }

    if (turn.onPartialReply && nextText !== turn.lastDeliveredPartialText) {
      turn.lastDeliveredPartialText = nextText;
      queueTurnCallback(handle, async () => {
        await turn.onPartialReply?.({ text: nextText });
      });
    }

    if (turn.onBlockReply) {
      const blockPayload = turn.blockAccumulator.consume(textDelta);
      if (blockPayload) {
        queueTurnCallback(handle, async () => {
          await turn.onBlockReply?.(blockPayload);
        });
      }
    }
    return;
  }

  if (event.type === "assistant") {
    const text = collectClaudeBridgeText(
      (event.message as { content?: unknown } | undefined)?.content,
    );
    if (text) {
      turn.assistantTexts.push(text);
      const previousText = turn.lastAssistantText;
      const nextText = text;
      const grewMonotonically = !previousText || nextText.startsWith(previousText);
      const delta = !previousText
        ? nextText
        : grewMonotonically
          ? nextText.slice(previousText.length)
          : "";

      if (nextText.length >= previousText.length) {
        turn.lastAssistantText = nextText;
      }

      if (!turn.assistantStarted) {
        turn.assistantStarted = true;
        queueTurnCallback(handle, async () => {
          await turn.onAssistantMessageStart?.();
        });
      }

      if (
        turn.onPartialReply &&
        grewMonotonically &&
        nextText &&
        nextText !== turn.lastDeliveredPartialText
      ) {
        turn.lastDeliveredPartialText = nextText;
        queueTurnCallback(handle, async () => {
          await turn.onPartialReply?.({ text: nextText });
        });
      }

      if (turn.onBlockReply && delta) {
        const blockPayload = turn.blockAccumulator.consume(delta);
        if (blockPayload) {
          queueTurnCallback(handle, async () => {
            await turn.onBlockReply?.(blockPayload);
          });
        }
      }
    }
    return;
  }

  if (event.type === "result") {
    const sessionId =
      typeof event.session_id === "string" && event.session_id.trim()
        ? event.session_id.trim()
        : handle.currentClaudeSessionId;
    if (sessionId) {
      handle.currentClaudeSessionId = sessionId;
    }

    const usage = readClaudeBridgeUsage(event.usage);
    const resultText = collectClaudeBridgeText(event.result);
    const previousText = turn.lastAssistantText;
    const grewMonotonically = !previousText || resultText.startsWith(previousText);
    const trailingDelta =
      resultText && grewMonotonically ? resultText.slice(previousText.length) : "";

    if (!turn.assistantStarted && (resultText || turn.lastAssistantText)) {
      turn.assistantStarted = true;
      queueTurnCallback(handle, async () => {
        await turn.onAssistantMessageStart?.();
      });
    }

    if (resultText) {
      turn.lastAssistantText = resultText;
      if (turn.onPartialReply && resultText !== turn.lastDeliveredPartialText) {
        turn.lastDeliveredPartialText = resultText;
        queueTurnCallback(handle, async () => {
          await turn.onPartialReply?.({ text: resultText });
        });
      }
    }

    if (turn.onBlockReply) {
      const finalBlockPayload = turn.blockAccumulator.consume(trailingDelta, { final: true });
      if (finalBlockPayload) {
        queueTurnCallback(handle, async () => {
          await turn.onBlockReply?.(finalBlockPayload);
        });
      }
    }

    const text = resultText || turn.lastAssistantText || turn.assistantTexts.at(-1) || "";
    clearTimeout(turn.timer);
    handle.activeTurn = null;
    void turn.callbackChain.finally(() => {
      turn.resolve({
        text,
        sessionId,
        usage,
      });
    });
  }
}

async function writeTurnInput(
  child: ChildProcessWithoutNullStreams,
  prompt: string,
): Promise<void> {
  const payload = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      child.stdin.removeListener("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      child.stdin.removeListener("error", onError);
      resolve();
    };

    child.stdin.once("error", onError);
    if (child.stdin.write(`${payload}\n`)) {
      child.stdin.removeListener("error", onError);
      resolve();
      return;
    }
    child.stdin.once("drain", onDrain);
  });
}

async function startBridgeChild(params: {
  handle: ClaudeBridgeSessionHandle;
  backend: CliBackendConfig;
  workspaceDir: string;
  model: string;
  sessionId?: string;
  systemPrompt?: string;
}): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(backendCommand(params.backend), buildBridgeArgs(params), {
    cwd: params.workspaceDir,
    env: buildBridgeEnv(params.backend),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  params.handle.child = child;
  params.handle.stdoutBuffer = "";

  child.stdout.on("data", (chunk: string) => {
    params.handle.stdoutBuffer += chunk;
    let newlineIndex = params.handle.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = params.handle.stdoutBuffer.slice(0, newlineIndex);
      params.handle.stdoutBuffer = params.handle.stdoutBuffer.slice(newlineIndex + 1);
      handleBridgeLine(params.handle, line);
      newlineIndex = params.handle.stdoutBuffer.indexOf("\n");
    }
  });

  // Claude writes incidental diagnostics to stderr. The spike does not need them.
  child.stderr.on("data", () => {});

  child.on("exit", (code, signal) => {
    if (params.handle.activeTurn) {
      const error = new Error(
        `Claude bridge process exited before completing the turn (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      failActiveTurn(params.handle, error);
    }
    params.handle.child = undefined;
    params.handle.stdoutBuffer = "";
    SESSION_REGISTRY.delete(params.handle.key);
  });

  return child;
}

async function runBridgeTurn(params: {
  handle: ClaudeBridgeSessionHandle;
  backend: CliBackendConfig;
  workspaceDir: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  timeoutMs: number;
  sessionId?: string;
  onAssistantMessageStart?: () => void | Promise<void>;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: ReplyPayload) => void | Promise<void>;
}): Promise<ClaudeBridgeTurnResult> {
  const child =
    params.handle.child ??
    (await startBridgeChild({
      handle: params.handle,
      backend: params.backend,
      workspaceDir: params.workspaceDir,
      model: params.model,
      sessionId: params.sessionId,
      systemPrompt: params.systemPrompt,
    }));

  const turnPromise = new Promise<ClaudeBridgeTurnResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new FailoverError("Claude bridge turn timed out.", {
        reason: "timeout",
        provider: "claude-bridge",
        model: params.model,
        status: resolveFailoverStatus("timeout"),
      });
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort cleanup only.
      }
      failActiveTurn(params.handle, error);
      reject(error);
    }, params.timeoutMs);

    params.handle.activeTurn = {
      resolve,
      reject,
      timer,
      assistantTexts: [],
      lastAssistantText: "",
      lastDeliveredPartialText: "",
      assistantStarted: false,
      callbackChain: Promise.resolve(),
      onAssistantMessageStart: params.onAssistantMessageStart,
      onPartialReply: params.onPartialReply,
      onBlockReply: params.onBlockReply,
      blockAccumulator: createStreamingDirectiveAccumulator(),
    };
  });

  await writeTurnInput(child, params.prompt);
  return await turnPromise;
}

export async function runClaudeBridgeAgent(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configBackend: CliBackendConfig;
  prompt: string;
  provider: string;
  model: string;
  timeoutMs: number;
  systemPrompt?: string;
  systemPromptReport: SessionSystemPromptReport;
  cliSessionId?: string;
  onAssistantMessageStart?: () => void | Promise<void>;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: ReplyPayload) => void | Promise<void>;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const modelId = normalizeCliModel(params.model, params.configBackend);
  const handle = SESSION_REGISTRY.get(sessionKey) ?? createBridgeSessionHandle(sessionKey);
  SESSION_REGISTRY.set(sessionKey, handle);

  log.info(
    `claude bridge turn: provider=${params.provider} model=${modelId} session=${sessionKey} promptChars=${params.prompt.length}`,
  );

  try {
    const turnPromise = handle.turnQueue.then(() =>
      runBridgeTurn({
        handle,
        backend: params.configBackend,
        workspaceDir: params.workspaceDir,
        model: modelId,
        systemPrompt: params.systemPrompt,
        prompt: params.prompt,
        timeoutMs: params.timeoutMs,
        sessionId: params.cliSessionId,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onPartialReply: params.onPartialReply,
        onBlockReply: params.onBlockReply,
      }),
    );
    handle.turnQueue = turnPromise.then(
      () => undefined,
      () => undefined,
    );
    const turn = await turnPromise;

    const text = turn.text.trim();
    return {
      payloads: text ? [{ text }] : undefined,
      meta: {
        durationMs: Date.now() - started,
        systemPromptReport: params.systemPromptReport,
        agentMeta: {
          sessionId: turn.sessionId ?? params.cliSessionId ?? params.sessionId,
          provider: params.provider,
          model: modelId,
          usage: turn.usage,
          lastCallUsage: turn.usage,
        },
      },
    };
  } finally {
    // No per-turn cleanup in the minimal bridge spike.
  }
}

export async function clearClaudeBridgeSessionsForTests(): Promise<void> {
  const sessions = [...SESSION_REGISTRY.values()];
  SESSION_REGISTRY.clear();
  for (const session of sessions) {
    try {
      session.child?.kill("SIGKILL");
    } catch {
      // Ignore cleanup failures in tests.
    }
  }
}
