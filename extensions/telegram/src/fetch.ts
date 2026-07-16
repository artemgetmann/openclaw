import * as dns from "node:dns";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import type { TelegramNetworkConfig } from "../../../src/config/types.telegram.js";
import { formatErrorMessage } from "../../../src/infra/errors.js";
import { resolveFetch } from "../../../src/infra/fetch.js";
import { hasEnvHttpProxyConfigured } from "../../../src/infra/net/proxy-env.js";
import type { PinnedDispatcherPolicy } from "../../../src/infra/net/ssrf.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision,
} from "./network-config.js";
import { getProxyUrlFromFetch } from "./proxy.js";

const log = createSubsystemLogger("telegram/network");

const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const TELEGRAM_STICKY_FALLBACK_PRIMARY_PROBE_SUCCESS_THRESHOLD = 5;
const TELEGRAM_TRANSPORT_ATTEMPT_FAILURE_THRESHOLD = 5;
const TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS = 10_000;
const TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS = 60_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

type TelegramDispatcher = Agent | EnvHttpProxyAgent | ProxyAgent;

type TelegramDispatcherMode = "direct" | "env-proxy" | "explicit-proxy";

export type TelegramTransportPhase = "primary" | "ipv4-fallback";

type TelegramTransportAttempt = {
  phase: TelegramTransportPhase;
  createDispatcher: () => TelegramDispatcher;
  dispatcherPolicy: PinnedDispatcherPolicy;
};

type TelegramTransportAttemptHealth = {
  consecutiveFailures: number;
  cooldownMs: number;
  unhealthyUntilMs: number;
};

type TelegramTransportLearnedState = {
  stickyAttemptIndex: number;
  stickySuccessCount: number;
  primaryProbeDue: boolean;
  attemptHealth: TelegramTransportAttemptHealth[];
};

// Only transport decisions live across bot/probe generations. Dispatcher objects remain
// resolver-owned so closing one bot cannot destroy sockets still used by another resolver.
const telegramTransportLearnedState = new Map<string, TelegramTransportLearnedState>();

type TelegramDnsResultOrder = "ipv4first" | "verbatim";

type LookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void);

type LookupOptions = (dns.LookupOneOptions | dns.LookupAllOptions) & {
  order?: TelegramDnsResultOrder;
  verbatim?: boolean;
};

type LookupFunction = (
  hostname: string,
  options: number | dns.LookupOneOptions | dns.LookupAllOptions | undefined,
  callback: LookupCallback,
) => void;

const FALLBACK_RETRY_ERROR_CODES = [
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

type Ipv4FallbackCandidate = {
  message: string;
  codes: Set<string>;
};

type Ipv4FallbackRule = {
  name: string;
  matches: (ctx: Ipv4FallbackCandidate) => boolean;
};

const IPV4_FALLBACK_RULES: readonly Ipv4FallbackRule[] = [
  {
    name: "fetch-failed-envelope",
    matches: ({ message }) => message.includes("fetch failed"),
  },
  {
    name: "known-network-code",
    matches: ({ codes }) => FALLBACK_RETRY_ERROR_CODES.some((code) => codes.has(code)),
  },
];

function normalizeDnsResultOrder(value: string | null): TelegramDnsResultOrder | null {
  if (value === "ipv4first" || value === "verbatim") {
    return value;
  }
  return null;
}

function createDnsResultOrderLookup(
  order: TelegramDnsResultOrder | null,
): LookupFunction | undefined {
  if (!order) {
    return undefined;
  }
  const lookup = dns.lookup as unknown as (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => void;
  return (hostname, options, callback) => {
    const baseOptions: LookupOptions =
      typeof options === "number"
        ? { family: options }
        : options
          ? { ...(options as LookupOptions) }
          : {};
    const lookupOptions: LookupOptions = {
      ...baseOptions,
      order,
      // Keep `verbatim` for compatibility with Node runtimes that ignore `order`.
      verbatim: order === "verbatim",
    };
    lookup(hostname, lookupOptions, callback);
  };
}

function buildTelegramConnectOptions(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  forceIpv4: boolean;
}): {
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  family?: number;
  lookup?: LookupFunction;
} | null {
  const connect: {
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
    family?: number;
    lookup?: LookupFunction;
  } = {};

  if (params.forceIpv4) {
    connect.family = 4;
    connect.autoSelectFamily = false;
  } else if (typeof params.autoSelectFamily === "boolean") {
    connect.autoSelectFamily = params.autoSelectFamily;
    connect.autoSelectFamilyAttemptTimeout = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS;
  }

  const lookup = createDnsResultOrderLookup(params.dnsResultOrder);
  if (lookup) {
    connect.lookup = lookup;
  }

  return Object.keys(connect).length > 0 ? connect : null;
}

function shouldBypassEnvProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  // We need this classification before dispatch to decide whether sticky IPv4 fallback
  // can safely arm. EnvHttpProxyAgent does not expose route decisions (proxy vs direct
  // NO_PROXY bypass), so we mirror undici's parsing/matching behavior for this host.
  // Match EnvHttpProxyAgent behavior (undici):
  // - lower-case no_proxy takes precedence over NO_PROXY
  // - entries split by comma or whitespace
  // - wildcard handling is exact-string "*" only
  // - leading "." and "*." are normalized the same way
  const noProxyValue = env.no_proxy ?? env.NO_PROXY ?? "";
  if (!noProxyValue) {
    return false;
  }
  if (noProxyValue === "*") {
    return true;
  }
  const targetHostname = TELEGRAM_API_HOSTNAME.toLowerCase();
  const targetPort = 443;
  const noProxyEntries = noProxyValue.split(/[,\s]/);
  for (let i = 0; i < noProxyEntries.length; i++) {
    const entry = noProxyEntries[i];
    if (!entry) {
      continue;
    }
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHostname = (parsed ? parsed[1] : entry).replace(/^\*?\./, "").toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== targetPort) {
      continue;
    }
    if (
      targetHostname === entryHostname ||
      targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`
    ) {
      return true;
    }
  }
  return false;
}

function hasEnvHttpProxyForTelegramApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnvHttpProxyConfigured("https", env);
}

function resolveTelegramDispatcherPolicy(params: {
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  useEnvProxy: boolean;
  forceIpv4: boolean;
  proxyUrl?: string;
}): { policy: PinnedDispatcherPolicy; mode: TelegramDispatcherMode } {
  const connect = buildTelegramConnectOptions({
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    forceIpv4: params.forceIpv4,
  });
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    return {
      policy: connect
        ? {
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
            proxyTls: { ...connect },
          }
        : {
            mode: "explicit-proxy",
            proxyUrl: explicitProxyUrl,
          },
      mode: "explicit-proxy",
    };
  }
  if (params.useEnvProxy) {
    return {
      policy: {
        mode: "env-proxy",
        ...(connect ? { connect: { ...connect }, proxyTls: { ...connect } } : {}),
      },
      mode: "env-proxy",
    };
  }
  return {
    policy: {
      mode: "direct",
      ...(connect ? { connect: { ...connect } } : {}),
    },
    mode: "direct",
  };
}

function createTelegramDispatcher(policy: PinnedDispatcherPolicy): {
  dispatcher: TelegramDispatcher;
  mode: TelegramDispatcherMode;
  effectivePolicy: PinnedDispatcherPolicy;
} {
  if (policy.mode === "explicit-proxy") {
    const proxyOptions = policy.proxyTls
      ? ({
          uri: policy.proxyUrl,
          proxyTls: { ...policy.proxyTls },
        } satisfies ConstructorParameters<typeof ProxyAgent>[0])
      : policy.proxyUrl;
    try {
      return {
        dispatcher: new ProxyAgent(proxyOptions),
        mode: "explicit-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
    }
  }

  if (policy.mode === "env-proxy") {
    const proxyOptions =
      policy.connect || policy.proxyTls
        ? ({
            ...(policy.connect ? { connect: { ...policy.connect } } : {}),
            // undici's EnvHttpProxyAgent passes `connect` only to the no-proxy Agent.
            // Real proxied HTTPS traffic reads transport settings from ProxyAgent.proxyTls.
            ...(policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}),
          } satisfies ConstructorParameters<typeof EnvHttpProxyAgent>[0])
        : undefined;
    try {
      return {
        dispatcher: new EnvHttpProxyAgent(proxyOptions),
        mode: "env-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const directPolicy: PinnedDispatcherPolicy = {
        mode: "direct",
        ...(policy.connect ? { connect: { ...policy.connect } } : {}),
      };
      return {
        dispatcher: new Agent(
          directPolicy.connect
            ? ({
                connect: { ...directPolicy.connect },
              } satisfies ConstructorParameters<typeof Agent>[0])
            : undefined,
        ),
        mode: "direct",
        effectivePolicy: directPolicy,
      };
    }
  }

  return {
    dispatcher: new Agent(
      policy.connect
        ? ({
            connect: { ...policy.connect },
          } satisfies ConstructorParameters<typeof Agent>[0])
        : undefined,
    ),
    mode: "direct",
    effectivePolicy: policy,
  };
}

function withDispatcherIfMissing(
  init: RequestInit | undefined,
  dispatcher: TelegramDispatcher,
): RequestInitWithDispatcher {
  const withDispatcher = init as RequestInitWithDispatcher | undefined;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
}

function resolveWrappedFetch(fetchImpl: typeof fetch): typeof fetch {
  return resolveFetch(fetchImpl) ?? fetchImpl;
}

function logResolverNetworkDecisions(params: {
  autoSelectDecision: ReturnType<typeof resolveTelegramAutoSelectFamilyDecision>;
  dnsDecision: ReturnType<typeof resolveTelegramDnsResultOrderDecision>;
}): void {
  if (params.autoSelectDecision.value !== null) {
    const sourceLabel = params.autoSelectDecision.source
      ? ` (${params.autoSelectDecision.source})`
      : "";
    log.info(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
  }
  if (params.dnsDecision.value !== null) {
    const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
    log.info(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
  }
}

function collectErrorCodes(err: unknown): Set<string> {
  const codes = new Set<string>();
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code.trim()) {
        codes.add(code.trim().toUpperCase());
      }
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }

  return codes;
}

function collectIpv4FallbackCandidates(err: unknown): Ipv4FallbackCandidate[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: Ipv4FallbackCandidate[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push({
      message:
        current instanceof Error
          ? current.message.toLowerCase()
          : typeof current === "object" && current && "message" in current
            ? String((current as { message?: unknown }).message).toLowerCase()
            : "",
      codes: collectErrorCodes(current),
    });
    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const error = (current as { error?: unknown }).error;
      if (error && !seen.has(error)) {
        queue.push(error);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }

  return candidates;
}

function formatErrorCodes(err: unknown): string {
  const codes = [...collectErrorCodes(err)];
  return codes.length > 0 ? codes.join(",") : "none";
}

function formatTransportAttemptForLog(attempt: TelegramTransportAttemptDiagnostic): string {
  // formatErrorMessage applies the repository's token redaction. Never add the request
  // URL here: Telegram Bot API URLs embed the bot token in their path.
  return `${attempt.phase}(elapsedMs=${attempt.elapsedMs}, codes=${formatErrorCodes(attempt.error)}, error=${formatErrorMessage(attempt.error)})`;
}

function resolveTelegramApiMethod(input: RequestInfo | URL): string {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : typeof input === "object" && input !== null && "url" in input
          ? typeof input.url === "string"
            ? input.url
            : undefined
          : undefined;
  if (!rawUrl) {
    return "unknown";
  }
  try {
    const method = new URL(rawUrl).pathname.split("/").filter(Boolean).at(-1);
    // Log only the final path segment and constrain it to the Bot API method alphabet.
    // The preceding path embeds the token and must never reach diagnostics.
    return method?.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown";
  } catch {
    return "unknown";
  }
}

function resolveAttemptElapsedMs(startedAtMs: number): number {
  const elapsedMs = Date.now() - startedAtMs;
  return Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0;
}

function shouldRetryWithIpv4Fallback(err: unknown): boolean {
  const candidates = collectIpv4FallbackCandidates(err);
  return candidates.some((candidate) =>
    IPV4_FALLBACK_RULES.every((rule) => rule.matches(candidate)),
  );
}

function buildStickyIpv4FallbackCacheKey(params: {
  accountId?: string;
  autoSelectFamily: boolean | null;
  dnsResultOrder: TelegramDnsResultOrder | null;
  useEnvProxy: boolean;
  shouldBypassEnvProxy: boolean;
}): string {
  return JSON.stringify({
    accountId: sanitizeTelegramTransportAccountId(params.accountId) ?? null,
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    useEnvProxy: params.useEnvProxy,
    shouldBypassEnvProxy: params.shouldBypassEnvProxy,
  });
}

function sanitizeTelegramTransportAccountId(accountId?: string): string | undefined {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

function formatTelegramTransportContext(context?: TelegramTransportContext): string {
  const accountId = sanitizeTelegramTransportAccountId(context?.accountId);
  const generation = context?.generation;
  const fields: string[] = [];
  if (accountId) {
    fields.push(`account=${accountId}`);
  }
  if (typeof generation === "number" && Number.isFinite(generation) && generation >= 0) {
    fields.push(`generation=${Math.floor(generation)}`);
  }
  return fields.length > 0 ? ` (${fields.join(", ")})` : "";
}

function createAttemptHealth(): TelegramTransportAttemptHealth {
  return {
    consecutiveFailures: 0,
    cooldownMs: TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS,
    unhealthyUntilMs: 0,
  };
}

function resolveTelegramTransportLearnedState(cacheKey: string): TelegramTransportLearnedState {
  const existing = telegramTransportLearnedState.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created: TelegramTransportLearnedState = {
    stickyAttemptIndex: 0,
    stickySuccessCount: 0,
    primaryProbeDue: false,
    attemptHealth: [createAttemptHealth(), createAttemptHealth()],
  };
  telegramTransportLearnedState.set(cacheKey, created);
  return created;
}

function resolveBoundedExpiryMs(durationMs: number): number | undefined {
  const now = Date.now();
  const expiresAt = now + durationMs;
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(expiresAt) ||
    now < 0 ||
    expiresAt > MAX_DATE_TIMESTAMP_MS
  ) {
    return undefined;
  }
  return expiresAt;
}

function isFutureTimestampMs(timestampMs: number): boolean {
  const now = Date.now();
  return (
    Number.isFinite(now) &&
    Number.isFinite(timestampMs) &&
    timestampMs > now &&
    timestampMs <= MAX_DATE_TIMESTAMP_MS
  );
}

class TelegramTransportAttemptUnhealthyError extends Error {
  constructor(phase: TelegramTransportPhase, unhealthyUntilMs: number) {
    const remainingMs = Math.max(0, unhealthyUntilMs - Date.now());
    super(`${phase} transport attempt cooling down; retry after ${remainingMs}ms`);
    this.name = "TelegramTransportAttemptUnhealthyError";
  }
}

export type TelegramTransportAttemptDiagnostic = {
  phase: TelegramTransportPhase;
  elapsedMs: number;
  error: unknown;
};

export class TelegramTransportError extends Error {
  readonly attempts: TelegramTransportAttemptDiagnostic[];

  constructor(attempts: TelegramTransportAttemptDiagnostic[]) {
    const safeSummary = attempts.map(formatTransportAttemptForLog).join("; ");
    super(`telegram transport failed: ${safeSummary}`, {
      cause: attempts.at(-1)?.error,
    });
    this.name = "TelegramTransportError";
    // Keep the original errors for code-level diagnosis while the message remains safe
    // for logs. Callers must not stringify this object wholesale.
    this.attempts = attempts.map((attempt) => ({ ...attempt }));
  }
}

export function formatTelegramTransportErrorForLogging(err: unknown): string | null {
  if (
    !err ||
    typeof err !== "object" ||
    (err as { name?: unknown }).name !== "TelegramTransportError" ||
    !Array.isArray((err as { attempts?: unknown }).attempts)
  ) {
    return null;
  }
  const attempts = (err as { attempts: unknown[] }).attempts
    .map((attempt): TelegramTransportAttemptDiagnostic | null => {
      if (!attempt || typeof attempt !== "object") {
        return null;
      }
      const phase = (attempt as { phase?: unknown }).phase;
      if (phase !== "primary" && phase !== "ipv4-fallback") {
        return null;
      }
      const elapsedMs = (attempt as { elapsedMs?: unknown }).elapsedMs;
      return {
        phase,
        elapsedMs:
          typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
            ? Math.max(0, Math.floor(elapsedMs))
            : 0,
        error: (attempt as { error?: unknown }).error,
      };
    })
    .filter((attempt): attempt is TelegramTransportAttemptDiagnostic => attempt !== null);
  return attempts.length > 0 ? attempts.map(formatTransportAttemptForLog).join("; ") : null;
}

export function shouldRetryTelegramIpv4Fallback(err: unknown): boolean {
  return shouldRetryWithIpv4Fallback(err);
}

export function resetTelegramTransportStickyIpv4CacheForTests(): void {
  telegramTransportLearnedState.clear();
}

// Prefer wrapped fetch when available to normalize AbortSignal across runtimes.
export type TelegramTransportContext = {
  accountId?: string;
  generation?: number;
};

export type TelegramTransportOptions = {
  network?: TelegramNetworkConfig;
  context?: TelegramTransportContext;
};

export type TelegramTransport = {
  fetch: typeof fetch;
  sourceFetch: typeof fetch;
  pinnedDispatcherPolicy?: PinnedDispatcherPolicy;
  fallbackPinnedDispatcherPolicy?: PinnedDispatcherPolicy;
  /** Promote the shared learned state before the next request without reusing sockets. */
  forceFallback?: (reason: string, err?: unknown) => boolean;
  /** Destroy every dispatcher owned by this resolver exactly once. */
  close?: () => Promise<void>;
};

async function destroyOwnedDispatchers(dispatchers: Iterable<TelegramDispatcher>): Promise<void> {
  // A transport close means its requests have already been abandoned. destroy() releases
  // keep-alive sockets immediately; per-dispatcher isolation prevents one bad close from
  // suppressing cleanup of the remaining locally-owned dispatchers.
  await Promise.all(
    [...dispatchers].map(async (dispatcher) => {
      try {
        await dispatcher.destroy();
      } catch {
        // Undici may reject destruction of an already-destroyed dispatcher. The local
        // ownership set and idempotent close guard still ensure we invoke it only once.
      }
    }),
  );
}

export function resolveTelegramTransport(
  proxyFetch?: typeof fetch,
  options?: TelegramTransportOptions,
): TelegramTransport {
  const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({
    network: options?.network,
  });
  const dnsDecision = resolveTelegramDnsResultOrderDecision({
    network: options?.network,
  });
  logResolverNetworkDecisions({
    autoSelectDecision,
    dnsDecision,
  });

  const explicitProxyUrl = proxyFetch ? getProxyUrlFromFetch(proxyFetch) : undefined;
  const undiciSourceFetch = resolveWrappedFetch(undiciFetch as unknown as typeof fetch);
  const sourceFetch = explicitProxyUrl
    ? undiciSourceFetch
    : proxyFetch
      ? resolveWrappedFetch(proxyFetch)
      : undiciSourceFetch;
  const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
  // Preserve fully caller-owned custom fetch implementations.
  if (proxyFetch && !explicitProxyUrl) {
    const contextLabel = formatTelegramTransportContext(options?.context);
    log.debug(`telegram transport reuse: caller-owned fetch${contextLabel}`);
    let closed = false;
    return {
      fetch: sourceFetch,
      sourceFetch,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        log.debug(`telegram transport close: caller-owned fetch left untouched${contextLabel}`);
      },
    };
  }

  const useEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
  const defaultDispatcherResolution = resolveTelegramDispatcherPolicy({
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    useEnvProxy,
    forceIpv4: false,
    proxyUrl: explicitProxyUrl,
  });
  const defaultDispatcher = createTelegramDispatcher(defaultDispatcherResolution.policy);
  const contextLabel = formatTelegramTransportContext(options?.context);
  log.debug(`telegram transport construct: phase=primary${contextLabel}`);
  const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
  const allowStickyIpv4Fallback =
    defaultDispatcher.mode === "direct" ||
    (defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy);
  const stickyIpv4FallbackCacheKey = buildStickyIpv4FallbackCacheKey({
    accountId: options?.context?.accountId,
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    useEnvProxy,
    shouldBypassEnvProxy,
  });
  const stickyShouldUseEnvProxy = defaultDispatcher.mode === "env-proxy";
  const fallbackPinnedDispatcherPolicy = allowStickyIpv4Fallback
    ? resolveTelegramDispatcherPolicy({
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
        useEnvProxy: stickyShouldUseEnvProxy,
        forceIpv4: true,
        proxyUrl: explicitProxyUrl,
      }).policy
    : undefined;

  const learnedState = allowStickyIpv4Fallback
    ? resolveTelegramTransportLearnedState(stickyIpv4FallbackCacheKey)
    : {
        stickyAttemptIndex: 0,
        stickySuccessCount: 0,
        primaryProbeDue: false,
        attemptHealth: [createAttemptHealth(), createAttemptHealth()],
      };
  const ownedDispatchers = new Set<TelegramDispatcher>([defaultDispatcher.dispatcher]);
  let stickyIpv4Dispatcher: TelegramDispatcher | null = null;
  const resolveStickyIpv4Dispatcher = () => {
    if (!stickyIpv4Dispatcher) {
      if (!fallbackPinnedDispatcherPolicy) {
        return defaultDispatcher.dispatcher;
      }
      stickyIpv4Dispatcher = createTelegramDispatcher(fallbackPinnedDispatcherPolicy).dispatcher;
      ownedDispatchers.add(stickyIpv4Dispatcher);
      log.debug(`telegram transport construct: phase=ipv4-fallback${contextLabel}`);
    } else {
      log.debug(`telegram transport reuse: phase=ipv4-fallback${contextLabel}`);
    }
    return stickyIpv4Dispatcher;
  };

  const transportAttempts: TelegramTransportAttempt[] = [
    {
      phase: "primary",
      createDispatcher: () => {
        log.debug(`telegram transport reuse: phase=primary${contextLabel}`);
        return defaultDispatcher.dispatcher;
      },
      dispatcherPolicy: defaultDispatcher.effectivePolicy,
    },
  ];
  if (allowStickyIpv4Fallback && fallbackPinnedDispatcherPolicy) {
    transportAttempts.push({
      phase: "ipv4-fallback",
      createDispatcher: resolveStickyIpv4Dispatcher,
      dispatcherPolicy: fallbackPinnedDispatcherPolicy,
    });
  }

  const resetStickyRecoveryProbe = (): void => {
    learnedState.stickySuccessCount = 0;
    learnedState.primaryProbeDue = false;
  };

  const getAttemptCooldownError = (attemptIndex: number): Error | null => {
    const health = learnedState.attemptHealth[attemptIndex] ?? createAttemptHealth();
    learnedState.attemptHealth[attemptIndex] = health;
    if (!isFutureTimestampMs(health.unhealthyUntilMs)) {
      health.unhealthyUntilMs = 0;
      return null;
    }
    return new TelegramTransportAttemptUnhealthyError(
      transportAttempts[attemptIndex]?.phase ?? "primary",
      health.unhealthyUntilMs,
    );
  };

  const recordAttemptFailure = (attemptIndex: number, err: unknown, requestLabel: string): void => {
    const health = learnedState.attemptHealth[attemptIndex] ?? createAttemptHealth();
    learnedState.attemptHealth[attemptIndex] = health;
    health.consecutiveFailures += 1;
    if (health.consecutiveFailures < TELEGRAM_TRANSPORT_ATTEMPT_FAILURE_THRESHOLD) {
      return;
    }
    const cooldownMs = Math.min(
      TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS,
      Math.max(TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS, health.cooldownMs),
    );
    health.consecutiveFailures = 0;
    health.cooldownMs = Math.min(TELEGRAM_TRANSPORT_ATTEMPT_MAX_COOLDOWN_MS, cooldownMs * 2);
    const unhealthyUntilMs = resolveBoundedExpiryMs(cooldownMs);
    if (unhealthyUntilMs === undefined) {
      health.unhealthyUntilMs = 0;
      return;
    }
    health.unhealthyUntilMs = unhealthyUntilMs;
    log.warn(
      `telegram transport cooldown: phase=${transportAttempts[attemptIndex]?.phase ?? "primary"}, durationMs=${cooldownMs}, codes=${formatErrorCodes(err)}${requestLabel}`,
    );
  };

  const promoteStickyFallback = (reason: string, err?: unknown): boolean => {
    if (transportAttempts.length < 2 || learnedState.stickyAttemptIndex >= 1) {
      return false;
    }
    learnedState.stickyAttemptIndex = 1;
    resetStickyRecoveryProbe();
    log.warn(
      `telegram transport select: phase=ipv4-fallback, reason=${formatErrorMessage(reason)}, codes=${formatErrorCodes(err)}${contextLabel}`,
    );
    return true;
  };

  const recordSuccessfulAttempt = (attemptIndex: number, requestLabel: string): void => {
    const health = learnedState.attemptHealth[attemptIndex] ?? createAttemptHealth();
    learnedState.attemptHealth[attemptIndex] = health;
    health.consecutiveFailures = 0;
    health.cooldownMs = TELEGRAM_TRANSPORT_ATTEMPT_INITIAL_COOLDOWN_MS;
    health.unhealthyUntilMs = 0;

    if (learnedState.stickyAttemptIndex === 0) {
      resetStickyRecoveryProbe();
      return;
    }
    if (attemptIndex < learnedState.stickyAttemptIndex) {
      log.info(
        `telegram transport recovery: phase=${transportAttempts[attemptIndex]?.phase ?? "primary"}${requestLabel}`,
      );
      learnedState.stickyAttemptIndex = attemptIndex;
      resetStickyRecoveryProbe();
      return;
    }
    if (attemptIndex !== learnedState.stickyAttemptIndex) {
      return;
    }
    learnedState.stickySuccessCount += 1;
    if (
      learnedState.stickySuccessCount >= TELEGRAM_STICKY_FALLBACK_PRIMARY_PROBE_SUCCESS_THRESHOLD
    ) {
      learnedState.stickySuccessCount = 0;
      learnedState.primaryProbeDue = true;
      log.debug(`telegram transport recovery probe scheduled: phase=primary${requestLabel}`);
    }
  };

  const resolvedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestLabel = `, method=${resolveTelegramApiMethod(input)}${contextLabel}`;
    const callerProvidedDispatcher = Boolean(
      (init as RequestInitWithDispatcher | undefined)?.dispatcher,
    );
    if (callerProvidedDispatcher) {
      try {
        return await sourceFetch(input, init);
      } catch (err) {
        if (init?.signal?.aborted || !shouldRetryWithIpv4Fallback(err)) {
          throw err;
        }
        // The dispatcher is caller-owned. A retry may absorb a transient socket failure,
        // but it must keep the exact same dispatcher and never mutate shared learned state.
        return sourceFetch(input, init ?? {});
      }
    }

    const stickyStartIndex = Math.min(
      learnedState.stickyAttemptIndex,
      transportAttempts.length - 1,
    );
    const stickyCooldownError = getAttemptCooldownError(stickyStartIndex);
    const primaryProbe =
      stickyStartIndex > 0 && (learnedState.primaryProbeDue || stickyCooldownError !== null);
    const startIndex = primaryProbe ? 0 : stickyStartIndex;
    if (primaryProbe) {
      learnedState.primaryProbeDue = false;
      log.debug(
        `telegram transport recovery probe: phase=primary, reason=${stickyCooldownError ? "fallback-cooldown" : "success-threshold"}${requestLabel}`,
      );
    }

    const diagnostics: TelegramTransportAttemptDiagnostic[] = [];
    for (
      let attemptIndex = startIndex;
      attemptIndex < transportAttempts.length;
      attemptIndex += 1
    ) {
      const attempt = transportAttempts[attemptIndex];
      const cooldownError = getAttemptCooldownError(attemptIndex);
      if (cooldownError) {
        diagnostics.push({ phase: attempt.phase, elapsedMs: 0, error: cooldownError });
        log.debug(`telegram transport cooldown skip: phase=${attempt.phase}${requestLabel}`);
        continue;
      }
      log.debug(`telegram transport select: phase=${attempt.phase}${requestLabel}`);
      const attemptStartedAtMs = Date.now();
      try {
        const response = await sourceFetch(
          input,
          withDispatcherIfMissing(init, attempt.createDispatcher()),
        );
        const elapsedMs = resolveAttemptElapsedMs(attemptStartedAtMs);
        const successLine = `telegram transport success: phase=${attempt.phase}, elapsedMs=${elapsedMs}${requestLabel}`;
        if (attempt.phase === "ipv4-fallback") {
          // Selecting fallback proves only intent. Keep the successful fallback outcome
          // visible at normal incident log level so operators can distinguish recovery
          // from a fallback attempt that failed or never connected.
          log.info(successLine);
        } else {
          log.debug(successLine);
        }
        recordSuccessfulAttempt(attemptIndex, requestLabel);
        return response;
      } catch (err) {
        // Shutdown, caller cancellation, and per-request timeouts all arrive with an
        // already-aborted signal. Retrying would defeat shutdown and duplicate work.
        if (init?.signal?.aborted) {
          throw err;
        }
        const elapsedMs = resolveAttemptElapsedMs(attemptStartedAtMs);
        log.warn(
          `telegram transport failure: ${formatTransportAttemptForLog({ phase: attempt.phase, elapsedMs, error: err })}${requestLabel}`,
        );
        if (!shouldRetryWithIpv4Fallback(err)) {
          throw err;
        }
        diagnostics.push({ phase: attempt.phase, elapsedMs, error: err });
        recordAttemptFailure(attemptIndex, err, requestLabel);
        if (attemptIndex === 0) {
          promoteStickyFallback("eligible primary network failure", err);
        }
      }
    }

    if (diagnostics.length >= 2) {
      throw new TelegramTransportError(diagnostics);
    }
    throw diagnostics[0]?.error ?? new Error("telegram transport failed without an attempt");
  }) as typeof fetch;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    const toDestroy = [...ownedDispatchers];
    ownedDispatchers.clear();
    log.debug(`telegram transport close: ownedDispatchers=${toDestroy.length}${contextLabel}`);
    await destroyOwnedDispatchers(toDestroy);
  };

  return {
    fetch: resolvedFetch,
    sourceFetch,
    pinnedDispatcherPolicy: defaultDispatcher.effectivePolicy,
    fallbackPinnedDispatcherPolicy,
    forceFallback: promoteStickyFallback,
    close,
  };
}

export function resolveTelegramFetch(
  proxyFetch?: typeof fetch,
  options?: TelegramTransportOptions,
): typeof fetch {
  return resolveTelegramTransport(proxyFetch, options).fetch;
}
