import crypto from "node:crypto";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserDownload,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
  browserWaitForDownload,
} from "../../browser/client-actions.js";
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserStart,
  browserStatus,
  browserStop,
  BROWSER_EXISTING_SESSION_ATTACH_TIMEOUT_MS,
} from "../../browser/client.js";
import { resolveBrowserConfig, resolveProfile } from "../../browser/config.js";
import { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "../../browser/paths.js";
import { getBrowserProfileCapabilities } from "../../browser/profile-capabilities.js";
import { applyBrowserProxyPaths, persistBrowserProxyFiles } from "../../browser/proxy-files.js";
import {
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "../../browser/session-tab-registry.js";
import { loadConfig } from "../../config/config.js";
import { resolveConfigPath } from "../../config/paths.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { displayPath } from "../../utils.js";
import { executeBrowserContractAction } from "./browser-contracts.js";
import {
  executeActAction,
  executeConsoleAction,
  executeSnapshotAction,
  executeTabsAction,
} from "./browser-tool.actions.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import {
  listNodes,
  resolveNodeIdFromList,
  selectDefaultNodeFromList,
  type NodeListNode,
} from "./nodes-utils.js";

const rememberedBrowserProfilesBySession = new Map<string, string>();
const browserFallbackStateBySession = new Map<
  string,
  { failedProfile: string; failedAt: number; openclawApprovedAt?: number }
>();
const BROWSER_FALLBACK_APPROVAL_WINDOW_MS = 30 * 60 * 1000;
const GLOBAL_BROWSER_SESSION_KEY = "__global__";

function normalizeBrowserSessionKey(raw?: string): string | undefined {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function normalizeRememberedProfile(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function shouldUseRememberedProfile(action: string): boolean {
  // `profiles` is intentionally lane-agnostic because it reports control-server state
  // rather than acting within the current session's browser lane.
  return action !== "profiles";
}

function shouldEnforceBrowserFallbackApproval(action: string): boolean {
  // Listing profiles is a diagnostic action. Keep it available after a lane
  // failure so the model can inspect configured recovery options before asking
  // the user to approve a clean-browser fallback.
  return action !== "profiles";
}

function resolveEffectiveBrowserProfile(params: {
  action: string;
  explicitProfile?: string;
  agentSessionKey?: string;
}): string | undefined {
  const explicitProfile = resolveBrowserProfileAlias(
    normalizeRememberedProfile(params.explicitProfile),
  );
  if (!shouldUseRememberedProfile(params.action)) {
    return explicitProfile;
  }
  const sessionKey = normalizeBrowserSessionKey(params.agentSessionKey);
  if (explicitProfile) {
    return explicitProfile;
  }
  if (!sessionKey) {
    return undefined;
  }
  return resolveBrowserProfileAlias(rememberedBrowserProfilesBySession.get(sessionKey));
}

function rememberExplicitBrowserProfile(params: {
  action: string;
  explicitProfile?: string;
  agentSessionKey?: string;
}): void {
  if (!shouldUseRememberedProfile(params.action)) {
    return;
  }
  const sessionKey = normalizeBrowserSessionKey(params.agentSessionKey);
  if (!sessionKey) {
    return;
  }
  const explicitProfile = resolveBrowserProfileAlias(
    normalizeRememberedProfile(params.explicitProfile),
  );
  if (explicitProfile) {
    rememberedBrowserProfilesBySession.set(sessionKey, explicitProfile);
  }
}

export function __resetRememberedBrowserProfilesForTests(): void {
  rememberedBrowserProfilesBySession.clear();
  browserFallbackStateBySession.clear();
}

function resolveBrowserSessionStateKey(raw?: string): string {
  return normalizeBrowserSessionKey(raw) ?? GLOBAL_BROWSER_SESSION_KEY;
}

function resolveConfiguredBrowserProfile(profileName?: string): string | undefined {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalized = normalizeRememberedProfile(profileName);
  if (normalized) {
    return resolveProfile(resolved, normalized)?.name ?? normalized;
  }
  return resolved.defaultProfile;
}

function isFallbackApprovalFresh(state: { openclawApprovedAt?: number }, nowMs: number): boolean {
  return (
    typeof state.openclawApprovedAt === "number" &&
    nowMs - state.openclawApprovedAt <= BROWSER_FALLBACK_APPROVAL_WINDOW_MS
  );
}

function isBrowserFallbackFailureFresh(state: { failedAt: number }, nowMs: number): boolean {
  return nowMs - state.failedAt <= BROWSER_FALLBACK_APPROVAL_WINDOW_MS;
}

function isCleanOpenClawProfile(profileName?: string): boolean {
  return resolveConfiguredBrowserProfile(profileName) === "openclaw";
}

function shouldRecordFallbackSourceFailure(profileName?: string): boolean {
  const actualProfile = resolveConfiguredBrowserProfile(profileName);
  if (!actualProfile || actualProfile === "openclaw") {
    return false;
  }
  return Boolean(shouldPreferHostForProfile(actualProfile));
}

function noteBrowserProfileFailure(params: {
  profile?: string;
  agentSessionKey?: string;
  action: string;
}): void {
  // Remember only failures from stateful user/session browser lanes. A later
  // clean-browser call in the same conversation is then forced through an
  // explicit approval path instead of becoming a silent downgrade.
  if (params.action === "profiles" || !shouldRecordFallbackSourceFailure(params.profile)) {
    return;
  }
  const failedProfile = resolveConfiguredBrowserProfile(params.profile);
  if (!failedProfile) {
    return;
  }
  browserFallbackStateBySession.set(resolveBrowserSessionStateKey(params.agentSessionKey), {
    failedProfile,
    failedAt: Date.now(),
  });
}

function noteBrowserStatusAvailabilityFailure(params: {
  status: unknown;
  profile?: string;
  agentSessionKey?: string;
}): void {
  const availabilityError =
    params.status && typeof params.status === "object"
      ? (params.status as { availabilityError?: unknown }).availabilityError
      : undefined;
  if (typeof availabilityError !== "string" || !availabilityError.trim()) {
    return;
  }
  noteBrowserProfileFailure({
    profile: params.profile,
    agentSessionKey: params.agentSessionKey,
    action: "status",
  });
}

function enforceBrowserFallbackApproval(params: {
  profile?: string;
  fallbackApproved: boolean;
  agentSessionKey?: string;
}): void {
  if (!isCleanOpenClawProfile(params.profile)) {
    return;
  }
  const sessionKey = resolveBrowserSessionStateKey(params.agentSessionKey);
  const state = browserFallbackStateBySession.get(sessionKey);
  if (!state) {
    return;
  }
  const nowMs = Date.now();
  if (!isBrowserFallbackFailureFresh(state, nowMs)) {
    browserFallbackStateBySession.delete(sessionKey);
    return;
  }
  if (params.fallbackApproved) {
    browserFallbackStateBySession.set(sessionKey, {
      ...state,
      openclawApprovedAt: nowMs,
    });
    return;
  }
  if (isFallbackApprovalFresh(state, nowMs)) {
    return;
  }
  throw new Error(
    `Browser fallback requires explicit user approval: profile "${state.failedProfile}" failed recently, and profile "openclaw" is a clean isolated browser without the signed-in/cloned session. Ask whether to keep repairing "${state.failedProfile}" or use "openclaw" for this task. If the user approves, retry this browser call with fallbackApproved=true.`,
  );
}

function resolveBrowserProfileAlias(profileName?: string): string | undefined {
  const normalized = normalizeRememberedProfile(profileName);
  if (!normalized) {
    return normalized;
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const resolvedProfile = resolveProfile(resolved, normalized);
  if (resolvedProfile) {
    return resolvedProfile.name;
  }

  const lower = normalized.toLowerCase();
  // Keep prompt-level shorthands stable so the model can say "clone" or
  // "signedin" without having to memorize exact config ids.
  if (lower === "signedin" || lower === "signed-in-clone" || lower === "clone") {
    const signedInProfile = resolveProfile(resolved, "signed-in");
    if (signedInProfile) {
      return signedInProfile.name;
    }
  }
  // Models still sometimes ask for `profile="chrome"` when they mean the
  // user's live Chrome session. Prefer the explicit live lane, but keep a
  // custom profile named `chrome` working if the user configured one.
  if (lower === "chrome" || lower === "chrome-live") {
    const liveProfile = resolveProfile(resolved, "user-live");
    if (liveProfile) {
      return liveProfile.name;
    }
  }

  return normalized;
}

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : undefined;
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  return (
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" })
  );
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
  "targetId",
  "ref",
  "inputRef",
  "element",
  "includeSnapshot",
  "snapshotFormat",
  "refs",
  "mode",
  "compact",
  "depth",
  "maxChars",
  "labels",
  "doubleClick",
  "dblClick",
  "button",
  "modifiers",
  "text",
  "submit",
  "slowly",
  "repairEdit",
  "clear",
  "key",
  "delayMs",
  "startRef",
  "endRef",
  "values",
  "optionText",
  "query",
  "match",
  "fields",
  "width",
  "height",
  "timeMs",
  "textGone",
  "selector",
  "url",
  "loadState",
  "fn",
  "actions",
  "stopOnError",
  "timeoutMs",
  "timeout",
] as const;

function normalizeActRequestAliases(
  request: Parameters<typeof browserAct>[1],
): Parameters<typeof browserAct>[1] {
  const normalized = { ...(request as Record<string, unknown>) };
  if (
    typeof normalized.timeoutMs !== "number" &&
    typeof normalized.timeout === "number" &&
    Number.isFinite(normalized.timeout)
  ) {
    normalized.timeoutMs = normalized.timeout;
  }
  delete normalized.timeout;

  if (typeof normalized.doubleClick !== "boolean" && typeof normalized.dblClick === "boolean") {
    normalized.doubleClick = normalized.dblClick;
  }
  delete normalized.dblClick;

  if (Array.isArray(normalized.actions)) {
    normalized.actions = normalized.actions.map((action) =>
      action && typeof action === "object"
        ? normalizeActRequestAliases(action as Parameters<typeof browserAct>[1])
        : action,
    );
  }

  return normalized as Parameters<typeof browserAct>[1];
}

function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  if (requestParam && typeof requestParam === "object") {
    return normalizeActRequestAliases(requestParam as Parameters<typeof browserAct>[1]);
  }

  const kind = readStringParam(params, "kind");
  if (!kind) {
    return undefined;
  }

  const request: Record<string, unknown> = { kind };
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    request[key] = params[key];
  }
  return normalizeActRequestAliases(request as Parameters<typeof browserAct>[1]);
}

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 45_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 10_000;
const BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS = 45_000;
const BROWSER_TOOL_EXISTING_SESSION_ATTACH_TIMEOUT_MS = BROWSER_EXISTING_SESSION_ATTACH_TIMEOUT_MS;

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
};

function isBrowserNode(node: NodeListNode) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null> {
  const cfg = loadConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }
  if (params.target && params.target !== "node") {
    return null;
  }
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const nodes = await listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
    const node = browserNodes.find((entry) => entry.nodeId === nodeId);
    return { nodeId, label: node?.displayName ?? node?.remoteIp ?? nodeId };
  }

  const selected = selectDefaultNodeFromList(browserNodes, {
    preferLocalMac: false,
    fallback: "none",
  });

  if (params.target === "node") {
    if (selected) {
      return {
        nodeId: selected.nodeId,
        label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
      };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") {
    return null;
  }

  if (selected) {
    return {
      nodeId: selected.nodeId,
      label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
    };
  }
  return null;
}

async function callBrowserProxy(params: {
  nodeId: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserProxyResult> {
  const proxyTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const gatewayTimeoutMs = proxyTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
  const payload = await callGatewayTool<{ payloadJSON?: string; payload?: string }>(
    "node.invoke",
    { timeoutMs: gatewayTimeoutMs },
    {
      nodeId: params.nodeId,
      command: "browser.proxy",
      params: {
        method: params.method,
        path: params.path,
        query: params.query,
        body: params.body,
        timeoutMs: proxyTimeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      `Browser control is disabled. Set browser.enabled=true in active config (${displayPath(resolveConfigPath())}).`,
    );
  }
  return undefined;
}

function shouldPreferHostForProfile(profileName: string | undefined) {
  if (!profileName) {
    return false;
  }
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profile = resolveProfile(resolved, profileName);
  if (!profile) {
    return false;
  }
  const capabilities = getBrowserProfileCapabilities(profile);
  return capabilities.usesChromeMcp || profile.cloneFromUserProfile;
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/download/actions).",
      'Browser choice: default serious web work to profile="signed-in"; it launches a cloned signed-in Chrome profile and controls it through Chrome DevTools MCP.',
      'Use profile="openclaw" for clean public browsing and isolated research. For logged-in, hostile, social posting, or account-bound flows, treat profile="openclaw" as a last-resort fallback only after profile="signed-in" and any explicitly required profile="user-live" lane are unavailable or proven unsuitable, and only when session state does not matter.',
      'Use profile="user-live" only when the task explicitly depends on the user\'s real live browser session, existing tabs, logged-in state, or installed extensions.',
      'Legacy profile="user" aliases to profile="signed-in" unless the operator configured a custom profile literally named "user".',
      'Do not silently fall back to profile="openclaw" after profile="signed-in" or profile="user-live" fails. Ask the user whether to keep repairing the signed-in/live lane or use clean OpenClaw; if the user approves clean OpenClaw, retry with fallbackApproved=true.',
      'profile="user-live" attaches to the user\'s real Chrome session through Chrome DevTools MCP and is host-only.',
      'If profile="user-live" fails to attach, first try the official Chrome live-session recovery path: keep normal Google Chrome running, open chrome://inspect/#remote-debugging in that same browser, enable remote debugging, accept the attach prompt if Chrome shows one, then retry before escalating.',
      'Do not send act kind="batch" or unsupported MCP launch args for profile="signed-in", profile="user-live", or other existing-session profiles; send individual actions sequentially.',
      'For existing-session profiles, use ref from the latest snapshot for element actions. Avoid slowly=true; the host bridge normalizes it to regular fill behavior. Avoid loadState="networkidle"; use loadState="load", URL/text waits, or a short timeMs wait. Do not assume dialog or scrollIntoView timeoutMs changes behavior; harmless timeout fields are normalized when present.',
      "If an existing-session action reports a stale Element uid or missing snapshot after retry, immediately take a fresh snapshot on the same targetId and retry with the new ref.",
      "If multiple Chrome profiles may exist, pin the signed-in lane with sourceProfileName or use a named custom existing-session profile instead of guessing.",
      "Custom profiles can still target Brave, Edge, Chromium, non-default Chrome profiles, or legacy/fallback flows when the default lanes are insufficient.",
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc).",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "Use snapshot+act for UI automation. After every mutating act in a multi-step browser flow (click/type/paste/fill/press/select/chooseOption), set includeSnapshot=true unless the next step is terminal; this returns the action result plus a fresh structured aria-ref snapshot, usually faster and safer than a separate snapshot call.",
      'For third-party external mutations such as posting, sending, publishing, checkout, account changes, or deleting remote data, call action="contract" with the current url and intent before the final commit; if a site contract exists, follow it, otherwise follow the generic external-mutation contract.',
      'For rich editors, social composers, and media posts, prefer act kind="paste" over kind="fill" for final composer text entry, then never treat visible composer/form state, an enabled button, a closed modal, or a successful click as proof; after the external commit, verify the final artifact itself contains the expected text/media/target before reporting success.',
      "For forms, prefer one act kind=fill request with fields[] from snapshot refs over many separate type calls; each field should use value, though text is accepted as a value alias.",
      'For Ant Design/searchable select/combobox/listbox controls, use act kind="chooseOption" with the wrapper/input ref or selector plus optionText. optionText is the semantic target to verify; query only filters the search input. It opens the control, fills the inner search input, waits for portal/listbox options, clicks the matching optionText, and can return includeSnapshot=true.',
      'For searchable dropdowns, first use query to filter, then match optionText against the actual visible option label; if the user wording fails, use the fresh snapshot/options and retry with the visible label or a stable unique visible substring like "DPS", not a guessed human shorthand like "Denpasar".',
      'Use act kind="select" only for native <select> controls. Do not hand-roll dynamic CSS/evaluate for custom listboxes unless chooseOption and normal refs have already failed.',
      'Use act kind="evaluate" only for inspection or recovery after normal browser actions fail; it is not the default automation path.',
      "Never click payment, Pay Now, final booking, final purchase, or any charge-confirming control without explicit user confirmation.",
      "Do not use exec/curl for browser checkout navigation unless the user explicitly asks; browser pages must be controlled through browser actions.",
      'For browser-initiated file saves, use action="download" with a snapshot ref and output path, or action="waitDownload" for an already-triggered download. Only use GUI save-dialog automation if browser download reports unsupported or native-save-dialog required; endpoint discovery/curl is the last resort.',
      "Prefer ref from snapshot over selector. Use screenshot only when pixels are explicitly needed; structured snapshots are faster and more reliable for automation.",
      "Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      `target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
      hostHint,
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const explicitProfile = readStringParam(params, "profile");
      const profile = resolveEffectiveBrowserProfile({
        action,
        explicitProfile,
        agentSessionKey: opts?.agentSessionKey,
      });
      if (shouldEnforceBrowserFallbackApproval(action)) {
        enforceBrowserFallbackApproval({
          profile,
          fallbackApproved: readBooleanParam(params, "fallbackApproved") ?? false,
          agentSessionKey: opts?.agentSessionKey,
        });
      }
      // Remember explicit lane choices only after policy gates accept them. In
      // particular, a rejected clean-browser fallback must not overwrite the
      // previous signed-in/live lane the agent may still need to repair.
      rememberExplicitBrowserProfile({
        action,
        explicitProfile,
        agentSessionKey: opts?.agentSessionKey,
      });
      const requestedNode = readStringParam(params, "node");
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }
      // Live-session and cloned-session host profiles rely on the operator's
      // local browser state. Sandbox/node routing would detach from that state,
      // so keep those lanes anchored to the host.
      const isUserBrowserProfile = shouldPreferHostForProfile(profile);
      if (isUserBrowserProfile) {
        if (requestedNode || target === "node") {
          throw new Error(`profile="${profile}" only supports the local host browser.`);
        }
        if (target === "sandbox") {
          throw new Error(
            `profile="${profile}" cannot use the sandbox browser; use target="host" or omit target.`,
          );
        }
        if (!target && !requestedNode) {
          target = "host";
        }
      }

      const nodeTarget = await resolveBrowserNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });

      const resolvedTarget = target === "node" ? undefined : target;
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: resolvedTarget,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      let browserBackendAttempted = false;
      const proxyRequest = nodeTarget
        ? async (opts: {
            method: string;
            path: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            timeoutMs?: number;
            profile?: string;
          }) => {
            browserBackendAttempted = true;
            const proxy = await callBrowserProxy({
              nodeId: nodeTarget.nodeId,
              method: opts.method,
              path: opts.path,
              query: opts.query,
              body: opts.body,
              timeoutMs: opts.timeoutMs,
              profile: opts.profile,
            });
            const mapping = await persistProxyFiles(proxy.files);
            applyProxyPaths(proxy.result, mapping);
            return proxy.result;
          }
        : null;

      try {
        switch (action) {
          case "status": {
            const { timeoutMs: statusTimeoutMs } = readOptionalTargetAndTimeout(params);
            if (proxyRequest) {
              const status = await proxyRequest({
                method: "GET",
                path: "/",
                profile,
                timeoutMs: statusTimeoutMs ?? BROWSER_TOOL_EXISTING_SESSION_ATTACH_TIMEOUT_MS,
              });
              noteBrowserStatusAvailabilityFailure({
                status,
                profile,
                agentSessionKey: opts?.agentSessionKey,
              });
              return jsonResult(status);
            }
            browserBackendAttempted = true;
            const status = await browserStatus(baseUrl, {
              profile,
              timeoutMs: statusTimeoutMs ?? BROWSER_TOOL_EXISTING_SESSION_ATTACH_TIMEOUT_MS,
            });
            noteBrowserStatusAvailabilityFailure({
              status,
              profile,
              agentSessionKey: opts?.agentSessionKey,
            });
            return jsonResult(status);
          }
          case "start": {
            const { timeoutMs: startTimeoutMs } = readOptionalTargetAndTimeout(params);
            if (proxyRequest) {
              await proxyRequest({
                method: "POST",
                path: "/start",
                profile,
                timeoutMs: startTimeoutMs ?? BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS,
              });
              return jsonResult(
                await proxyRequest({
                  method: "GET",
                  path: "/",
                  profile,
                  timeoutMs: startTimeoutMs ?? BROWSER_TOOL_EXISTING_SESSION_ATTACH_TIMEOUT_MS,
                }),
              );
            }
            browserBackendAttempted = true;
            await browserStart(baseUrl, {
              profile,
              timeoutMs: startTimeoutMs ?? BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS,
            });
            return jsonResult(
              await browserStatus(baseUrl, {
                profile,
                timeoutMs: startTimeoutMs ?? BROWSER_TOOL_EXISTING_SESSION_ATTACH_TIMEOUT_MS,
              }),
            );
          }
          case "stop":
            if (proxyRequest) {
              await proxyRequest({
                method: "POST",
                path: "/stop",
                profile,
              });
              return jsonResult(
                await proxyRequest({
                  method: "GET",
                  path: "/",
                  profile,
                }),
              );
            }
            browserBackendAttempted = true;
            await browserStop(baseUrl, { profile });
            return jsonResult(await browserStatus(baseUrl, { profile }));
          case "profiles":
            if (proxyRequest) {
              const result = await proxyRequest({
                method: "GET",
                path: "/profiles",
              });
              return jsonResult(result);
            }
            return jsonResult({ profiles: await browserProfiles(baseUrl) });
          case "tabs":
            browserBackendAttempted = true;
            return await executeTabsAction({ baseUrl, profile, proxyRequest });
          case "open": {
            const targetUrl = readTargetUrlParam(params);
            const { timeoutMs } = readOptionalTargetAndTimeout(params);
            const effectiveTimeoutMs =
              profile === "user-live"
                ? Math.max(timeoutMs ?? 0, BROWSER_TOOL_EXISTING_SESSION_ATTACH_TIMEOUT_MS)
                : timeoutMs;
            if (proxyRequest) {
              const result = await proxyRequest({
                method: "POST",
                path: "/tabs/open",
                profile,
                body: { url: targetUrl },
                timeoutMs: effectiveTimeoutMs ?? BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS,
              });
              return jsonResult(result);
            }
            browserBackendAttempted = true;
            const opened = await browserOpenTab(baseUrl, targetUrl, {
              profile,
              timeoutMs: effectiveTimeoutMs,
            });
            trackSessionBrowserTab({
              sessionKey: opts?.agentSessionKey,
              targetId: opened.targetId,
              baseUrl,
              profile,
            });
            return jsonResult(opened);
          }
          case "focus": {
            const targetId = readStringParam(params, "targetId", {
              required: true,
            });
            if (proxyRequest) {
              const result = await proxyRequest({
                method: "POST",
                path: "/tabs/focus",
                profile,
                body: { targetId },
              });
              return jsonResult(result);
            }
            browserBackendAttempted = true;
            await browserFocusTab(baseUrl, targetId, { profile });
            return jsonResult({ ok: true });
          }
          case "close": {
            const targetId = readStringParam(params, "targetId");
            if (proxyRequest) {
              const result = targetId
                ? await proxyRequest({
                    method: "DELETE",
                    path: `/tabs/${encodeURIComponent(targetId)}`,
                    profile,
                  })
                : await proxyRequest({
                    method: "POST",
                    path: "/act",
                    profile,
                    body: { kind: "close" },
                  });
              return jsonResult(result);
            }
            if (targetId) {
              browserBackendAttempted = true;
              await browserCloseTab(baseUrl, targetId, { profile });
              untrackSessionBrowserTab({
                sessionKey: opts?.agentSessionKey,
                targetId,
                baseUrl,
                profile,
              });
            } else {
              browserBackendAttempted = true;
              await browserAct(baseUrl, { kind: "close" }, { profile });
            }
            return jsonResult({ ok: true });
          }
          case "snapshot":
            browserBackendAttempted = true;
            return await executeSnapshotAction({
              input: params,
              baseUrl,
              profile,
              proxyRequest,
            });
          case "screenshot": {
            const targetId = readStringParam(params, "targetId");
            const fullPage = readBooleanParam(params, "fullPage") ?? false;
            const ref = readStringParam(params, "ref");
            const element = readStringParam(params, "element");
            const type = params.type === "jpeg" ? "jpeg" : "png";
            browserBackendAttempted = true;
            const result = proxyRequest
              ? ((await proxyRequest({
                  method: "POST",
                  path: "/screenshot",
                  profile,
                  body: {
                    targetId,
                    fullPage,
                    ref,
                    element,
                    type,
                  },
                })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
              : await browserScreenshotAction(baseUrl, {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                  profile,
                });
            return await imageResultFromFile({
              label: "browser:screenshot",
              path: result.path,
              details: result,
            });
          }
          case "navigate": {
            const targetUrl = readTargetUrlParam(params);
            const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
            if (proxyRequest) {
              const result = await proxyRequest({
                method: "POST",
                path: "/navigate",
                profile,
                body: {
                  url: targetUrl,
                  targetId,
                },
                timeoutMs: timeoutMs ?? BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS,
              });
              return jsonResult(result);
            }
            browserBackendAttempted = true;
            return jsonResult(
              await browserNavigate(baseUrl, {
                url: targetUrl,
                targetId,
                profile,
                timeoutMs,
              }),
            );
          }
          case "download": {
            const ref = readStringParam(params, "ref", { required: true });
            const path = readStringParam(params, "path", { required: true });
            const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
            browserBackendAttempted = true;
            const result = proxyRequest
              ? ((await proxyRequest({
                  method: "POST",
                  path: "/download",
                  profile,
                  body: {
                    ref,
                    path,
                    targetId,
                    timeoutMs,
                  },
                  timeoutMs: timeoutMs ?? BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS,
                })) as Awaited<ReturnType<typeof browserDownload>>)
              : await browserDownload(baseUrl, {
                  ref,
                  path,
                  targetId,
                  timeoutMs,
                  profile,
                });
            return {
              content: [{ type: "text" as const, text: `FILE:${result.download.path}` }],
              details: result,
            };
          }
          case "waitDownload": {
            const path = readStringParam(params, "path");
            const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
            browserBackendAttempted = true;
            const result = proxyRequest
              ? ((await proxyRequest({
                  method: "POST",
                  path: "/wait/download",
                  profile,
                  body: {
                    path,
                    targetId,
                    timeoutMs,
                  },
                  timeoutMs: timeoutMs ?? BROWSER_TOOL_HEAVY_OP_TIMEOUT_MS,
                })) as Awaited<ReturnType<typeof browserWaitForDownload>>)
              : await browserWaitForDownload(baseUrl, {
                  path,
                  targetId,
                  timeoutMs,
                  profile,
                });
            return {
              content: [{ type: "text" as const, text: `FILE:${result.download.path}` }],
              details: result,
            };
          }
          case "console":
            browserBackendAttempted = true;
            return await executeConsoleAction({
              input: params,
              baseUrl,
              profile,
              proxyRequest,
            });
          case "contract": {
            const contractUrl =
              readStringParam(params, "targetUrl") ?? readStringParam(params, "url");
            const intent = readStringParam(params, "intent");
            return executeBrowserContractAction({
              url: contractUrl,
              intent,
            });
          }
          case "pdf": {
            const targetId =
              typeof params.targetId === "string" ? params.targetId.trim() : undefined;
            browserBackendAttempted = true;
            const result = proxyRequest
              ? ((await proxyRequest({
                  method: "POST",
                  path: "/pdf",
                  profile,
                  body: { targetId },
                })) as Awaited<ReturnType<typeof browserPdfSave>>)
              : await browserPdfSave(baseUrl, { targetId, profile });
            return {
              content: [{ type: "text" as const, text: `FILE:${result.path}` }],
              details: result,
            };
          }
          case "upload": {
            const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
            if (paths.length === 0) {
              throw new Error("paths required");
            }
            const uploadPathsResult = await resolveExistingPathsWithinRoot({
              rootDir: DEFAULT_UPLOAD_DIR,
              requestedPaths: paths,
              scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
            });
            if (!uploadPathsResult.ok) {
              throw new Error(uploadPathsResult.error);
            }
            const normalizedPaths = uploadPathsResult.paths;
            const ref = readStringParam(params, "ref");
            const inputRef = readStringParam(params, "inputRef");
            const element = readStringParam(params, "element");
            const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
            if (proxyRequest) {
              const result = await proxyRequest({
                method: "POST",
                path: "/hooks/file-chooser",
                profile,
                body: {
                  paths: normalizedPaths,
                  ref,
                  inputRef,
                  element,
                  targetId,
                  timeoutMs,
                },
              });
              return jsonResult(result);
            }
            browserBackendAttempted = true;
            return jsonResult(
              await browserArmFileChooser(baseUrl, {
                paths: normalizedPaths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
                profile,
              }),
            );
          }
          case "dialog": {
            const accept = readBooleanParam(params, "accept") ?? false;
            const promptText =
              typeof params.promptText === "string" ? params.promptText : undefined;
            const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
            browserBackendAttempted = true;
            if (proxyRequest) {
              const result = await proxyRequest({
                method: "POST",
                path: "/hooks/dialog",
                profile,
                body: {
                  accept,
                  promptText,
                  targetId,
                  timeoutMs,
                },
              });
              return jsonResult(result);
            }
            return jsonResult(
              await browserArmDialog(baseUrl, {
                accept,
                promptText,
                targetId,
                timeoutMs,
                profile,
              }),
            );
          }
          case "act": {
            const request = readActRequestParam(params);
            if (!request) {
              throw new Error("request required");
            }
            return await executeActAction({
              request,
              baseUrl,
              profile,
              proxyRequest,
              onBrowserBackendAttempt: () => {
                browserBackendAttempted = true;
              },
            });
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (err) {
        if (browserBackendAttempted) {
          noteBrowserProfileFailure({
            profile,
            agentSessionKey: opts?.agentSessionKey,
            action,
          });
        }
        throw err;
      }
    },
  };
}
