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
  fillChromeMcpForm,
  ensureChromeMcpAvailable,
  listChromeMcpTabs,
  openChromeMcpTab,
  pressChromeMcpKey,
  resetChromeMcpSessionsForTest,
  setChromeMcpDevToolsWsEndpointProberForTest,
  resolveChromeMcpArgsForTest,
  setChromeMcpDefaultUserDataDirForTest,
  setChromeMcpLiveChromeLauncherForTest,
  setChromeMcpProcessCommandsForTest,
  setChromeMcpProfileDirectoryForTest,
  setChromeMcpSessionFactoryForTest,
  takeChromeMcpScreenshot,
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
    if (
      name === "click" ||
      name === "fill" ||
      name === "fill_form" ||
      name === "press_key" ||
      name === "take_screenshot"
    ) {
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

  it("maps the built-in signed-in clone to Chrome MCP browserUrl", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("signed-in should use its resolved browserUrl without discovery");
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(resolveChromeMcpArgsForTest("signed-in")).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--browserUrl",
        "http://127.0.0.1:18801/",
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
      setChromeMcpLiveChromeLauncherForTest(null);
      setChromeMcpProcessCommandsForTest(null);
      setChromeMcpDefaultUserDataDirForTest(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the live DevToolsActivePort WebSocket for user-live when Chrome exposes it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-user-live-"));
    await fs.writeFile(path.join(tempDir, "DevToolsActivePort"), "9227\n/devtools/browser/live\n");
    const fetchMock = vi.fn(async () => ({ ok: false }));
    const wsProbe = vi.fn(async () => true);
    const launcher = vi.fn(async () => {});
    vi.stubGlobal("fetch", fetchMock);
    setChromeMcpDevToolsWsEndpointProberForTest(wsProbe);
    setChromeMcpDefaultUserDataDirForTest(tempDir);
    setChromeMcpProcessCommandsForTest(() => []);
    setChromeMcpLiveChromeLauncherForTest(launcher);

    try {
      await expect(resolveChromeMcpArgsForTest("user-live")).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--wsEndpoint",
        "ws://127.0.0.1:9227/devtools/browser/live",
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:9227/json/version",
        expect.anything(),
      );
      expect(wsProbe).toHaveBeenCalledWith(9227, "/devtools/browser/live");
      expect(launcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      setChromeMcpDevToolsWsEndpointProberForTest(null);
      setChromeMcpLiveChromeLauncherForTest(null);
      setChromeMcpProcessCommandsForTest(null);
      setChromeMcpDefaultUserDataDirForTest(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes --userDataDir for user-live while staying on autoConnect", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-user-live-"));
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be called for user-live autoConnect");
    });
    vi.stubGlobal("fetch", fetchMock);
    setChromeMcpLiveChromeLauncherForTest(vi.fn(async () => {}));

    try {
      await expect(resolveChromeMcpArgsForTest("user-live", tempDir)).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--autoConnect",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--userDataDir",
        tempDir,
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      setChromeMcpLiveChromeLauncherForTest(null);
      setChromeMcpProcessCommandsForTest(null);
      setChromeMcpDefaultUserDataDirForTest(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lets an explicit user-live attach target win over autoConnect", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-user-live-"));
    await fs.writeFile(path.join(tempDir, "DevToolsActivePort"), "9227\n/devtools/browser/live\n");
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be called when an explicit attach target is set");
    });
    const previousBrowserUrl = process.env.OPENCLAW_CHROME_MCP_BROWSER_URL;
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENCLAW_CHROME_MCP_BROWSER_URL = "http://127.0.0.1:9444";
    setChromeMcpDefaultUserDataDirForTest(tempDir);
    setChromeMcpProcessCommandsForTest(() => []);

    try {
      await expect(resolveChromeMcpArgsForTest("user-live")).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--browserUrl",
        "http://127.0.0.1:9444/",
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (previousBrowserUrl === undefined) {
        delete process.env.OPENCLAW_CHROME_MCP_BROWSER_URL;
      } else {
        process.env.OPENCLAW_CHROME_MCP_BROWSER_URL = previousBrowserUrl;
      }
      setChromeMcpLiveChromeLauncherForTest(null);
      setChromeMcpProcessCommandsForTest(null);
      setChromeMcpDefaultUserDataDirForTest(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps non-user-live missing DevToolsActivePort on Chrome MCP autoConnect", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-custom-"));
    const launcher = vi.fn(async () => {});
    setChromeMcpLiveChromeLauncherForTest(launcher);

    try {
      await expect(resolveChromeMcpArgsForTest("custom-live", tempDir)).resolves.toEqual([
        "-y",
        "chrome-devtools-mcp@latest",
        "--autoConnect",
        "--experimentalStructuredContent",
        "--experimental-page-id-routing",
        "--userDataDir",
        tempDir,
      ]);
      expect(launcher).not.toHaveBeenCalled();
    } finally {
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

  it("retries retryable attach timeouts until the caller budget succeeds", async () => {
    let attempts = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("MCP error -32001: Request timed out");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("chrome-live", { timeoutMs: 60_000 });

    expect(attempts).toBe(3);
    expect(tabs.map((tab) => tab.targetId)).toEqual(["1", "2"]);
  });

  it("retries closed Chrome MCP attach transports until the caller budget succeeds", async () => {
    let attempts = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("MCP error -32000: Connection closed");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    const tabs = await listChromeMcpTabs("user-live", { timeoutMs: 60_000 });

    expect(attempts).toBe(2);
    expect(tabs.map((tab) => tab.targetId)).toEqual(["1", "2"]);
  });

  it("retries retryable availability attach timeouts until the caller budget succeeds", async () => {
    let attempts = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("MCP error -32001: Request timed out");
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    await ensureChromeMcpAvailable("chrome-live", { timeoutMs: 60_000 });

    expect(attempts).toBe(3);
  });

  it("retries closed Chrome MCP readiness transports after tearing down the broken session", async () => {
    let attempts = 0;
    const closedSessionClose = vi.fn(async () => {});
    const factory: ChromeMcpSessionFactory = async () => {
      attempts += 1;
      if (attempts === 1) {
        const { session: brokenSession, callTool } = createFakeSessionBundle();
        return {
          ...brokenSession,
          client: {
            callTool,
            listTools: vi.fn().mockResolvedValue({ tools: [{ name: "list_pages" }] }),
            connect: vi.fn().mockResolvedValue(undefined),
            close: closedSessionClose,
          },
          ready: Promise.reject(new Error("MCP error -32000: Connection closed")),
        } as unknown as ChromeMcpSession;
      }
      return createFakeSession();
    };
    setChromeMcpSessionFactoryForTest(factory);

    await ensureChromeMcpAvailable("user-live", { timeoutMs: 60_000 });

    expect(attempts).toBe(2);
    expect(closedSessionClose).toHaveBeenCalled();
  });

  it("explains exhausted closed Chrome MCP attach transports as approval-handshake failures", async () => {
    let attempts = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      attempts += 1;
      throw new Error("MCP error -32000: Connection closed");
    };
    setChromeMcpSessionFactoryForTest(factory);

    let message = "";
    try {
      await listChromeMcpTabs("user-live", { timeoutMs: 50 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(attempts).toBeGreaterThan(0);
    expect(message).toContain(
      "Chrome closed the remote-debugging connection during the approval handshake",
    );
    expect(message).toContain("Stop now");
    expect(message).toContain("retry only after the user confirms approval");
    expect(message).toContain("chrome://inspect/#remote-debugging");
    expect(message).not.toContain("Chrome MCP tool");
    expect(message).not.toContain("Restart the OpenClaw gateway");
    expect(message).not.toContain("Do NOT retry the browser tool");
  });

  it("explains exhausted Chrome MCP attach timeouts as waiting for user approval", async () => {
    let attempts = 0;
    const factory: ChromeMcpSessionFactory = async () => {
      attempts += 1;
      throw new Error("timed out awaiting tools/call after 120s");
    };
    setChromeMcpSessionFactoryForTest(factory);

    let message = "";
    try {
      await listChromeMcpTabs("user-live", { timeoutMs: 50 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(attempts).toBeGreaterThan(0);
    expect(message).toContain("waiting for the user to approve remote debugging");
    expect(message).toContain("Stop now");
    expect(message).toContain("retry only after the user confirms approval");
    expect(message).toContain("chrome://inspect/#remote-debugging");
    expect(message).not.toContain("Chrome MCP tool");
    expect(message).not.toContain("Restart the OpenClaw gateway");
  });

  it("reports post-ready list_pages timeouts as tool failures, not approval guidance", async () => {
    const { session, callTool } = createFakeSessionBundle();
    callTool.mockRejectedValueOnce(new Error("MCP error -32001: Request timed out"));
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    let message = "";
    try {
      await listChromeMcpTabs("chrome-live", { timeoutMs: 60_000 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(message).toContain('Chrome MCP tool "list_pages" timed out');
    expect(message).toContain("MCP error -32001: Request timed out");
    expect(message).not.toContain("remote debugging");
    expect(message).not.toContain("chrome://inspect/#remote-debugging");
  });

  it("reports post-ready evaluate_script request timeouts without approval guidance", async () => {
    const { session, callTool } = createFakeSessionBundle();
    callTool.mockImplementation(async ({ name }: ToolCall) => {
      if (name === "evaluate_script") {
        throw new Error("MCP error -32001: Request timed out");
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    let message = "";
    try {
      await evaluateChromeMcpScript({
        profileName: "signed-in",
        targetId: "1",
        fn: "() => document.body.innerText",
        timeoutMs: 30_000,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(message).toContain('Chrome MCP tool "evaluate_script" timed out after 30000ms');
    expect(message).toContain('profile "signed-in"');
    expect(message).not.toContain("waiting for the user to approve remote debugging");
    expect(message).not.toContain("chrome://inspect/#remote-debugging");
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

  it.each(["MCP error -32001: Request timed out", "Navigation timeout of 10000 ms exceeded"])(
    "recovers a created tab when new_page times out after Chrome opens it: %s",
    async (timeoutMessage) => {
      const { session, callTool } = createFakeSessionBundle();
      callTool.mockImplementation(async ({ name }: ToolCall) => {
        if (name === "new_page") {
          throw new Error(timeoutMessage);
        }
        if (name === "list_pages") {
          return {
            content: [
              {
                type: "text",
                text: [
                  "## Pages",
                  "1: chrome://new-tab-page/",
                  "2: https://www.batikair.com.my/ [selected]",
                ].join("\n"),
              },
            ],
          };
        }
        throw new Error(`unexpected tool ${name}`);
      });
      const factory: ChromeMcpSessionFactory = async () => session;
      setChromeMcpSessionFactoryForTest(factory);

      const tab = await openChromeMcpTab("signed-in", "https://www.batikair.com.my/", {
        timeoutMs: 30_000,
      });

      expect(tab).toMatchObject({
        targetId: "2",
        url: "https://www.batikair.com.my/",
        type: "page",
      });
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "list_pages" }),
        undefined,
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    },
  );

  it("keeps timeout overrides at the MCP request layer for existing-session interaction tools", async () => {
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
    await pressChromeMcpKey({
      profileName: "chrome-live",
      targetId: "1",
      key: "Enter",
      timeoutMs: 20_000,
    });

    expect(callTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: "click",
        arguments: expect.not.objectContaining({ timeout: expect.anything() }),
      }),
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: "fill",
        arguments: expect.not.objectContaining({ timeout: expect.anything() }),
      }),
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(callTool).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        name: "press_key",
        arguments: expect.not.objectContaining({ timeout: expect.anything() }),
      }),
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("waits when Chrome MCP reports a screenshot before the temp file is readable", async () => {
    const { session, callTool } = createFakeSessionBundle();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    const originalReadFile = fs.readFile;
    vi.spyOn(fs, "readFile")
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce(Buffer.from("png"));

    const buffer = await takeChromeMcpScreenshot({
      profileName: "chrome-live",
      targetId: "1",
    });

    expect(buffer.toString()).toBe("png");
    expect(callTool).toHaveBeenCalledTimes(1);
    vi.mocked(fs.readFile).mockRestore();
    expect(fs.readFile).toBe(originalReadFile);
  });

  it("waits briefly when Chrome MCP screenshot output appears after the tool returns", async () => {
    const { session, callTool } = createFakeSessionBundle();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    const originalReadFile = fs.readFile;
    vi.spyOn(fs, "readFile")
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("still missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce(Buffer.from("png"));

    const buffer = await takeChromeMcpScreenshot({
      profileName: "chrome-live",
      targetId: "1",
    });

    expect(buffer.toString()).toBe("png");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(fs.readFile).toHaveBeenCalledWith(expect.stringMatching(/openclaw-chrome-mcp-.+\.png$/));
    vi.mocked(fs.readFile).mockRestore();
    expect(fs.readFile).toBe(originalReadFile);
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

  it("keeps timeout overrides at the MCP request layer for evaluate_script", async () => {
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
        arguments: expect.objectContaining({ function: "() => 123" }),
      }),
      undefined,
      expect.objectContaining({ timeout: 18_000 }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "evaluate_script",
        arguments: expect.not.objectContaining({ timeout: expect.anything() }),
      }),
      undefined,
      expect.objectContaining({ timeout: 18_000 }),
    );
  });

  it("keeps timeout overrides at the MCP request layer for fill_form", async () => {
    const { session, callTool } = createFakeSessionBundle();
    const factory: ChromeMcpSessionFactory = async () => session;
    setChromeMcpSessionFactoryForTest(factory);

    await fillChromeMcpForm({
      profileName: "chrome-live",
      targetId: "1",
      elements: [{ uid: "origin", value: "KUL" }],
      timeoutMs: 18_000,
    });

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "fill_form",
        arguments: expect.objectContaining({
          pageId: 1,
          elements: [{ uid: "origin", value: "KUL" }],
        }),
      }),
      undefined,
      expect.objectContaining({ timeout: 18_000 }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "fill_form",
        arguments: expect.not.objectContaining({ timeout: expect.anything() }),
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
