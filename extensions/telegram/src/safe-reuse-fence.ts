/**
 * Shared safe-reuse transaction. Both the production poller and the
 * test-only counterparty harness use this exact ordering so neither can make
 * a second destructive `getUpdates(offset: -1)` read after an ambiguous one.
 */
import { formatErrorMessage } from "../../../src/infra/errors.js";

export class TelegramSafeReuseManualRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramSafeReuseManualRecoveryError";
  }
}

export type TelegramSafeReuseFenceOperations = {
  generation: string;
  resolveState: () => Promise<{
    phase: "reading" | "pending" | "complete";
    lastUpdateId: number | null;
    recreateBot?: boolean;
  } | null>;
  markReading: () => Promise<void>;
  markPending: (lastUpdateId: number | null) => Promise<void>;
  persistCutoff: (lastUpdateId: number | null) => Promise<void>;
  markComplete: (lastUpdateId: number | null) => Promise<void>;
  readTail: () => Promise<unknown>;
  log: (line: string) => void;
};

export async function runTelegramSafeReuseFenceTransaction(
  fence: TelegramSafeReuseFenceOperations,
): Promise<"ready" | "recreate"> {
  const state = await fence.resolveState();
  if (state?.phase === "complete") {
    return state.recreateBot ? "recreate" : "ready";
  }
  if (state?.phase === "reading") {
    throw new TelegramSafeReuseManualRecoveryError(
      `Telegram safe-reuse tail-read outcome is ambiguous for reservation generation ${fence.generation}. Manual recovery is required; refusing to issue getUpdates(offset: -1) again.`,
    );
  }
  if (state?.phase === "pending") {
    await fence.persistCutoff(state.lastUpdateId);
    await fence.markComplete(state.lastUpdateId);
    fence.log(
      `[telegram] Recovered pending safe-reuse backlog fence for reservation generation ${fence.generation}.`,
    );
    return "recreate";
  }

  // Durable intent comes before the destructive tail read. If its response is
  // lost after Telegram processes it, the next run stops for manual recovery.
  await fence.markReading();
  let updates: unknown;
  try {
    updates = await fence.readTail();
  } catch (err) {
    throw new TelegramSafeReuseManualRecoveryError(
      `Telegram safe-reuse tail-read outcome is ambiguous for reservation generation ${fence.generation}: ${formatErrorMessage(err)}. Manual recovery is required; refusing to issue getUpdates(offset: -1) again.`,
    );
  }
  if (!Array.isArray(updates)) {
    throw new Error("Telegram safe-reuse fence returned a malformed update list.");
  }
  let lastUpdateId: number | null = null;
  for (const update of updates) {
    const updateId = (update as { update_id?: unknown }).update_id;
    if (!Number.isSafeInteger(updateId) || Number(updateId) < 0) {
      throw new Error("Telegram safe-reuse fence returned an invalid update id.");
    }
    lastUpdateId =
      lastUpdateId === null ? Number(updateId) : Math.max(lastUpdateId, Number(updateId));
  }
  await fence.markPending(lastUpdateId);
  await fence.persistCutoff(lastUpdateId);
  await fence.markComplete(lastUpdateId);
  fence.log(
    `[telegram] Completed safe-reuse backlog fence for reservation generation ${fence.generation}.`,
  );
  return "recreate";
}
