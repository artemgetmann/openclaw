import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeEnv } from "../runtime.js";
import {
  observeBrowserReplyOnce,
  type BrowserReplyMatchMode,
  type BrowserReplyObservationResult,
  type BrowserReplyObserverConfig,
} from "./reply-monitor.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ERROR_LENGTH = 300;

export type BrowserReplyCommandDeps = {
  env?: NodeJS.ProcessEnv;
  observeOnce?: (config: BrowserReplyObserverConfig) => Promise<BrowserReplyObservationResult>;
  sleep?: (delayMs: number) => Promise<unknown>;
};

export function resolveBrowserMonitorHookToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.OPENCLAW_HOOKS_TOKEN?.trim() || undefined;
}

export function formatBrowserReplyPollError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (raw.trim() || "unknown error").replace(/\s+/g, " ").slice(0, MAX_POLL_ERROR_LENGTH);
}

function readString(opts: Record<string, unknown>, key: string): string {
  const value = opts[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Browser reply observer requires --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.`,
    );
  }
  return value.trim();
}

function readPositiveInteger(
  opts: Record<string, unknown>,
  key: string,
  fallback?: number,
): number {
  const value = opts[key] ?? fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Browser reply observer requires --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} to be a positive integer.`,
    );
  }
  return parsed;
}

export async function browserReplyObserveCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
  deps: BrowserReplyCommandDeps = {},
): Promise<void> {
  const watch = opts.watch === true;
  const maxRuns = opts.maxRuns === undefined ? undefined : readPositiveInteger(opts, "maxRuns");
  const pollIntervalMs = readPositiveInteger(opts, "pollIntervalMs", DEFAULT_POLL_INTERVAL_MS);
  const hookToken = resolveBrowserMonitorHookToken(deps.env);
  if (!hookToken) {
    throw new Error(
      "Browser reply observer requires OPENCLAW_HOOKS_TOKEN for the dedicated hooks.token secret.",
    );
  }
  const config: BrowserReplyObserverConfig = {
    browserBaseUrl: typeof opts.browserUrl === "string" ? opts.browserUrl.trim() : undefined,
    cursorStorePath: typeof opts.cursorStore === "string" ? opts.cursorStore.trim() : undefined,
    // Keep the gateway credential out of long-running process arguments.
    hookToken,
    hookUrl: readString(opts, "hookUrl"),
    matchMode: readString(opts, "matchMode") as BrowserReplyMatchMode,
    matchValue: readString(opts, "matchValue"),
    monitorId: readString(opts, "monitorId"),
    profile: readString(opts, "profile"),
    selector: readString(opts, "selector"),
    targetId: readString(opts, "targetId"),
    urlPattern: readString(opts, "urlPattern"),
  };
  const observeOnce = deps.observeOnce ?? observeBrowserReplyOnce;
  const wait = deps.sleep ?? sleep;

  for (let run = 1; ; run += 1) {
    try {
      const result = await observeOnce(config);
      runtime.log(JSON.stringify(watch ? { run, ...result } : result, null, 2));
    } catch (error) {
      if (!watch) {
        throw error;
      }
      runtime.error(
        `Browser reply observer poll failed run=${run}: ${formatBrowserReplyPollError(error)}`,
      );
    }
    if (!watch || (maxRuns !== undefined && run >= maxRuns)) {
      return;
    }
    await wait(pollIntervalMs);
  }
}
