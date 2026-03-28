import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, isNodeCommandAllowedMock, resolveNodeCommandAllowlistMock } = vi.hoisted(
  () => ({
    loadConfigMock: vi.fn(),
    isNodeCommandAllowedMock: vi.fn(),
    resolveNodeCommandAllowlistMock: vi.fn(),
  }),
);
const {
  resolveBrowserConfigMock,
  resolveBrowserControlAuthMock,
  startBrowserControlServerIfEnabledMock,
  fetchMock,
} = vi.hoisted(() => ({
  resolveBrowserConfigMock: vi.fn(),
  resolveBrowserControlAuthMock: vi.fn(),
  startBrowserControlServerIfEnabledMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../browser/config.js", () => ({
  resolveBrowserConfig: resolveBrowserConfigMock,
}));

vi.mock("../../browser/control-auth.js", () => ({
  resolveBrowserControlAuth: resolveBrowserControlAuthMock,
}));

vi.mock("../node-command-policy.js", () => ({
  isNodeCommandAllowed: isNodeCommandAllowedMock,
  resolveNodeCommandAllowlist: resolveNodeCommandAllowlistMock,
}));

vi.mock("../server-browser.js", () => ({
  startBrowserControlServerIfEnabled: startBrowserControlServerIfEnabledMock,
}));

import { browserHandlers } from "./browser.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createContext() {
  const invoke = vi.fn(async () => ({
    ok: true,
    payload: {
      result: { ok: true },
    },
  }));
  const listConnected = vi.fn(() => [
    {
      nodeId: "node-1",
      caps: ["browser"],
      commands: ["browser.proxy"],
      platform: "linux",
    },
  ]);
  return {
    invoke,
    listConnected,
  };
}

async function runBrowserRequest(params: Record<string, unknown>) {
  const respond = vi.fn();
  const nodeRegistry = createContext();
  await browserHandlers["browser.request"]({
    params,
    respond: respond as never,
    context: { nodeRegistry } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
  });
  return { respond, nodeRegistry };
}

describe("browser.request profile selection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto" } } },
    });
    resolveNodeCommandAllowlistMock.mockReturnValue([]);
    isNodeCommandAllowedMock.mockReturnValue({ ok: true });
    resolveBrowserConfigMock.mockReturnValue({ controlPort: 18791 });
    resolveBrowserControlAuthMock.mockReturnValue({ token: "test-token" });
    startBrowserControlServerIfEnabledMock.mockResolvedValue({ stop: async () => {} });
    fetchMock.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses profile from request body when query profile is missing", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          profile: "work",
        }),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });

  it("prefers query profile over body profile when both are present", async () => {
    const { nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          profile: "chrome",
        }),
      }),
    );
  });

  it.each([
    {
      method: "POST",
      path: "/profiles/create",
      body: { name: "poc", cdpUrl: "http://10.0.0.42:9222" },
    },
    {
      method: "DELETE",
      path: "/profiles/poc",
      body: undefined,
    },
    {
      method: "POST",
      path: "profiles/create",
      body: { name: "poc", cdpUrl: "http://10.0.0.42:9222" },
    },
    {
      method: "DELETE",
      path: "profiles/poc",
      body: undefined,
    },
  ])("blocks persistent profile mutations for $method $path", async ({ method, path, body }) => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method,
      path,
      body,
    });

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "browser.request cannot create or delete persistent browser profiles",
      }),
    );
  });

  it("proxies local browser requests through the loopback browser server", async () => {
    loadConfigMock.mockReturnValue({
      browser: { enabled: true },
      gateway: { nodes: { browser: { mode: "off" } } },
    });

    const respond = vi.fn();
    await browserHandlers["browser.request"]({
      params: {
        method: "GET",
        path: "/",
        query: { profile: "user-live" },
        timeoutMs: 4321,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: vi.fn(() => []),
          invoke: vi.fn(),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-2", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(startBrowserControlServerIfEnabledMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18791/?profile=user-live");
    expect(init).toMatchObject({
      method: "GET",
      headers: expect.any(Headers),
      signal: expect.any(AbortSignal),
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });
});
