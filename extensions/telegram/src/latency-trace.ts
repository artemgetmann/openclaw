import { randomUUID } from "node:crypto";
import type { RuntimeEnv } from "../../../src/runtime.js";

type TelegramReplyLatencyTraceFields = Record<string, string | number | boolean | null | undefined>;

export type TelegramReplyLatencyTrace = {
  id: string;
  startedAtMs: number;
  mark: (span: string, fields?: TelegramReplyLatencyTraceFields) => void;
};

function normalizeTraceValue(value: string | number | boolean | null | undefined): string {
  if (value == null) {
    return "na";
  }
  return String(value).replace(/\s+/g, "_");
}

export function createTelegramReplyLatencyTrace(params: {
  runtime: RuntimeEnv;
  traceId?: string;
  startedAtMs?: number;
}): TelegramReplyLatencyTrace {
  const id = params.traceId ?? randomUUID();
  const startedAtMs = params.startedAtMs ?? Date.now();
  return {
    id,
    startedAtMs,
    mark: (span, fields) => {
      const elapsedMs = Date.now() - startedAtMs;
      const fieldText = Object.entries(fields ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${normalizeTraceValue(value)}`)
        .join(" ");
      params.runtime.log?.(
        [
          "telegram.reply.latency",
          `trace=${id}`,
          `span=${span}`,
          `elapsedMs=${elapsedMs}`,
          fieldText,
        ]
          .filter(Boolean)
          .join(" "),
      );
    },
  };
}
