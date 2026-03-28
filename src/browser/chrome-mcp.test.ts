import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clickChromeMcpElement,
  buildChromeMcpArgs,
  closeChromeMcpSession,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  listChromeMcpTabs,
  openChromeMcpTab,
  resetChromeMcpSessionsForTest,
  resolveChromeMcpArgsForTest,
  setChromeMcpProcessCommandsForTest,
  setChromeMcpProfileDirectoryForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

type ChromeMcpSessionFactory = Exclude<
  Parameters<typeof setChromeMcpSessionFactoryForTest>[0],
  null
>;
type ChromeMcpSession = Awaited<ReturnType<ChromeMcpSessionFactory>>;
type ChromeMcpSessionBundle = {
  session: ChromeMcpSession;
  callTool: ReturnType<typeof vi.fn>;
};

function createFakeSessionBundle(): ChromeMcpSessionBundle {
  const callTool = vi.fn(async ({ name }: ToolCall) => {
    if (name === "list_pages") {
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session [selected]",
              "2: https://github.com/openclaw/openclaw/pull/45318",
            ].join("\n"),
          },
        ],
      };
    }
    if (name === "new_page") {
      return {
        content: [
          {
            type: "text",
            text: [
              "## Pages",
              "1: https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
              "2: https://github.com/openclaw/openclaw/pull/45318",
              "3: https://example.com/ [selected]",
            ].join("\n"),
          },
        ],
      };
    }
    if (name === "evaluate_script") {
      return {
        content: [
          {
            type: "text",
            text: "```json\n123\n```",
          },
        ],
      };
    }
    if (name === "click" || name === "fill") {
      return {
        content: [
          {
            type: "text",
            text: "ok",
          },
        ],
      };
    }
    throw new Error(`unexpected tool ${name}`);
  });

  return {
    callTool,
    session: {
      client: {
        callTool,
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
        close: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
      },
      transport: {
        pid: 123,
      },
      ready: Promise.resolve(),
    } as unknown as ChromeMcpSession,
  };
}

function createFakeSession(): ChromeMcpSession {
  return createFakeSessionBundle().session;
}

describe("chrome MCP page parsing", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
  });

  it("parses list_pages text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live");

    expect(tabs).toEqual([
      {
        targetId: "1",
        title: "",
        url: "https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session",
        type: "page",
      },
      {
        targetId: "2",
        title: "",
        url: "https://github.com/openclaw/openclaw/pull/45318",
        type: "page",
      },
    ]);
  });

  it("adds --userDataDir when an explicit Chromium profile path is configured", () => {
    expect(buildChromeMcpArgs("/tmp/brave-profile")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      "--experimentalStructuredContent",
      "--experimental-page-id-routing",
      "--userDataDir",
      "/tmp/brave-profile",
    ]);
  });

  it("prefers a discovered browserUrl over autoConnect when Chrome exposes /json/version", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-profile-"));
    await fs.writeFile(path.join(tempDir, "DevToolsActivePort"), "9222\n/devtools/browser/stale\n");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/live",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(resolveChromeMcpArgsForTest("chrome-live", tempDir)).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--browserUrl",
        "http://127.0.0.1:9222",
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9222/json/version",
        expect.anything(),
      );
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed unless the configured profileDirectory is the one actually running", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-profile-"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/live",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    setChromeMcpProfileDirectoryForTest("artem-live", "Profile 4");
    setChromeMcpProcessCommandsForTest(() => [
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir="${tempDir}" --profile-directory=Default --remote-debugging-port=9333`,
    ]);

    try {
      await expect(resolveChromeMcpArgsForTest("artem-live", tempDir)).rejects.toThrow(
        /Profile 4.*not currently running/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the matched profileDirectory port when the exact signed-in profile is running", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-profile-"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/browser/live",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    setChromeMcpProfileDirectoryForTest("artem-live", "Profile 4");
    setChromeMcpProcessCommandsForTest(() => [
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir="${tempDir}" --profile-directory="Profile 4" --remote-debugging-port=9224`,
    ]);

    try {
      await expect(resolveChromeMcpArgsForTest("artem-live", tempDir)).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--browserUrl",
        "http://127.0.0.1:9224",
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9224/json/version",
        expect.anything(),
      );
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses new_page text responses and returns the created tab", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const tab = await openChromeMcpTab("chrome-live", "https://example.com/");

    expect(tab).toEqual({
      targetId: "3",
      title: "",
      url: "https://example.com/",
      type: "page",
    });
  });

  it("forwards timeout overrides to new_page", async () => {
    const { session, callTool } = createFakeSessionBundle();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await openChromeMcpTab("chrome-live", "https://example.com/", { timeoutMs: 45_000 });

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "new_page",
        arguments: expect.objectContaining({
          url: "https://example.com/",
          timeout: 45_000,
        }),
      }),
      undefined,
      expect.objectContaining({ timeout: 45_000 }),
    );
  });

  it("forwards timeout overrides to existing-session interaction tools", async () => {
    const { session, callTool } = createFakeSessionBundle();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await clickChromeMcpElement({
      profileName: "chrome-live",
      targetId: "1",
      uid: "e1",
      timeoutMs: 30_000,
    });
    await fillChromeMcpElement({
      profileName: "chrome-live",
      targetId: "1",
      uid: "e2",
      value: "hello",
      timeoutMs: 25_000,
    });

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: "click",
        arguments: expect.objectContaining({ uid: "e1", timeout: 30_000 }),
      }),
      undefined,
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: "fill",
        arguments: expect.objectContaining({ uid: "e2", value: "hello", timeout: 25_000 }),
      }),
      undefined,
      expect.objectContaining({ timeout: 25_000 }),
    );
  });

  it("parses evaluate_script text responses when structuredContent is missing", async () => {
    const factory: ChromeMcpSessionFactory = async () => createFakeSession();
    setChromeMcpSessionFactoryForTest(factory);

    const result = await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
    });

    expect(result).toBe(123);
  });

  it("forwards timeout overrides to evaluate_script", async () => {
    const { session, callTool } = createFakeSessionBundle();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
      timeoutMs: 18_000,
    });

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "evaluate_script",
        arguments: expect.objectContaining({
          function: "() => 123",
          timeout: 18_000,
        }),
      }),
      undefined,
      expect.objectContaining({ timeout: 18_000 }),
    );
  });

  it("surfaces MCP tool errors instead of JSON parse noise", async () => {
    const factory: ChromeMcpSessionFactory = async () => {
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "evaluate_script") {
          return {
            content: [
              {
                type: "text",
                text: "Cannot read properties of null (reading 'value')",
              },
            ],
            isError: true,
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(
      evaluateChromeMcpScript({
        profileName: "chrome-live",
        targetId: "1",
        fn: "() => document.getElementById('missing').value",
      }),
    ).rejects.toThrow(/Cannot read properties of null/);
  });

  it("reuses a single pending session for concurrent requests", async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });

    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      await factoryGate;
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabsPromise = listChromeMcpTabs("chrome-live");
    const evalPromise = evaluateChromeMcpScript({
      profileName: "chrome-live",
      targetId: "1",
      fn: "() => 123",
    });

    releaseFactory();
    const [tabs, result] = await Promise.all([tabsPromise, evalPromise]);

    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(2);
    expect(result).toBe(123);
  });

  it("preserves session after tool-level errors (isError)", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      const callTool = vi.fn(async ({ name }: ToolCall) => {
        if (name === "evaluate_script") {
          return {
            content: [{ type: "text", text: "element not found" }],
            isError: true,
          };
        }
        if (name === "list_pages") {
          return {
            content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      session.client.callTool = callTool as typeof session.client.callTool;
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    // First call: tool error (isError: true) — should NOT destroy session
    await expect(
      evaluateChromeMcpScript({ profileName: "chrome-live", targetId: "1", fn: "() => null" }),
    ).rejects.toThrow(/element not found/);

    // Second call: should reuse the same session (factory called only once)
    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(1);
    expect(tabs).toHaveLength(1);
  });

  it("reconnects immediately after transport errors", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      const session = createFakeSession();
      if (factoryCalls === 1) {
        // First session: transport error (callTool throws)
        const callTool = vi.fn(async () => {
          throw new Error("connection reset");
        });
        session.client.callTool = callTool as typeof session.client.callTool;
      }
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/connection reset/);

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("creates a fresh session when userDataDir changes for the same profile", async () => {
    const createdSessions: ChromeMcpSession[] = [];
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const factoryCalls: Array<{ profileName: string; userDataDir?: string }> = [];
    const factory: ChromeMcpSessionFactory = async (profileName, userDataDir) => {
      factoryCalls.push({ profileName, userDataDir });
      const session = createFakeSession();
      const closeMock = vi.fn().mockResolvedValue(undefined);
      session.client.close = closeMock as typeof session.client.close;
      createdSessions.push(session);
      closeMocks.push(closeMock);
      return session;
    };
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live", "/tmp/brave-a");
    await listChromeMcpTabs("chrome-live", "/tmp/brave-b");

    expect(factoryCalls).toEqual([
      { profileName: "chrome-live", userDataDir: "/tmp/brave-a" },
      { profileName: "chrome-live", userDataDir: "/tmp/brave-b" },
    ]);
    expect(createdSessions).toHaveLength(2);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);
    expect(closeMocks[1]).not.toHaveBeenCalled();
  });

  it("creates a fresh session when profileDirectory changes for the same profile", async () => {
    const factoryCalls: Array<{
      profileName: string;
      userDataDir?: string;
      profileDirectory?: string;
    }> = [];
    const factory: ChromeMcpSessionFactory = async (profileName, userDataDir, profileDirectory) => {
      factoryCalls.push({ profileName, userDataDir, profileDirectory });
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);
    setChromeMcpProfileDirectoryForTest("chrome-live", "Default");

    await listChromeMcpTabs("chrome-live", "/tmp/google");
    setChromeMcpProfileDirectoryForTest("chrome-live", "Profile 4");
    await listChromeMcpTabs("chrome-live", "/tmp/google");

    expect(factoryCalls).toEqual([
      { profileName: "chrome-live", userDataDir: "/tmp/google", profileDirectory: "Default" },
      { profileName: "chrome-live", userDataDir: "/tmp/google", profileDirectory: "Profile 4" },
    ]);
  });

  it("clears failed pending sessions when the profile is explicitly reset", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw new Error("attach failed");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/attach failed/);
    await closeChromeMcpSession("chrome-live");

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("retries attach immediately after a transient failure", async () => {
    let factoryCalls = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw new Error("attach failed");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live")).rejects.toThrow(/attach failed/);

    const tabs = await listChromeMcpTabs("chrome-live");
    expect(factoryCalls).toBe(2);
    expect(tabs).toHaveLength(2);
  });

  it("forwards per-call timeout to Chrome MCP tool requests", async () => {
    const session = createFakeSession();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await listChromeMcpTabs("chrome-live", { timeoutMs: 1234 });

    const calls = (session.client.callTool as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    expect(calls[0]?.[2]).toEqual(expect.objectContaining({ timeout: 1234 }));
  });

  it("fails fast when Chrome MCP session readiness exceeds timeout", async () => {
    const close = vi.fn(async () => {});
    const callTool = vi.fn(async () => ({}));
    const session = {
      client: {
        callTool,
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
        close,
        connect: vi.fn().mockResolvedValue(undefined),
      },
      transport: { pid: 123 },
      ready: new Promise<void>(() => {}),
    } as unknown as ChromeMcpSession;
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await expect(listChromeMcpTabs("chrome-live", { timeoutMs: 25 })).rejects.toThrow(
      /attach timed out/i,
    );
    expect(close).toHaveBeenCalled();
  });
});
