import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import type { MonitorEventEnvelope } from "../monitor/types.js";
import { browserAct } from "./client-actions.js";
import { browserTabs } from "./client.js";

const MAX_SELECTOR_LENGTH = 1_024;
const MAX_MATCH_VALUE_LENGTH = 1_024;
const MAX_OBSERVED_TEXT_LENGTH = 16_384;
const DEFAULT_CURSOR_FILENAME = "browser-reply-monitor-cursors.json";
const CURSOR_STORE_LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true },
  stale: 30_000,
} as const;
// Dispatch happens while the cursor transaction is held so a successful wake
// and its cursor advance are atomic. Finish well before the lock can be
// considered stale: another process must never steal the lock mid-request.
export const BROWSER_REPLY_DISPATCH_TIMEOUT_MS = 25_000;
const cursorStoreWriteLocks = new Map<string, Promise<void>>();

export type BrowserReplyMatchMode = "exact" | "contains";

export type BrowserReplyObserverConfig = {
  browserBaseUrl?: string;
  cursorStorePath?: string;
  hookToken?: string;
  hookUrl: string;
  matchMode: BrowserReplyMatchMode;
  matchValue: string;
  monitorId: string;
  profile: string;
  selector: string;
  targetId: string;
  urlPattern: string;
};

export type BrowserReplyCursor = {
  lastStateHash: string;
  ruleHash: string;
  /** Monotonic per-rule transition identity; absent only in pre-migration stores. */
  transitionGeneration?: number;
  updatedAtMs: number;
};

export type BrowserReplyCursorStore = {
  version: 1;
  cursors: Record<string, BrowserReplyCursor>;
};

export type BrowserReplyObservationResult = {
  cursorStorePath: string;
  dispatched: boolean;
  found: boolean;
  matched: boolean;
  stateChanged: boolean;
  stateHash?: string;
};

/** A permanent error in observer inputs that a watch loop must not retry. */
export class BrowserReplyObserverConfigurationError extends Error {
  override readonly name = "BrowserReplyObserverConfigurationError";
}

/** A hook response error whose status lets watch mode distinguish retries from permanent failures. */
export class BrowserReplyObserverHookHttpError extends Error {
  override readonly name = "BrowserReplyObserverHookHttpError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The in-lock hook dispatch exceeded its bounded deadline and left the cursor unchanged. */
export class BrowserReplyObserverDispatchTimeoutError extends Error {
  override readonly name = "BrowserReplyObserverDispatchTimeoutError";
}

type BrowserPageProbe = {
  allowed: boolean;
  configurationError?: "invalid_selector";
  found: boolean;
  text: string;
  url: string;
};

type BrowserReplyObserverDeps = {
  dispatchEvent?: (params: {
    event: MonitorEventEnvelope;
    hookToken?: string;
    hookUrl: string;
    monitorId: string;
    /** Optional so existing injected dispatchers remain source-compatible. */
    signal?: AbortSignal;
  }) => Promise<unknown>;
  /** Test-only override of the bounded in-lock dispatch deadline. */
  dispatchTimeoutMs?: number;
  nowMs?: number;
  readPage?: (
    config: BrowserReplyObserverConfig,
    allowedUrlRegex: RegExp,
  ) => Promise<BrowserPageProbe>;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function globPatternToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      const isDoubleGlob = pattern[index + 1] === "*";
      source += isDoubleGlob ? ".*" : "[^?#]*";
      if (isDoubleGlob) {
        index += 1;
      }
      continue;
    }
    source += /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
  }
  return source;
}

function requireBoundedValue(name: string, value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BrowserReplyObserverConfigurationError(`Browser reply observer requires ${name}.`);
  }
  if (trimmed.length > maxLength) {
    throw new BrowserReplyObserverConfigurationError(
      `Browser reply observer ${name} exceeds ${maxLength} characters.`,
    );
  }
  return trimmed;
}

/**
 * Browser observers deliberately accept only an absolute HTTP(S) origin with
 * optional globs after the origin. This prevents a loose substring such as
 * "example.com" from accidentally authorizing a lookalike host.
 */
export function compileApprovedBrowserUrlPattern(rawPattern: string): RegExp {
  const pattern = requireBoundedValue("--url-pattern", rawPattern, 2_048);
  const originMatch = /^(https?):\/\/([^/?#]+)(.*)$/.exec(pattern);
  if (!originMatch || originMatch[2].includes("*")) {
    throw new BrowserReplyObserverConfigurationError(
      "Browser reply observer --url-pattern must be an absolute HTTP(S) URL with wildcards only after the origin.",
    );
  }
  // URL parsing validates the fixed origin without interpreting path globs.
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(`${originMatch[1]}://${originMatch[2]}`);
  } catch (err) {
    throw new BrowserReplyObserverConfigurationError(
      `Browser reply observer --url-pattern must use a valid URL origin: ${String(err)}`,
    );
  }
  if (!parsedOrigin.hostname || parsedOrigin.username || parsedOrigin.password) {
    throw new BrowserReplyObserverConfigurationError(
      "Browser reply observer --url-pattern must use a credential-free URL origin.",
    );
  }
  return new RegExp(`^${globPatternToRegexSource(pattern)}$`);
}

export function resolveLocalBrowserMonitorHookUrl(rawHookUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawHookUrl);
  } catch (err) {
    throw new BrowserReplyObserverConfigurationError(
      `Browser reply observer requires a valid --hook-url: ${String(err)}`,
    );
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !loopbackHosts.has(url.hostname) ||
    !normalizedPath.endsWith("/monitor-event")
  ) {
    throw new BrowserReplyObserverConfigurationError(
      "Browser reply observer --hook-url must target the local gateway /hooks/monitor-event endpoint.",
    );
  }
  url.pathname = normalizedPath;
  return url.toString();
}

export function resolveBrowserReplyCursorStorePath(explicitPath?: string): string {
  return explicitPath?.trim()
    ? path.resolve(explicitPath.trim())
    : path.join(resolveStateDir(), "browser", DEFAULT_CURSOR_FILENAME);
}

export async function loadBrowserReplyCursorStore(
  storePath: string,
): Promise<BrowserReplyCursorStore> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(storePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor store must be an object");
    }
    const record = parsed as Record<string, unknown>;
    const cursors =
      record.cursors && typeof record.cursors === "object" && !Array.isArray(record.cursors)
        ? (record.cursors as Record<string, BrowserReplyCursor>)
        : {};
    return { version: 1, cursors };
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") {
      return { version: 1, cursors: {} };
    }
    throw new Error(`Unable to read browser reply observer cursor store: ${String(err)}`, {
      cause: err,
    });
  }
}

export async function saveBrowserReplyCursorStore(
  storePath: string,
  store: BrowserReplyCursorStore,
): Promise<void> {
  const directory = path.dirname(storePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(directory, 0o700).catch(() => undefined);
  const tempPath = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.promises.rename(tempPath, storePath);
  await fs.promises.chmod(storePath, 0o600).catch(() => undefined);
}

/**
 * Serialize same-process callers before taking the cross-process file lock.
 * The shared lock helper is intentionally re-entrant, so the local queue is
 * required to keep sibling async observers from entering together.
 */
async function withBrowserReplyCursorStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedPath = path.resolve(storePath);
  const previous = cursorStoreWriteLocks.get(normalizedPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  cursorStoreWriteLocks.set(normalizedPath, current);

  await previous.catch(() => undefined);
  try {
    return await withFileLock(normalizedPath, CURSOR_STORE_LOCK_OPTIONS, fn);
  } finally {
    release();
    if (cursorStoreWriteLocks.get(normalizedPath) === current) {
      cursorStoreWriteLocks.delete(normalizedPath);
    }
  }
}

function normalizeConfig(config: BrowserReplyObserverConfig): BrowserReplyObserverConfig {
  const matchMode = config.matchMode;
  if (matchMode !== "exact" && matchMode !== "contains") {
    throw new BrowserReplyObserverConfigurationError(
      "Browser reply observer --match-mode must be exact or contains.",
    );
  }
  const normalized = {
    ...config,
    hookUrl: resolveLocalBrowserMonitorHookUrl(config.hookUrl),
    matchValue: requireBoundedValue("--match-value", config.matchValue, MAX_MATCH_VALUE_LENGTH),
    monitorId: requireBoundedValue("--monitor-id", config.monitorId, 256),
    profile: requireBoundedValue("--profile", config.profile, 256),
    selector: requireBoundedValue("--selector", config.selector, MAX_SELECTOR_LENGTH),
    targetId: requireBoundedValue("--target-id", config.targetId, 512),
    urlPattern: requireBoundedValue("--url-pattern", config.urlPattern, 2_048),
  };
  compileApprovedBrowserUrlPattern(normalized.urlPattern);
  return normalized;
}

function matchesRule(text: string, mode: BrowserReplyMatchMode, value: string): boolean {
  if (mode === "exact") {
    return text === value;
  }
  return text.includes(value);
}

function nextTransitionGeneration(cursor: BrowserReplyCursor | undefined): number {
  const previous = cursor?.transitionGeneration;
  if (previous === undefined) {
    return 1;
  }
  if (!Number.isSafeInteger(previous) || previous < 1 || previous === Number.MAX_SAFE_INTEGER) {
    throw new Error("Browser reply observer cursor has an invalid transition generation.");
  }
  return previous + 1;
}

async function readSelectedPage(
  config: BrowserReplyObserverConfig,
  allowedUrlRegex: RegExp,
): Promise<BrowserPageProbe> {
  const tabs = await browserTabs(config.browserBaseUrl, { profile: config.profile });
  const selectedTab = tabs.find((tab) => tab.targetId === config.targetId && tab.type !== "other");
  if (!selectedTab) {
    throw new Error("Browser reply observer target tab is not available in the selected profile.");
  }
  if (!allowedUrlRegex.test(selectedTab.url)) {
    throw new Error("Browser reply observer target tab URL is outside --url-pattern.");
  }

  // The in-page URL guard closes the navigation race between tab discovery and
  // selector access. If the page moved outside scope, no DOM text is returned.
  const response = await browserAct(
    config.browserBaseUrl,
    {
      kind: "evaluate",
      targetId: config.targetId,
      fn: `() => {
        const allowed = new RegExp(${JSON.stringify(allowedUrlRegex.source)}).test(location.href);
        if (!allowed) return { allowed: false, found: false, text: "", url: location.href };
        let node;
        try {
          node = document.querySelector(${JSON.stringify(config.selector)});
        } catch {
          return {
            allowed: true,
            configurationError: "invalid_selector",
            found: false,
            text: "",
            url: location.href,
          };
        }
        const text = node ? String(node.textContent ?? "").trim().slice(0, ${MAX_OBSERVED_TEXT_LENGTH}) : "";
        return { allowed: true, found: Boolean(node), text, url: location.href };
      }`,
    },
    { profile: config.profile },
  );
  const result = response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Browser reply observer received an invalid page probe result.");
  }
  const probe = result as Record<string, unknown>;
  const pageProbe: BrowserPageProbe = {
    allowed: probe.allowed === true,
    configurationError:
      probe.configurationError === "invalid_selector" ? "invalid_selector" : undefined,
    found: probe.found === true,
    text: typeof probe.text === "string" ? probe.text.slice(0, MAX_OBSERVED_TEXT_LENGTH) : "",
    url: typeof probe.url === "string" ? probe.url : "",
  };
  if (!pageProbe.allowed || !allowedUrlRegex.test(pageProbe.url)) {
    throw new Error(
      "Browser reply observer page navigated outside --url-pattern before DOM access.",
    );
  }
  return pageProbe;
}

async function postBrowserMonitorEvent(params: {
  event: MonitorEventEnvelope;
  hookToken?: string;
  hookUrl: string;
  monitorId: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(params.hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(params.hookToken ? { Authorization: `Bearer ${params.hookToken}` } : {}),
    },
    body: JSON.stringify({ ...params.event, monitorId: params.monitorId }),
    signal: params.signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new BrowserReplyObserverHookHttpError(
      response.status,
      `browser reply monitor hook returned HTTP ${response.status}: ${body}`,
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function resolveDispatchTimeoutMs(configuredTimeoutMs?: number): number {
  if (typeof configuredTimeoutMs !== "number" || !Number.isFinite(configuredTimeoutMs)) {
    return BROWSER_REPLY_DISPATCH_TIMEOUT_MS;
  }
  // Test overrides may shorten the deadline but cannot erode the production
  // headroom below the stale-lock threshold.
  return Math.min(Math.max(1, Math.floor(configuredTimeoutMs)), BROWSER_REPLY_DISPATCH_TIMEOUT_MS);
}

async function dispatchBrowserMonitorEventWithTimeout(
  dispatchEvent: NonNullable<BrowserReplyObserverDeps["dispatchEvent"]>,
  params: {
    event: MonitorEventEnvelope;
    hookToken?: string;
    hookUrl: string;
    monitorId: string;
  },
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutError = new BrowserReplyObserverDispatchTimeoutError(
    `Browser reply observer hook dispatch timed out after ${timeoutMs}ms; cursor unchanged.`,
  );
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(controller.signal.reason ?? timeoutError);
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  try {
    // Race even injected dispatchers. The production fetch observes the signal,
    // while the race guarantees a non-cooperative test/custom dispatcher cannot
    // hold this cursor lock until its 30-second stale threshold.
    return await Promise.race([
      dispatchEvent({ ...params, signal: controller.signal }),
      abortPromise,
    ]);
  } finally {
    clearTimeout(timeout);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

function dispatchConfirmedWake(dispatch: unknown, monitorId: string): boolean {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
    return false;
  }
  const wakes = (dispatch as { wakes?: unknown }).wakes;
  if (!Array.isArray(wakes)) {
    return false;
  }
  return wakes.some((wake) => {
    if (!wake || typeof wake !== "object" || Array.isArray(wake)) {
      return false;
    }
    const record = wake as { monitorId?: unknown; enqueue?: unknown };
    if (record.monitorId !== monitorId || !record.enqueue || typeof record.enqueue !== "object") {
      return false;
    }
    const enqueue = record.enqueue as { ok?: unknown; enqueued?: unknown; ran?: unknown };
    return enqueue.ok === true && (enqueue.enqueued === true || enqueue.ran === true);
  });
}

export async function observeBrowserReplyOnce(
  rawConfig: BrowserReplyObserverConfig,
  deps: BrowserReplyObserverDeps = {},
): Promise<BrowserReplyObservationResult> {
  const config = normalizeConfig(rawConfig);
  const allowedUrlRegex = compileApprovedBrowserUrlPattern(config.urlPattern);
  const cursorStorePath = resolveBrowserReplyCursorStorePath(config.cursorStorePath);
  const probe = await (deps.readPage ?? readSelectedPage)(config, allowedUrlRegex);
  if (probe.configurationError === "invalid_selector") {
    throw new BrowserReplyObserverConfigurationError(
      "Browser reply observer --selector must be a valid CSS selector.",
    );
  }
  const matched = probe.found && matchesRule(probe.text, config.matchMode, config.matchValue);
  const ruleHash = hash(
    JSON.stringify({
      matchMode: config.matchMode,
      matchValue: config.matchValue,
      profile: config.profile,
      selector: config.selector,
      targetId: config.targetId,
      urlPattern: config.urlPattern,
    }),
  );
  // Include selector presence so an absent node and an empty node cannot mask
  // one another. The value is hashed before persistence; raw page text never
  // enters the cursor store or monitor event.
  const stateHash = hash(
    `${ruleHash}\u0000${probe.found ? "found" : "missing"}\u0000${probe.text}`,
  );
  const cursorKey = `monitor:${config.monitorId}:${ruleHash}`;
  return await withBrowserReplyCursorStoreLock(cursorStorePath, async () => {
    const cursorStore = await loadBrowserReplyCursorStore(cursorStorePath);
    const previousCursor = cursorStore.cursors[cursorKey];
    if (previousCursor?.lastStateHash === stateHash) {
      return {
        cursorStorePath,
        dispatched: false,
        found: probe.found,
        matched,
        stateChanged: false,
        stateHash,
      };
    }

    const receivedAtMs = deps.nowMs ?? Date.now();
    // The next generation is derived from durable cursor state. A failed
    // dispatch leaves the cursor unchanged, so retries reuse the same identity;
    // every persisted intervening state advances it before a later match.
    const transitionGeneration = nextTransitionGeneration(previousCursor);
    if (!matched) {
      // A no-match is a real state transition. Persist it without a wake so a
      // later return to the same matching DOM state is eligible to dispatch,
      // while a restart on this same no-match remains quiet.
      cursorStore.cursors[cursorKey] = {
        lastStateHash: stateHash,
        ruleHash,
        transitionGeneration,
        updatedAtMs: receivedAtMs,
      };
      await saveBrowserReplyCursorStore(cursorStorePath, cursorStore);
      return {
        cursorStorePath,
        dispatched: false,
        found: probe.found,
        matched: false,
        stateChanged: true,
        stateHash,
      };
    }

    const event: MonitorEventEnvelope = {
      triggerKind: "browser_observer",
      sourceType: "browser",
      sourceTarget: {
        profile: config.profile,
        ruleHash,
        selectorHash: hash(config.selector),
        targetId: config.targetId,
        urlPatternHash: hash(config.urlPattern),
      },
      eventType: "dom.text.matched",
      idempotencyKey: `browser:${hash(`${stateHash}\u0000${transitionGeneration}`)}`,
      receivedAtMs,
      evidence: {
        found: true,
        matchMode: config.matchMode,
        observedTextHash: hash(probe.text),
        ruleHash,
      },
    };
    const dispatch = await dispatchBrowserMonitorEventWithTimeout(
      deps.dispatchEvent ?? postBrowserMonitorEvent,
      {
        event,
        hookToken: config.hookToken,
        hookUrl: config.hookUrl,
        monitorId: config.monitorId,
      },
      resolveDispatchTimeoutMs(deps.dispatchTimeoutMs),
    );
    if (!dispatchConfirmedWake(dispatch, config.monitorId)) {
      throw new Error(
        "Browser reply observer dispatch did not confirm a monitor wake; cursor unchanged.",
      );
    }

    cursorStore.cursors[cursorKey] = {
      lastStateHash: stateHash,
      ruleHash,
      transitionGeneration,
      updatedAtMs: receivedAtMs,
    };
    await saveBrowserReplyCursorStore(cursorStorePath, cursorStore);
    return {
      cursorStorePath,
      dispatched: true,
      found: true,
      matched: true,
      stateChanged: true,
      stateHash,
    };
  });
}
