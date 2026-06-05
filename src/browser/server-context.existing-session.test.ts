import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "./server-context.js";
import type { BrowserServerState } from "./server-context.js";

vi.mock("./chrome-mcp.js", () => ({
  CHROME_MCP_EXISTING_SESSION_ATTACH_TIMEOUT_MS: 60_000,
  closeChromeMcpSession: vi.fn(async () => true),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  isRetryableChromeMcpAttachError: vi.fn((err: unknown) =>
    err instanceof Error ? /MCP error -32001|Request timed out/i.test(err.message) : false,
  ),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", url: "https://example.com", type: "page" },
  ]),
  openChromeMcpTab: vi.fn(async () => ({
    targetId: "8",
    title: "",
    url: "https://openclaw.ai",
    type: "page",
  })),
  closeChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
}));

import * as chromeMcp from "./chrome-mcp.js";

function makeState(): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      evaluateEnabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      color: "#FF4500",
      headless: false,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome-live",
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
          userDataDir: "/tmp/brave-profile",
        },
      },
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    profiles: new Map(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("browser server-context existing-session profile", () => {
  it("routes existing-session availability and tab operations through Chrome MCP", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "https://openclaw.ai", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "https://openclaw.ai", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "https://openclaw.ai", type: "page" },
      ]);

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toContain("7");

    const opened = await live.openTab("https://openclaw.ai");
    expect(opened.targetId).toBe("8");

    const selected = await live.ensureTabAvailable();
    expect(selected.targetId).toBe("8");

    await live.focusTab("7");
    await live.stopRunningBrowser();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith("chrome-live", "/tmp/brave-profile");
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "https://openclaw.ai",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "7",
      "/tmp/brave-profile",
    );
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledWith("chrome-live");
  });

  it("keeps retryable Chrome MCP readiness timeouts inside the outer attach budget", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockRejectedValueOnce(new Error("MCP error -32001: Request timed out"))
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ]);

    await live.ensureBrowserAvailable();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledTimes(2);
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenLastCalledWith(
      "chrome-live",
      "/tmp/brave-profile",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("uses Chrome MCP for cloned existing-session availability checks", async () => {
    fs.mkdirSync("/tmp/openclaw/browser/signed-in/user-data", { recursive: true });
    const state = makeState();
    state.resolved.profiles["signed-in"] = {
      cdpPort: 18802,
      cdpUrl: "http://127.0.0.1:18802",
      color: "#0066CC",
      driver: "existing-session",
      attachOnly: true,
      cloneFromUserProfile: true,
      userDataDir: "/tmp/openclaw/browser/signed-in/user-data",
      profileDirectory: "Default",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("signed-in");

    await live.ensureBrowserAvailable();

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "signed-in",
      "/tmp/openclaw/browser/signed-in/user-data",
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "signed-in",
      "/tmp/openclaw/browser/signed-in/user-data",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});
