import type { OpenClawConfig } from "../../config/types.js";
import type { BlockReplyContext, ReplyPayload } from "../types.js";

export const DEFAULT_REPLY_RUN_WATCHDOG_INTERVAL_MS = 90_000;
export const DEFAULT_REPLY_RUN_WATCHDOG_TEXT = "";

export type ReplyRunWatchdogConfig = {
  enabled: boolean;
  intervalMs: number;
  text: string;
};

type WatchdogConfigRecord = {
  enabled?: boolean;
  intervalMs?: number;
  text?: string;
};

function readWatchdogConfig(cfg: OpenClawConfig): WatchdogConfigRecord | undefined {
  return cfg.agents?.defaults?.replyRunWatchdog;
}

export function resolveReplyRunWatchdogConfig(cfg: OpenClawConfig): ReplyRunWatchdogConfig {
  const raw = readWatchdogConfig(cfg);
  const intervalMs =
    typeof raw?.intervalMs === "number" && Number.isFinite(raw.intervalMs) && raw.intervalMs > 0
      ? raw.intervalMs
      : DEFAULT_REPLY_RUN_WATCHDOG_INTERVAL_MS;
  const text = raw?.text?.trim() || DEFAULT_REPLY_RUN_WATCHDOG_TEXT;
  return {
    // The watchdog has no evidence snapshot, so it must stay silent unless an
    // operator explicitly opts in with a concrete, configured status message.
    enabled: raw?.enabled === true && text.length > 0,
    intervalMs,
    text,
  };
}

export function startReplyRunWatchdog(params: {
  cfg: OpenClawConfig;
  enabled: boolean;
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  log?: (message: string) => void;
}): () => void {
  if (!params.enabled || !params.onBlockReply) {
    return () => {};
  }
  const config = resolveReplyRunWatchdogConfig(params.cfg);
  if (!config.enabled) {
    return () => {};
  }

  let stopped = false;
  const timer = setTimeout(() => {
    if (stopped) {
      return;
    }
    void Promise.resolve(params.onBlockReply?.({ text: config.text }))
      .then(() => {
        params.log?.(`reply run watchdog sent progress ping after ${config.intervalMs}ms`);
      })
      .catch((err) => {
        params.log?.(`reply run watchdog progress ping failed: ${String(err)}`);
      });
  }, config.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
