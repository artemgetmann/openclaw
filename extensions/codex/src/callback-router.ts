export const JARVIS_CALLBACK_TOOL_NAME = "jarvis_callback";

export const JARVIS_CALLBACK_DYNAMIC_TOOL = {
  type: "function",
  name: JARVIS_CALLBACK_TOOL_NAME,
  description:
    "Send a meaningful progress, blocker, decision-needed, or completion message to the exact Jarvis coordinator that launched this turn. Do not use this tool merely to acknowledge a message or callback receipt.",
  inputSchema: {
    type: "object",
    properties: {
      delegation_id: { type: "string" },
      callback_id: { type: "string" },
      sequence: { type: "integer", minimum: 1 },
      status: {
        type: "string",
        enum: ["progress", "blocked", "decision-needed", "complete"],
      },
      message: { type: "string" },
      changed_files: {
        type: "array",
        items: { type: "string" },
        maxItems: 100,
      },
      proof: {
        type: "array",
        items: { type: "string" },
        maxItems: 100,
      },
      next_action: { type: "string" },
      work_continues: { type: "boolean" },
    },
    required: ["delegation_id", "callback_id", "sequence", "status", "message"],
    additionalProperties: false,
  },
} as const;

export type CodexCallbackStatus = "progress" | "blocked" | "decision-needed" | "complete";

export type CodexCallbackEnvelope = {
  delegationId: string;
  callbackId: string;
  sequence: number;
  status: CodexCallbackStatus;
  message: string;
  changedFiles?: string[];
  proof?: string[];
  nextAction?: string;
  workContinues?: boolean;
  threadId: string;
  turnId: string;
  sessionKey: string;
  agentId?: string;
};

export type CodexCallbackGrant = {
  delegationId: string;
  threadId: string;
  turnId: string;
  sessionKey: string;
  agentId?: string;
};

export type CodexDynamicToolRequest = {
  method: string;
  params?: Record<string, unknown>;
};

type CallbackResult = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

type AcceptedCallback = {
  callbackId: string;
  sequence: number;
  fingerprint: string;
};

type ActiveGrant = CodexCallbackGrant & {
  nextSequence: number;
  completeDelivered: boolean;
  acceptedById: Map<string, AcceptedCallback>;
  queue: Promise<void>;
};

type CallbackRouterOptions = {
  dispatch: (callback: CodexCallbackEnvelope) => Promise<void>;
};

/**
 * Process-local authority for one Jarvis-launched native Codex turn.
 *
 * Model-provided arguments are never trusted as routing data. A callback is
 * accepted only when the App Server request's own thread and turn identity
 * match an active grant recorded after turn/start returned.
 */
export class CodexCallbackRouter {
  private readonly grants = new Map<string, ActiveGrant>();

  constructor(private readonly options: CallbackRouterOptions) {}

  register(grant: CodexCallbackGrant): void {
    if (this.grants.has(grant.delegationId)) {
      throw new Error(`Codex callback grant ${grant.delegationId} already exists`);
    }
    this.grants.set(grant.delegationId, {
      ...grant,
      nextSequence: 1,
      completeDelivered: false,
      acceptedById: new Map(),
      queue: Promise.resolve(),
    });
  }

  findActiveTurn(params: { threadId: string; sessionKey: string }):
    | {
        delegationId: string;
        threadId: string;
        turnId: string;
      }
    | undefined {
    for (const grant of this.grants.values()) {
      if (grant.threadId === params.threadId && grant.sessionKey === params.sessionKey) {
        return {
          delegationId: grant.delegationId,
          threadId: grant.threadId,
          turnId: grant.turnId,
        };
      }
    }
    return undefined;
  }

  async finish(params: {
    delegationId: string;
    threadId: string;
    turnId: string;
  }): Promise<{ completeDelivered: boolean }> {
    const grant = this.grants.get(params.delegationId);
    if (!grant || grant.threadId !== params.threadId || grant.turnId !== params.turnId) {
      return { completeDelivered: false };
    }

    // A terminal notification can race the final callback response. Drain the
    // per-grant queue before deciding whether the terminal listener is still
    // needed as reconciliation fallback.
    await grant.queue;
    this.grants.delete(params.delegationId);
    return { completeDelivered: grant.completeDelivered };
  }

  async handleServerRequest(request: CodexDynamicToolRequest): Promise<CallbackResult | undefined> {
    if (request.method !== "item/tool/call") {
      return undefined;
    }
    const params = asRecord(request.params);
    if (readString(params.tool) !== JARVIS_CALLBACK_TOOL_NAME) {
      return undefined;
    }

    const args = asRecord(params.arguments);
    requireString(params.callId, "callId");
    rejectUnknownArguments(args);
    const delegationId = requireString(args.delegation_id, "delegation_id");
    const grant = this.grants.get(delegationId);
    if (!grant) {
      throw new Error("Codex callback delegation is stale or unknown");
    }

    const threadId = requireString(params.threadId, "threadId");
    const turnId = requireString(params.turnId, "turnId");
    if (threadId !== grant.threadId || turnId !== grant.turnId) {
      throw new Error("Codex callback source does not match the active delegation");
    }

    // Serialize sequence checks and dispatch so concurrent retries cannot wake
    // Jarvis twice or race two different callback ids through one sequence.
    const task = grant.queue.then(async () => await this.processCallback(grant, args));
    grant.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async processCallback(
    grant: ActiveGrant,
    args: Record<string, unknown>,
  ): Promise<CallbackResult> {
    const callbackId = requireBoundedString(args.callback_id, "callback_id", 200);
    const sequence = requirePositiveInteger(args.sequence, "sequence");
    const status = requireStatus(args.status);
    const message = requireBoundedString(args.message, "message", 16_000, true);
    if (isReceiptOnly(message)) {
      throw new Error("Codex callback must contain useful work content, not only a receipt");
    }

    const changedFiles = readOptionalStringArray(args.changed_files, "changed_files");
    const proof = readOptionalStringArray(args.proof, "proof");
    const nextAction = readOptionalBoundedString(args.next_action, "next_action", 4_000);
    const workContinues = readOptionalBoolean(args.work_continues, "work_continues");
    const fingerprint = JSON.stringify({
      callbackId,
      sequence,
      status,
      message,
      changedFiles,
      proof,
      nextAction,
      workContinues,
    });

    const accepted = grant.acceptedById.get(callbackId);
    if (accepted) {
      if (accepted.sequence !== sequence || accepted.fingerprint !== fingerprint) {
        throw new Error("Codex callback id was reused with different content");
      }
      return callbackResponse(
        `Callback ${callbackId} was already delivered. Do not report receipt.`,
      );
    }
    if (grant.completeDelivered) {
      throw new Error("Codex callback delegation already delivered completion");
    }
    if (sequence !== grant.nextSequence) {
      throw new Error(
        `Codex callback sequence ${sequence} is invalid; expected ${grant.nextSequence}`,
      );
    }

    await this.options.dispatch({
      delegationId: grant.delegationId,
      callbackId,
      sequence,
      status,
      message,
      ...(changedFiles ? { changedFiles } : {}),
      ...(proof ? { proof } : {}),
      ...(nextAction ? { nextAction } : {}),
      ...(workContinues === undefined ? {} : { workContinues }),
      threadId: grant.threadId,
      turnId: grant.turnId,
      sessionKey: grant.sessionKey,
      ...(grant.agentId ? { agentId: grant.agentId } : {}),
    });

    grant.acceptedById.set(callbackId, { callbackId, sequence, fingerprint });
    grant.nextSequence += 1;
    if (status === "complete") {
      grant.completeDelivered = true;
    }
    return callbackResponse(
      `Callback ${callbackId} delivered. Continue the task; do not report receipt.`,
    );
  }
}

function callbackResponse(text: string): CallbackResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

function requireStatus(value: unknown): CodexCallbackStatus {
  if (
    value === "progress" ||
    value === "blocked" ||
    value === "decision-needed" ||
    value === "complete"
  ) {
    return value;
  }
  throw new Error("status must be progress, blocked, decision-needed, or complete");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  preserveWhitespace = false,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return preserveWhitespace ? value : value.trim();
}

function readOptionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireBoundedString(value, field, maxLength);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function readOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} must be an array with at most 100 items`);
  }
  return value.map((item, index) => requireBoundedString(item, `${field}[${index}]`, 2_000));
}

function isReceiptOnly(message: string): boolean {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:\s]+/g, " ")
    .trim();
  return /^(ok|okay|ack|acknowledged|received|receipt received|callback received|callback accepted|thank you|thanks)$/.test(
    normalized,
  );
}

function rejectUnknownArguments(args: Record<string, unknown>): void {
  const allowed = new Set([
    "delegation_id",
    "callback_id",
    "sequence",
    "status",
    "message",
    "changed_files",
    "proof",
    "next_action",
    "work_continues",
  ]);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`unexpected Codex callback field: ${unknown}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
