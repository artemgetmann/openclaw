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

type BrowserPageProbe = {
  allowed: boolean;
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
  }) => Promise<unknown>;
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
    throw new Error(`Browser reply observer requires ${name}.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`Browser reply observer ${name} exceeds ${maxLength} characters.`);
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
    throw new Error(
      "Browser reply observer --url-pattern must be an absolute HTTP(S) URL with wildcards only after the origin.",
    );
  }
  // URL parsing validates the fixed origin without interpreting path globs.
  const parsedOrigin = new URL(`${originMatch[1]}://${originMatch[2]}`);
  if (!parsedOrigin.hostname || parsedOrigin.username || parsedOrigin.password) {
    throw new Error("Browser reply observer --url-pattern must use a credential-free URL origin.");
  }
  return new RegExp(`^${globPatternToRegexSource(pattern)}$`);
}

export function resolveLocalBrowserMonitorHookUrl(rawHookUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawHookUrl);
  } catch (err) {
    throw new Error(`Browser reply observer requires a valid --hook-url: ${String(err)}`, {
      cause: err,
    });
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !loopbackHosts.has(url.hostname) ||
    !normalizedPath.endsWith("/monitor-event")
  ) {
    throw new Error(
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
    throw new Error("Browser reply observer --match-mode must be exact or contains.");
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
        const node = document.querySelector(${JSON.stringify(config.selector)});
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
}): Promise<unknown> {
  const response = await fetch(params.hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(params.hookToken ? { Authorization: `Bearer ${params.hookToken}` } : {}),
    },
    body: JSON.stringify({ ...params.event, monitorId: params.monitorId }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`browser reply monitor hook returned HTTP ${response.status}: ${body}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
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
  const matched = probe.found && matchesRule(probe.text, config.matchMode, config.matchValue);
  if (!matched) {
    return {
      cursorStorePath,
      dispatched: false,
      found: probe.found,
      matched: false,
      stateChanged: false,
    };
  }

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
  const stateHash = hash(`${ruleHash}\u0000${probe.text}`);
  const cursorKey = `monitor:${config.monitorId}:${ruleHash}`;
  return await withBrowserReplyCursorStoreLock(cursorStorePath, async () => {
    const cursorStore = await loadBrowserReplyCursorStore(cursorStorePath);
    if (cursorStore.cursors[cursorKey]?.lastStateHash === stateHash) {
      return {
        cursorStorePath,
        dispatched: false,
        found: true,
        matched: true,
        stateChanged: false,
        stateHash,
      };
    }

    const receivedAtMs = deps.nowMs ?? Date.now();
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
      idempotencyKey: `browser:${stateHash}`,
      receivedAtMs,
      evidence: {
        found: true,
        matchMode: config.matchMode,
        observedTextHash: hash(probe.text),
        ruleHash,
      },
    };
    const dispatch = await (deps.dispatchEvent ?? postBrowserMonitorEvent)({
      event,
      hookToken: config.hookToken,
      hookUrl: config.hookUrl,
      monitorId: config.monitorId,
    });
    if (!dispatchConfirmedWake(dispatch, config.monitorId)) {
      throw new Error(
        "Browser reply observer dispatch did not confirm a monitor wake; cursor unchanged.",
      );
    }

    cursorStore.cursors[cursorKey] = {
      lastStateHash: stateHash,
      ruleHash,
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
