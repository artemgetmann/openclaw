type AgentEventHandler = (event: {
  stream: string;
  data: Record<string, unknown>;
}) => void | Promise<void>;

type EmitCompactionLifecycleEventParams = {
  onAgentEvent?: AgentEventHandler;
  phase: "start" | "end";
  completed?: boolean;
  willRetry?: boolean;
  warn: (message: string) => void;
};

/**
 * Exposes runner-owned compaction through the same lifecycle stream as SDK
 * compaction. Delivery is best-effort because a broken status channel must
 * never prevent the recovery operation that makes the conversation usable.
 */
export async function emitCompactionLifecycleEvent(
  params: EmitCompactionLifecycleEventParams,
): Promise<void> {
  if (!params.onAgentEvent) {
    return;
  }

  const data: Record<string, unknown> = { phase: params.phase };
  if (params.phase === "end") {
    data.completed = params.completed === true;
    data.willRetry = params.willRetry === true;
  }

  try {
    await params.onAgentEvent({ stream: "compaction", data });
  } catch (error) {
    params.warn(
      `compaction ${params.phase} notification failed during overflow recovery: ${String(error)}`,
    );
  }
}
