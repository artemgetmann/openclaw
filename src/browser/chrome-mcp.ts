import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, type RawData } from "ws";
import { loadConfig } from "../config/config.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import { resolveGoogleChromeExecutableForPlatform } from "./chrome.executables.js";
import type { BrowserTab } from "./client.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
};

type ChromeMcpSessionFactory = (
  profileName: string,
  userDataDir?: string,
  profileDirectory?: string,
) => Promise<ChromeMcpSession>;
type ChromeMcpLiveChromeLauncher = (params: {
  profileName: string;
  userDataDir: string;
  profileDirectory?: string;
}) => Promise<void>;
type ChromeMcpScreenshotFallback = (params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  fullPage?: boolean;
  format: "png" | "jpeg";
}) => Promise<Buffer | null>;
type ChromeMcpCallOptions = {
  timeoutMs?: number;
  userDataDir?: string;
  profileDirectory?: string;
};

const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];

const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, Promise<ChromeMcpSession>>();
// Do not cache attach failures across calls. Existing-session Chrome lanes can
// fail once while Chrome shows an approval prompt; once the user approves it,
// the very next retry should reconnect instead of failing closed for a minute.
let sessionFactory: ChromeMcpSessionFactory | null = null;
const DEFAULT_CHROME_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const CHROME_MCP_EXISTING_SESSION_ATTACH_TIMEOUT_MS = 60_000;
const CHROME_MCP_ATTACH_RETRY_POLL_MS = 500;
const CHROME_MCP_LIVE_CHROME_LAUNCH_READY_WINDOW_MS = 10_000;
const CHROME_MCP_LIVE_CHROME_LAUNCH_POLL_MS = 250;
const CHROME_MCP_DEVTOOLS_WS_PROBE_TIMEOUT_MS = 1_500;
const CHROME_MCP_SCREENSHOT_CDP_TIMEOUT_MS = 5_000;
const INITIAL_DEFAULT_CHROME_USER_DATA_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome",
);
let defaultChromeUserDataDir = INITIAL_DEFAULT_CHROME_USER_DATA_DIR;
let processCommandLinesReader: (() => string[]) | null = null;
let liveChromeLauncher: ChromeMcpLiveChromeLauncher | null = null;
let devToolsWsEndpointProber: ((port: number, browserPath: string) => Promise<boolean>) | null =
  null;
let screenshotFallbackForTest: ChromeMcpScreenshotFallback | null = null;
const profileDirectoryOverrides = new Map<string, string>();

function traceChromeMcpStage(stage: string): void {
  const stageLogPath = process.env.OPENCLAW_STAGE_LOG?.trim();
  if (!stageLogPath) {
    return;
  }
  try {
    appendFileSync(stageLogPath, `${new Date().toISOString()} ${stage}\n`);
  } catch {
    // Best-effort tracing only.
  }
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_CHROME_MCP_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

function parseAttachUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "ws:" &&
      parsed.protocol !== "wss:"
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeChromeProfileDirectory(profileDirectory?: string): string | undefined {
  const trimmed = profileDirectory?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveConfiguredProfileDirectory(profileName: string): string | undefined {
  const override = normalizeChromeProfileDirectory(profileDirectoryOverrides.get(profileName));
  if (override) {
    return override;
  }
  try {
    return normalizeChromeProfileDirectory(
      loadConfig().browser?.profiles?.[profileName]?.profileDirectory,
    );
  } catch {
    return undefined;
  }
}

function readProcessCommandLines(): string[] {
  if (processCommandLinesReader) {
    return processCommandLinesReader();
  }
  if (process.platform !== "darwin") {
    return [];
  }
  const ps = spawnSync("ps", ["-axo", "command="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (ps.error || ps.status !== 0) {
    return [];
  }
  return ps.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractCommandFlagValue(commandLine: string, flagName: string): string | null {
  const prefix = `--${flagName}=`;
  const start = commandLine.indexOf(prefix);
  if (start < 0) {
    return null;
  }
  const raw = commandLine.slice(start + prefix.length);
  if (!raw) {
    return null;
  }
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 1 ? raw.slice(1, end) : null;
  }
  const nextFlag = raw.indexOf(" --");
  return (nextFlag >= 0 ? raw.slice(0, nextFlag) : raw).trim() || null;
}

function isMainBrowserProcessCommand(commandLine: string): boolean {
  return !commandLine.includes(" --type=") && !commandLine.includes(" Helper");
}

function commandLooksLikeGoogleChrome(commandLine: string): boolean {
  const lower = commandLine.toLowerCase();
  return lower.includes("google chrome") || lower.includes("google-chrome");
}

function resolveExpectedUserDataDir(userDataDir?: string): string | undefined {
  return normalizeChromeMcpUserDataDir(userDataDir) ?? defaultChromeUserDataDir;
}

function findRunningBrowserPortForProfileDirectory(params: {
  profileName: string;
  userDataDir?: string;
  profileDirectory: string;
}): number | null {
  const expectedUserDataDir = resolveExpectedUserDataDir(params.userDataDir);
  if (!expectedUserDataDir) {
    return null;
  }
  for (const commandLine of readProcessCommandLines()) {
    if (!isMainBrowserProcessCommand(commandLine)) {
      continue;
    }
    const remoteDebuggingPort = extractCommandFlagValue(commandLine, "remote-debugging-port");
    if (!remoteDebuggingPort) {
      continue;
    }
    const profileDirectory = extractCommandFlagValue(commandLine, "profile-directory");
    if (profileDirectory !== params.profileDirectory) {
      continue;
    }
    const processUserDataDir = extractCommandFlagValue(commandLine, "user-data-dir");
    if (processUserDataDir) {
      if (normalizeChromeMcpUserDataDir(processUserDataDir) !== expectedUserDataDir) {
        continue;
      }
    } else if (expectedUserDataDir !== defaultChromeUserDataDir) {
      continue;
    }
    const port = Number.parseInt(remoteDebuggingPort, 10);
    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      traceChromeMcpStage(
        `chrome-mcp-attach-mode profile=${params.profileName} mode=profileDirectory-match directory=${params.profileDirectory} port=${port}`,
      );
      return port;
    }
  }
  return null;
}

function hasRunningGoogleChromeForUserDataDir(params: {
  userDataDir: string;
  profileDirectory?: string;
}): boolean {
  const expectedUserDataDir = normalizeChromeMcpUserDataDir(params.userDataDir);
  if (!expectedUserDataDir) {
    return false;
  }
  for (const commandLine of readProcessCommandLines()) {
    if (!isMainBrowserProcessCommand(commandLine) || !commandLooksLikeGoogleChrome(commandLine)) {
      continue;
    }
    const processUserDataDir = extractCommandFlagValue(commandLine, "user-data-dir");
    if (processUserDataDir) {
      if (normalizeChromeMcpUserDataDir(processUserDataDir) !== expectedUserDataDir) {
        continue;
      }
    } else if (expectedUserDataDir !== defaultChromeUserDataDir) {
      continue;
    }
    const processProfileDirectory = extractCommandFlagValue(commandLine, "profile-directory");
    if (params.profileDirectory && processProfileDirectory !== params.profileDirectory) {
      continue;
    }
    return true;
  }
  return false;
}

async function probeBrowserUrlFromPort(
  profileName: string,
  port: number,
  modeLabel: string,
): Promise<ChromeMcpAttachTarget | null> {
  const browserUrl = `http://127.0.0.1:${port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    const response = await fetch(`${browserUrl}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof payload.webSocketDebuggerUrl !== "string" || !payload.webSocketDebuggerUrl.trim()) {
      return null;
    }
    traceChromeMcpStage(
      `chrome-mcp-attach-mode profile=${profileName} mode=${modeLabel} url=${browserUrl}`,
    );
    return {
      mode: "browserUrl",
      flag: "--browserUrl",
      url: browserUrl,
    };
  } catch {
    return null;
  }
}

async function defaultProbeDevToolsWsEndpoint(port: number, browserPath: string): Promise<boolean> {
  // Chrome's live-profile remote-debugging UI can expose only the browser
  // WebSocket while returning empty/404 responses for /json/version. Probe the
  // WebSocket handshake directly so user-live does not fall back to broken
  // --autoConnect after Chrome is already saying "Server running at ...".
  const key = randomBytes(16).toString("base64");
  const request = [
    `GET ${browserPath} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");

  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CHROME_MCP_DEVTOOLS_WS_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.write(request);
    });
    socket.once("data", (chunk) => {
      const statusLine = chunk.toString("latin1").split(/\r?\n/, 1)[0] ?? "";
      finish(/\s101\s/.test(statusLine));
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}

async function probeWsEndpointFromDevToolsActivePort(params: {
  profileName: string;
  activePort: ChromeDevToolsActivePort;
  modeLabel: string;
}): Promise<ChromeMcpAttachTarget | null> {
  const prober = devToolsWsEndpointProber ?? defaultProbeDevToolsWsEndpoint;
  if (!(await prober(params.activePort.port, params.activePort.browserPath))) {
    return null;
  }
  const url = `ws://127.0.0.1:${params.activePort.port}${params.activePort.browserPath}`;
  traceChromeMcpStage(
    `chrome-mcp-attach-mode profile=${params.profileName} mode=${params.modeLabel} url=${url}`,
  );
  return {
    mode: "wsEndpoint",
    flag: "--wsEndpoint",
    url,
  };
}

async function waitForLaunchedLiveChromeTarget(params: {
  profileName: string;
  userDataDir: string;
}): Promise<ChromeMcpAttachTarget | null> {
  const deadlineMs = Date.now() + CHROME_MCP_LIVE_CHROME_LAUNCH_READY_WINDOW_MS;
  while (Date.now() < deadlineMs) {
    const activePort = readDevToolsActivePort(params.userDataDir);
    if (activePort) {
      const target = await probeBrowserUrlFromPort(
        params.profileName,
        activePort.port,
        "browserUrl-auto-launched-user-live",
      );
      if (target) {
        return target;
      }
      const wsTarget = await probeWsEndpointFromDevToolsActivePort({
        profileName: params.profileName,
        activePort,
        modeLabel: "wsEndpoint-auto-launched-user-live",
      });
      if (wsTarget) {
        return wsTarget;
      }
    }
    await new Promise((r) => setTimeout(r, CHROME_MCP_LIVE_CHROME_LAUNCH_POLL_MS));
  }
  return null;
}

async function launchLiveGoogleChrome(params: {
  profileName: string;
  userDataDir: string;
  profileDirectory?: string;
}): Promise<void> {
  if (liveChromeLauncher) {
    await liveChromeLauncher(params);
    return;
  }
  const executable = resolveGoogleChromeExecutableForPlatform(process.platform);
  if (!executable) {
    throw new BrowserProfileUnavailableError(
      `Chrome MCP existing-session attach failed for profile "${params.profileName}". Google Chrome was not found on this host. Install Google Chrome on the same host as OpenClaw, then retry.`,
    );
  }
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${params.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(params.profileDirectory ? [`--profile-directory=${params.profileDirectory}`] : []),
  ];
  const child = spawn(executable.path, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function maybeLaunchUserLiveChrome(params: {
  profileName: string;
  userDataDir: string;
  profileDirectory?: string;
}): Promise<ChromeMcpAttachTarget | null> {
  const running = hasRunningGoogleChromeForUserDataDir({
    userDataDir: params.userDataDir,
    profileDirectory: params.profileDirectory,
  });
  if (running) {
    const profileLabel = params.profileDirectory
      ? ` profile directory "${params.profileDirectory}"`
      : " default profile";
    throw new BrowserProfileUnavailableError(
      `Chrome MCP existing-session attach failed for profile "${params.profileName}". Google Chrome is already running for the${profileLabel}, but it is not exposing a verified DevTools endpoint. Chrome cannot enable remote debugging on an already-running profile in place. Quit Google Chrome and retry so OpenClaw can relaunch it in attachable mode, or open chrome://inspect/#remote-debugging in Chrome, enable remote debugging/approve the attach prompt if shown, then retry.`,
    );
  }

  traceChromeMcpStage(
    `chrome-mcp-attach-mode profile=${params.profileName} mode=auto-launch-user-live-start path=${params.userDataDir}`,
  );
  await launchLiveGoogleChrome(params);
  const launchedTarget = await waitForLaunchedLiveChromeTarget({
    profileName: params.profileName,
    userDataDir: params.userDataDir,
  });
  if (!launchedTarget) {
    throw new BrowserProfileUnavailableError(
      `Chrome MCP existing-session attach failed for profile "${params.profileName}". OpenClaw launched Google Chrome in attachable mode, but Chrome did not expose DevToolsActivePort before the attach timeout. Keep Chrome open, approve any browser attach prompt, and retry.`,
    );
  }
  return launchedTarget;
}

function resolveExistingSessionUserDataDir(
  profileName: string,
  userDataDir?: string,
): string | null {
  const normalized = normalizeChromeMcpUserDataDir(userDataDir);
  if (normalized) {
    return normalized;
  }
  // The built-in live lane targets the user's active Chrome profile by default.
  return profileName === "user-live" ? defaultChromeUserDataDir : null;
}

type ChromeDevToolsActivePort = {
  port: number;
  browserPath: string;
};

function readDevToolsActivePort(userDataDir: string): ChromeDevToolsActivePort | null {
  const devToolsActivePortPath = path.join(userDataDir, "DevToolsActivePort");
  if (!existsSync(devToolsActivePortPath)) {
    return null;
  }
  try {
    const raw = readFileSync(devToolsActivePortPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const port = Number.parseInt(lines[0] ?? "", 10);
    const browserPath = lines[1] ?? "";
    if (!Number.isFinite(port) || port < 1 || port > 65535 || !browserPath.startsWith("/")) {
      return null;
    }
    return { port, browserPath };
  } catch {
    return null;
  }
}

async function probeBrowserUrlFromUserDataDir(
  profileName: string,
  userDataDir?: string,
): Promise<ChromeMcpAttachTarget | null> {
  const resolvedUserDataDir = resolveExistingSessionUserDataDir(profileName, userDataDir);
  if (!resolvedUserDataDir) {
    return null;
  }
  const profileDirectory = resolveConfiguredProfileDirectory(profileName);
  if (profileDirectory) {
    const matchedPort = findRunningBrowserPortForProfileDirectory({
      profileName,
      userDataDir: resolvedUserDataDir,
      profileDirectory,
    });
    if (!matchedPort) {
      throw new BrowserProfileUnavailableError(
        `Chrome profile directory "${profileDirectory}" for profile "${profileName}" is not currently running with remote debugging enabled.`,
      );
    }
    const matchedTarget = await probeBrowserUrlFromPort(
      profileName,
      matchedPort,
      "browserUrl-profile-directory",
    );
    if (!matchedTarget) {
      throw new BrowserProfileUnavailableError(
        `Chrome profile directory "${profileDirectory}" for profile "${profileName}" exposed remote debugging on port ${matchedPort}, but /json/version was not ready.`,
      );
    }
    return matchedTarget;
  }
  const activePort = readDevToolsActivePort(resolvedUserDataDir);
  if (!activePort) {
    // Only the built-in Google Chrome live lane is self-healed here. Custom
    // existing-session profiles may point at Brave/Edge/custom Chromium data,
    // so launching Google Chrome against those directories would be data-risky.
    if (profileName !== "user-live" || resolvedUserDataDir !== defaultChromeUserDataDir) {
      return null;
    }
    return await maybeLaunchUserLiveChrome({
      profileName,
      userDataDir: resolvedUserDataDir,
      profileDirectory,
    });
  }
  const discoveredTarget = await probeBrowserUrlFromPort(
    profileName,
    activePort.port,
    "browserUrl-discovered",
  );
  if (discoveredTarget) {
    return discoveredTarget;
  }
  const discoveredWsTarget = await probeWsEndpointFromDevToolsActivePort({
    profileName,
    activePort,
    modeLabel: "wsEndpoint-discovered",
  });
  if (discoveredWsTarget) {
    return discoveredWsTarget;
  }
  // DevToolsActivePort can outlive the actual debug listener after Chrome restarts.
  // Treat a stale default user-live endpoint like the missing-file case so the
  // runtime either relaunches a closed Chrome safely or explains why an active
  // non-debuggable profile cannot be upgraded in place.
  if (profileName !== "user-live" || resolvedUserDataDir !== defaultChromeUserDataDir) {
    return null;
  }
  return await maybeLaunchUserLiveChrome({
    profileName,
    userDataDir: resolvedUserDataDir,
    profileDirectory,
  });
}

type ChromeMcpAttachTarget = {
  mode: "browserUrl" | "wsEndpoint";
  flag: "--browserUrl" | "--wsEndpoint";
  url: string;
};

function resolveAttachTarget(value: string | undefined): ChromeMcpAttachTarget | null {
  const parsed = parseAttachUrl(value);
  if (!parsed) {
    return null;
  }
  const protocol = new URL(parsed).protocol;
  if (protocol === "ws:" || protocol === "wss:") {
    return {
      mode: "wsEndpoint",
      flag: "--wsEndpoint",
      url: parsed,
    };
  }
  return {
    mode: "browserUrl",
    flag: "--browserUrl",
    url: parsed,
  };
}

function resolveConfiguredAttachTarget(profileName: string): ChromeMcpAttachTarget | null {
  const envWs = resolveAttachTarget(process.env.OPENCLAW_CHROME_MCP_WS_ENDPOINT);
  if (envWs) {
    return envWs;
  }
  const envBrowser = resolveAttachTarget(process.env.OPENCLAW_CHROME_MCP_BROWSER_URL);
  if (envBrowser) {
    return envBrowser;
  }
  try {
    const cfg = loadConfig();
    const profileTarget = resolveAttachTarget(cfg.browser?.profiles?.[profileName]?.cdpUrl);
    if (profileTarget) {
      return profileTarget;
    }
    return resolveAttachTarget(cfg.browser?.cdpUrl);
  } catch {
    return null;
  }
}

function toBrowserHttpUrl(target: ChromeMcpAttachTarget): string | null {
  try {
    const url = new URL(target.url);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function resolveChromeMcpBrowserHttpUrl(
  profileName: string,
  userDataDir?: string,
): Promise<string | null> {
  const configured = resolveConfiguredAttachTarget(profileName);
  if (configured) {
    return toBrowserHttpUrl(configured);
  }
  const discovered = await probeBrowserUrlFromUserDataDir(profileName, userDataDir);
  return discovered ? toBrowserHttpUrl(discovered) : null;
}

type ChromeCdpTarget = {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

async function fetchChromeCdpTargets(browserHttpUrl: string): Promise<ChromeCdpTarget[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHROME_MCP_SCREENSHOT_CDP_TIMEOUT_MS);
  try {
    const response = await fetch(`${browserHttpUrl}/json/list`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`/json/list returned ${response.status}`);
    }
    const targets = (await response.json()) as unknown;
    return Array.isArray(targets) ? (targets as ChromeCdpTarget[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

async function resolveChromeMcpPageWebSocketUrl(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
}): Promise<string | null> {
  const pageId = parsePageId(params.targetId);
  const page = await findPageById(params.profileName, pageId, params.userDataDir, undefined);
  const browserHttpUrl = await resolveChromeMcpBrowserHttpUrl(
    params.profileName,
    params.userDataDir,
  );
  if (!browserHttpUrl) {
    return null;
  }
  const targets = (await fetchChromeCdpTargets(browserHttpUrl)).filter(
    (target) =>
      target.type === "page" &&
      typeof target.webSocketDebuggerUrl === "string" &&
      target.webSocketDebuggerUrl.trim(),
  );
  const byUrl = page.url ? targets.find((target) => target.url === page.url) : undefined;
  const byIndex = targets[pageId - 1];
  return (byUrl ?? byIndex)?.webSocketDebuggerUrl ?? null;
}

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

function decodeChromeDevToolsRawMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

async function captureChromeScreenshotViaWebSocket(params: {
  wsUrl: string;
  fullPage?: boolean;
  format: "png" | "jpeg";
}): Promise<Buffer> {
  const ws = new WebSocket(params.wsUrl, {
    handshakeTimeout: CHROME_MCP_SCREENSHOT_CDP_TIMEOUT_MS,
  });
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const failAll = (err: Error): void => {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(err);
    }
  };

  ws.on("message", (data: RawData) => {
    let message: CdpResponse;
    try {
      message = JSON.parse(decodeChromeDevToolsRawMessage(data)) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? "Chrome DevTools command failed"));
      return;
    }
    entry.resolve(message.result);
  });

  ws.on("error", (err) => failAll(err instanceof Error ? err : new Error(String(err))));
  ws.on("close", () => failAll(new Error("Chrome DevTools WebSocket closed")));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Chrome DevTools WebSocket open timed out")),
      CHROME_MCP_SCREENSHOT_CDP_TIMEOUT_MS,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  const send = async (
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown> => {
    const id = ++nextId;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, CHROME_MCP_SCREENSHOT_CDP_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params: commandParams ?? {} }), (err) => {
        if (!err) {
          return;
        }
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      });
    });
  };

  try {
    await send("Page.enable");
    let clip: Record<string, number> | undefined;
    if (params.fullPage) {
      const metrics = asRecord(await send("Page.getLayoutMetrics"));
      const contentSize = asRecord(metrics?.contentSize);
      const width = Number(contentSize?.width);
      const height = Number(contentSize?.height);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        clip = {
          x: 0,
          y: 0,
          width: Math.ceil(width),
          height: Math.ceil(height),
          scale: 1,
        };
      }
    }
    const result = asRecord(
      await send("Page.captureScreenshot", {
        format: params.format,
        fromSurface: true,
        ...(clip ? { captureBeyondViewport: true, clip } : {}),
      }),
    );
    const data = typeof result?.data === "string" ? result.data : "";
    if (!data) {
      throw new Error("Chrome DevTools did not return screenshot data");
    }
    return Buffer.from(data, "base64");
  } finally {
    ws.close();
  }
}

async function captureChromeMcpPageScreenshotFallback(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  fullPage?: boolean;
  format: "png" | "jpeg";
}): Promise<Buffer | null> {
  if (screenshotFallbackForTest) {
    return await screenshotFallbackForTest(params);
  }
  const wsUrl = await resolveChromeMcpPageWebSocketUrl(params);
  if (!wsUrl) {
    return null;
  }
  return await captureChromeScreenshotViaWebSocket({
    wsUrl,
    fullPage: params.fullPage,
    format: params.format,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: typeof record.url === "string" ? record.url : undefined,
      selected: record.selected === true,
    });
  }
  return out;
}

function parsePageId(targetId: string): number {
  const parsed = Number.parseInt(targetId.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new BrowserTabNotFoundError();
  }
  return parsed;
}

function toBrowserTabs(pages: ChromeMcpStructuredPage[]): BrowserTab[] {
  return pages.map((page) => ({
    targetId: String(page.id),
    title: "",
    url: page.url ?? "",
    type: "page",
  }));
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: match[2]?.trim() || undefined,
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function normalizeChromeMcpUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveUserDataDirAndOptions(
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): { userDataDir?: string; profileDirectory?: string; options: ChromeMcpCallOptions } {
  if (userDataDirOrOptions && typeof userDataDirOrOptions === "object") {
    const resolvedOptions = userDataDirOrOptions;
    return {
      userDataDir: normalizeChromeMcpUserDataDir(resolvedOptions.userDataDir),
      profileDirectory: normalizeChromeProfileDirectory(resolvedOptions.profileDirectory),
      options: resolvedOptions,
    };
  }
  return {
    userDataDir: normalizeChromeMcpUserDataDir(userDataDirOrOptions),
    profileDirectory: normalizeChromeProfileDirectory(options.profileDirectory),
    options,
  };
}

function resolveSessionProfileDirectory(
  profileName: string,
  profileDirectory?: string,
): string | undefined {
  return (
    normalizeChromeProfileDirectory(profileDirectory) ??
    resolveConfiguredProfileDirectory(profileName)
  );
}

function buildChromeMcpSessionCacheKey(
  profileName: string,
  userDataDir?: string,
  profileDirectory?: string,
): string {
  return JSON.stringify([
    profileName,
    normalizeChromeMcpUserDataDir(userDataDir) ?? "",
    resolveSessionProfileDirectory(profileName, profileDirectory) ?? "",
  ]);
}

function cacheKeyMatchesProfileName(cacheKey: string, profileName: string): boolean {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

async function closeChromeMcpSessionsForProfile(
  profileName: string,
  keepKey?: string,
): Promise<boolean> {
  let closed = false;

  for (const key of Array.from(pendingSessions.keys())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      pendingSessions.delete(key);
      closed = true;
    }
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      sessions.delete(key);
      closed = true;
      await session.client.close().catch(() => {});
    }
  }

  return closed;
}

export function buildChromeMcpArgs(userDataDir?: string): string[] {
  const normalizedUserDataDir = normalizeChromeMcpUserDataDir(userDataDir);
  const args = [
    DEFAULT_CHROME_MCP_ARGS[0],
    DEFAULT_CHROME_MCP_ARGS[1],
    "--autoConnect",
    ...DEFAULT_CHROME_MCP_ARGS.slice(2),
  ];
  return normalizedUserDataDir ? [...args, "--userDataDir", normalizedUserDataDir] : args;
}

async function resolveChromeMcpArgs(profileName: string, userDataDir?: string): Promise<string[]> {
  const attachTarget = resolveConfiguredAttachTarget(profileName);
  if (attachTarget) {
    traceChromeMcpStage(
      `chrome-mcp-attach-mode profile=${profileName} mode=${attachTarget.mode} url=${attachTarget.url}`,
    );
    return [...DEFAULT_CHROME_MCP_ARGS, attachTarget.flag, attachTarget.url];
  }
  if (profileName === "user-live") {
    const discoveredTarget = await probeBrowserUrlFromUserDataDir(profileName, userDataDir);
    if (discoveredTarget) {
      return [...DEFAULT_CHROME_MCP_ARGS, discoveredTarget.flag, discoveredTarget.url];
    }
    const normalizedUserDataDir = normalizeChromeMcpUserDataDir(userDataDir);
    if (normalizedUserDataDir) {
      traceChromeMcpStage(
        `chrome-mcp-attach-mode profile=${profileName} mode=autoConnect+userDataDir path=${normalizedUserDataDir}`,
      );
      return buildChromeMcpArgs(normalizedUserDataDir);
    }
    traceChromeMcpStage(`chrome-mcp-attach-mode profile=${profileName} mode=autoConnect`);
    return buildChromeMcpArgs();
  }
  const discoveredTarget = await probeBrowserUrlFromUserDataDir(profileName, userDataDir);
  if (discoveredTarget) {
    return [...DEFAULT_CHROME_MCP_ARGS, discoveredTarget.flag, discoveredTarget.url];
  }
  const normalizedUserDataDir = normalizeChromeMcpUserDataDir(userDataDir);
  if (normalizedUserDataDir) {
    traceChromeMcpStage(
      `chrome-mcp-attach-mode profile=${profileName} mode=autoConnect+userDataDir path=${normalizedUserDataDir}`,
    );
    return buildChromeMcpArgs(normalizedUserDataDir);
  }
  traceChromeMcpStage(`chrome-mcp-attach-mode profile=${profileName} mode=autoConnect`);
  return buildChromeMcpArgs();
}

async function createRealSession(
  profileName: string,
  userDataDir?: string,
  profileDirectory?: string,
): Promise<ChromeMcpSession> {
  const args = await resolveChromeMcpArgs(profileName, userDataDir);
  const transport = new StdioClientTransport({
    command: DEFAULT_CHROME_MCP_COMMAND,
    args,
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );

  const ready = (async () => {
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "list_pages")) {
        throw new Error("Chrome MCP server did not expose the expected navigation tools.");
      }
    } catch (err) {
      await client.close().catch(() => {});
      const targetLabel = userDataDir
        ? `the configured Chromium user data dir (${userDataDir})`
        : "Google Chrome's default profile";
      const profileLabel = profileDirectory ? ` and profile directory (${profileDirectory})` : "";
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
          `Make sure ${targetLabel}${profileLabel} is running locally with remote debugging enabled. ` +
          `Details: ${String(err)}`,
      );
    }
  })();

  return {
    client,
    transport,
    ready,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isClosedChromeMcpTransportErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("mcp error -32000: connection closed") ||
    lower.includes("socket closed") ||
    lower.includes("socket hang up") ||
    lower.includes("econnreset") ||
    lower.includes("connection closed")
  );
}

function buildChromeMcpConnectionClosedGuidance(
  profileName: string,
  detail: string,
): BrowserProfileUnavailableError {
  // Chrome can close the MCP transport while its remote-debugging approval
  // prompt is settling. That is a browser handshake problem, not a gateway
  // outage, so the final error must give the operator an actionable retry path.
  return new BrowserProfileUnavailableError(
    `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
      "Chrome closed the remote-debugging connection during the approval handshake. " +
      "Stop now, keep Chrome open, ask the user to click Allow if prompted, or enable " +
      "remote debugging at chrome://inspect/#remote-debugging, and retry only after " +
      "the user confirms approval. " +
      `Details: ${detail}`,
  );
}

function isChromeMcpApprovalTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("mcp error -32001") ||
    lower.includes("request timed out") ||
    lower.includes("timed out awaiting tools/call") ||
    lower.includes("chrome mcp attach timed out") ||
    lower.includes("network.enable timed out")
  );
}

function buildChromeMcpApprovalTimeoutGuidance(
  profileName: string,
  detail: string,
): BrowserProfileUnavailableError {
  // A live Chrome attach can sit behind Chrome's approval prompt until the MCP
  // tool call times out. Continuing to retry or changing code at that point
  // creates false root causes; the operator must approve Chrome first.
  return new BrowserProfileUnavailableError(
    `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
      "Chrome is likely waiting for the user to approve remote debugging. " +
      "Stop now, keep Chrome open, ask the user to click Allow or enable " +
      "chrome://inspect/#remote-debugging, and retry only after the user confirms approval. " +
      `Details: ${detail}`,
  );
}

function normalizeAttachFailure(profileName: string, err: unknown): BrowserProfileUnavailableError {
  const message = normalizeErrorMessage(err);
  if (isClosedChromeMcpTransportErrorMessage(message)) {
    return buildChromeMcpConnectionClosedGuidance(profileName, message);
  }
  if (isChromeMcpApprovalTimeoutMessage(message)) {
    return buildChromeMcpApprovalTimeoutGuidance(profileName, message);
  }
  if (err instanceof BrowserProfileUnavailableError) {
    return err;
  }
  return new BrowserProfileUnavailableError(
    `Chrome MCP existing-session attach failed for profile "${profileName}". Details: ${message}`,
  );
}

export function isRetryableChromeMcpAttachError(err: unknown): boolean {
  const message = normalizeErrorMessage(err);
  return (
    isClosedChromeMcpTransportErrorMessage(message) || isChromeMcpApprovalTimeoutMessage(message)
  );
}

function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function waitBeforeChromeMcpAttachRetry(deadlineMs: number): Promise<boolean> {
  const remainingMs = remainingTimeoutMs(deadlineMs);
  if (remainingMs <= 0) {
    return false;
  }
  await new Promise((r) => setTimeout(r, Math.min(CHROME_MCP_ATTACH_RETRY_POLL_MS, remainingMs)));
  return remainingTimeoutMs(deadlineMs) > 0;
}

async function getSession(
  profileName: string,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpSession> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const sessionProfileDirectory = resolveSessionProfileDirectory(
    profileName,
    options.profileDirectory,
  );
  traceChromeMcpStage(`chrome-mcp-session-get-start profile=${profileName} timeoutMs=${timeoutMs}`);
  const cacheKey = buildChromeMcpSessionCacheKey(
    profileName,
    options.userDataDir,
    sessionProfileDirectory,
  );
  await closeChromeMcpSessionsForProfile(profileName, cacheKey);

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }
  if (!session) {
    let pending = pendingSessions.get(cacheKey);
    if (!pending) {
      traceChromeMcpStage(`chrome-mcp-session-create-start profile=${profileName}`);
      pending = (async () => {
        const created = await (sessionFactory ?? createRealSession)(
          profileName,
          options.userDataDir,
          sessionProfileDirectory,
        );
        if (pendingSessions.get(cacheKey) === pending) {
          sessions.set(cacheKey, created);
        } else {
          await created.client.close().catch(() => {});
        }
        traceChromeMcpStage(`chrome-mcp-session-create-done profile=${profileName}`);
        return created;
      })();
      pendingSessions.set(cacheKey, pending);
    }
    try {
      session = await pending;
    } catch (err) {
      throw normalizeAttachFailure(profileName, err);
    } finally {
      if (pendingSessions.get(cacheKey) === pending) {
        pendingSessions.delete(cacheKey);
      }
    }
  }
  try {
    await withTimeout(session.ready, timeoutMs, () => {
      return new BrowserProfileUnavailableError(
        `Chrome MCP attach timed out for profile "${profileName}" after ${timeoutMs}ms.`,
      );
    });
    traceChromeMcpStage(`chrome-mcp-session-ready profile=${profileName}`);
    return session;
  } catch (err) {
    const current = sessions.get(cacheKey);
    if (current?.transport === session.transport) {
      sessions.delete(cacheKey);
    }
    await session.client.close().catch(() => {});
    throw normalizeAttachFailure(profileName, err);
  }
}

async function callTool(
  profileName: string,
  userDataDir: string | undefined,
  profileDirectory: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpToolResult> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  traceChromeMcpStage(
    `chrome-mcp-tool-start profile=${profileName} tool=${name} timeoutMs=${timeoutMs}`,
  );
  const sessionProfileDirectory = resolveSessionProfileDirectory(profileName, profileDirectory);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, userDataDir, sessionProfileDirectory);
  let lastError: unknown;

  while (remainingTimeoutMs(deadlineMs) > 0) {
    const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingTimeoutMs(deadlineMs) + 1));
    let session: ChromeMcpSession | undefined;
    let result: ChromeMcpToolResult;
    try {
      session = await getSession(profileName, {
        ...options,
        timeoutMs: attemptTimeoutMs,
        userDataDir,
        profileDirectory: sessionProfileDirectory,
      });
      result = (await session.client.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        {
          timeout: attemptTimeoutMs,
        },
      )) as ChromeMcpToolResult;
    } catch (err) {
      lastError = err;
      if (session) {
        // Transport/connection error — tear down session so attach can reconnect.
        sessions.delete(cacheKey);
        await session.client.close().catch(() => {});
      }
      if (!isRetryableChromeMcpAttachError(err)) {
        throw normalizeAttachFailure(profileName, err);
      }
      traceChromeMcpStage(
        `chrome-mcp-tool-retry profile=${profileName} tool=${name} remainingMs=${remainingTimeoutMs(
          deadlineMs,
        )}`,
      );
      if (!(await waitBeforeChromeMcpAttachRetry(deadlineMs))) {
        break;
      }
      continue;
    }
    // Tool-level errors (element not found, script error, etc.) don't indicate a
    // broken connection — don't tear down the session for these.
    if (result.isError) {
      throw new Error(extractToolErrorMessage(result, name));
    }
    traceChromeMcpStage(`chrome-mcp-tool-done profile=${profileName} tool=${name}`);
    return result;
  }
  throw normalizeAttachFailure(profileName, lastError ?? new Error("Chrome MCP attach timed out."));
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findPageById(
  profileName: string,
  pageId: number,
  userDataDir?: string,
  profileDirectory?: string,
): Promise<ChromeMcpStructuredPage> {
  const pages = await listChromeMcpPages(profileName, {
    userDataDir,
    profileDirectory,
  });
  const page = pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function ensureChromeMcpAvailable(
  profileName: string,
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  const resolved = resolveUserDataDirAndOptions(userDataDirOrOptions, options);
  const timeoutMs = resolveTimeoutMs(resolved.options.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  let lastError: unknown;
  while (remainingTimeoutMs(deadlineMs) > 0) {
    try {
      await getSession(profileName, {
        ...resolved.options,
        timeoutMs: Math.max(1, Math.min(timeoutMs, remainingTimeoutMs(deadlineMs) + 1)),
        userDataDir: resolved.userDataDir,
        profileDirectory: resolved.profileDirectory,
      });
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryableChromeMcpAttachError(err)) {
        throw normalizeAttachFailure(profileName, err);
      }
      traceChromeMcpStage(
        `chrome-mcp-ensure-retry profile=${profileName} remainingMs=${remainingTimeoutMs(
          deadlineMs,
        )}`,
      );
      if (!(await waitBeforeChromeMcpAttachRetry(deadlineMs))) {
        break;
      }
    }
  }
  throw normalizeAttachFailure(profileName, lastError ?? new Error("Chrome MCP attach timed out."));
}

export function getChromeMcpPid(profileName: string): number | null {
  for (const [key, session] of sessions.entries()) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      return session.transport.pid ?? null;
    }
  }
  return null;
}

export async function resolveChromeMcpArgsForTest(
  profileName: string,
  userDataDir?: string,
): Promise<string[]> {
  return await resolveChromeMcpArgs(profileName, userDataDir);
}

export function setChromeMcpProcessCommandsForTest(reader: (() => string[]) | null): void {
  processCommandLinesReader = reader;
}

export function setChromeMcpLiveChromeLauncherForTest(
  launcher: ChromeMcpLiveChromeLauncher | null,
): void {
  liveChromeLauncher = launcher;
}

export function setChromeMcpDevToolsWsEndpointProberForTest(
  prober: ((port: number, browserPath: string) => Promise<boolean>) | null,
): void {
  devToolsWsEndpointProber = prober;
}

export function setChromeMcpScreenshotFallbackForTest(
  fallback: ChromeMcpScreenshotFallback | null,
): void {
  screenshotFallbackForTest = fallback;
}

export function setChromeMcpDefaultUserDataDirForTest(userDataDir: string | null): void {
  defaultChromeUserDataDir = userDataDir?.trim() || INITIAL_DEFAULT_CHROME_USER_DATA_DIR;
}

export function setChromeMcpProfileDirectoryForTest(
  profileName: string,
  profileDirectory: string | null,
): void {
  if (!profileDirectory) {
    profileDirectoryOverrides.delete(profileName);
    return;
  }
  profileDirectoryOverrides.set(profileName, profileDirectory);
}

export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  return await closeChromeMcpSessionsForProfile(profileName);
}

export async function stopAllChromeMcpSessions(): Promise<void> {
  const names = [...new Set([...sessions.keys()].map((key) => JSON.parse(key)[0] as string))];
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

export async function listChromeMcpPages(
  profileName: string,
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpStructuredPage[]> {
  const resolved = resolveUserDataDirAndOptions(userDataDirOrOptions, options);
  const result = await callTool(
    profileName,
    resolved.userDataDir,
    resolved.profileDirectory,
    "list_pages",
    {},
    resolved.options,
  );
  return extractStructuredPages(result);
}

export async function listChromeMcpTabs(
  profileName: string,
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  return toBrowserTabs(await listChromeMcpPages(profileName, userDataDirOrOptions, options));
}

export async function openChromeMcpTab(
  profileName: string,
  url: string,
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab> {
  const resolved = resolveUserDataDirAndOptions(userDataDirOrOptions, options);
  const result = await callTool(
    profileName,
    resolved.userDataDir,
    resolved.profileDirectory,
    "new_page",
    {
      url,
      ...(typeof resolved.options.timeoutMs === "number"
        ? { timeout: resolved.options.timeoutMs }
        : {}),
    },
    resolved.options,
  );
  const pages = extractStructuredPages(result);
  const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!chosen) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  return {
    targetId: String(chosen.id),
    title: "",
    url: chosen.url ?? url,
    type: "page",
  };
}

export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  const resolved = resolveUserDataDirAndOptions(userDataDirOrOptions, options);
  await callTool(
    profileName,
    resolved.userDataDir,
    resolved.profileDirectory,
    "select_page",
    {
      pageId: parsePageId(targetId),
      bringToFront: true,
    },
    resolved.options,
  );
}

export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  userDataDirOrOptions?: string | ChromeMcpCallOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  const resolved = resolveUserDataDirAndOptions(userDataDirOrOptions, options);
  await callTool(
    profileName,
    resolved.userDataDir,
    resolved.profileDirectory,
    "close_page",
    { pageId: parsePageId(targetId) },
    resolved.options,
  );
}

export async function navigateChromeMcpPage(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "navigate_page",
    {
      pageId: parsePageId(params.targetId),
      type: "url",
      url: params.url,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
  const page = await findPageById(
    params.profileName,
    parsePageId(params.targetId),
    params.userDataDir,
    undefined,
  );
  return { url: page.url ?? params.url };
}

export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
}): Promise<ChromeMcpSnapshotNode> {
  const result = await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "take_snapshot",
    {
      pageId: parsePageId(params.targetId),
    },
  );
  return extractSnapshot(result);
}

export async function takeChromeMcpScreenshot(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
}): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    const format = params.format ?? "png";
    const targetMode = params.uid ? "ref" : params.fullPage ? "fullPage" : "page";
    await callTool(params.profileName, params.userDataDir, undefined, "take_screenshot", {
      pageId: parsePageId(params.targetId),
      filePath,
      format,
      ...(params.uid ? { uid: params.uid } : {}),
      ...(params.fullPage ? { fullPage: true } : {}),
    });
    // The MCP server can report a successful screenshot call while failing to
    // materialize the requested artifact. Check the contract boundary here so
    // callers get a truthful browser error instead of a misleading ENOENT.
    if (!existsSync(filePath)) {
      let fallbackError: string | undefined;
      if (!params.uid) {
        try {
          const fallback = await captureChromeMcpPageScreenshotFallback({
            profileName: params.profileName,
            userDataDir: params.userDataDir,
            targetId: params.targetId,
            fullPage: params.fullPage,
            format,
          });
          if (fallback) {
            return fallback;
          }
        } catch (err) {
          fallbackError = normalizeErrorMessage(err);
        }
      }
      throw new Error(
        [
          "Chrome MCP screenshot output file was not created.",
          `profile=${params.profileName}`,
          `targetId=${params.targetId}`,
          `format=${format}`,
          `target=${targetMode}`,
          params.uid ? "fallback=not-applicable" : "fallback=direct-cdp-unavailable",
          ...(fallbackError ? [`fallbackError=${fallbackError}`] : []),
        ].join(" "),
      );
    }
    return await fs.readFile(filePath);
  });
}

export async function clickChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  doubleClick?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  // Chrome MCP validates tool arguments strictly. Interaction timeouts belong
  // on the MCP client call, not in the tool payload, or the host rejects the
  // otherwise valid action before Chrome can run it.
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "click",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      ...(params.doubleClick ? { dblClick: true } : {}),
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export async function fillChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  value: string;
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "fill",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      value: params.value,
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export async function fillChromeMcpForm(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  elements: Array<{ uid: string; value: string }>;
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "fill_form",
    {
      pageId: parsePageId(params.targetId),
      elements: params.elements,
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export async function hoverChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "hover",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export async function dragChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  fromUid: string;
  toUid: string;
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "drag",
    {
      pageId: parsePageId(params.targetId),
      from_uid: params.fromUid,
      to_uid: params.toUid,
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export async function uploadChromeMcpFile(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  filePath: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, undefined, "upload_file", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    filePath: params.filePath,
  });
}

export async function pressChromeMcpKey(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  key: string;
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "press_key",
    {
      pageId: parsePageId(params.targetId),
      key: params.key,
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export async function resizeChromeMcpPage(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  width: number;
  height: number;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, undefined, "resize_page", {
    pageId: parsePageId(params.targetId),
    width: params.width,
    height: params.height,
  });
}

export async function handleChromeMcpDialog(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, undefined, "handle_dialog", {
    pageId: parsePageId(params.targetId),
    action: params.action,
    ...(params.promptText ? { promptText: params.promptText } : {}),
  });
}

export async function evaluateChromeMcpScript(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  fn: string;
  args?: string[];
  timeoutMs?: number;
}): Promise<unknown> {
  const result = await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "evaluate_script",
    {
      pageId: parsePageId(params.targetId),
      function: params.fn,
      ...(params.args?.length ? { args: params.args } : {}),
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
  return extractJsonMessage(result);
}

export async function waitForChromeMcpText(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  text: string[];
  timeoutMs?: number;
}): Promise<void> {
  await callTool(
    params.profileName,
    params.userDataDir,
    undefined,
    "wait_for",
    {
      pageId: parsePageId(params.targetId),
      text: params.text,
      ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
    },
    typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined,
  );
}

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  sessionFactory = null;
  processCommandLinesReader = null;
  liveChromeLauncher = null;
  devToolsWsEndpointProber = null;
  defaultChromeUserDataDir = INITIAL_DEFAULT_CHROME_USER_DATA_DIR;
  profileDirectoryOverrides.clear();
  pendingSessions.clear();
  await stopAllChromeMcpSessions();
}
