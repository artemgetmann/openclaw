import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
  profileCtx: {
    profile: {
      driver: "existing-session" as const,
      name: "chrome-live",
    },
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "7",
      url: "https://example.com",
    })),
  },
  tab: {
    targetId: "7",
    url: "https://example.com",
  },
}));

const chromeMcpMocks = vi.hoisted(() => ({
  clickChromeMcpElement: vi.fn(async () => {}),
  fillChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: vi.fn(
    async (_params: { profileName: string; targetId: string; fn: string }) => true,
  ),
  navigateChromeMcpPage: vi.fn(async ({ url }: { url: string }) => ({ url })),
  pressChromeMcpKey: vi.fn(async () => {}),
  takeChromeMcpScreenshot: vi.fn(async () => Buffer.from("png")),
  takeChromeMcpSnapshot: vi.fn(async () => ({
    id: "root",
    role: "document",
    name: "Example",
    children: [{ id: "btn-1", role: "button", name: "Continue" }],
  })),
}));

vi.mock("../chrome-mcp.js", () => ({
  clickChromeMcpElement: chromeMcpMocks.clickChromeMcpElement,
  closeChromeMcpTab: vi.fn(async () => {}),
  dragChromeMcpElement: vi.fn(async () => {}),
  evaluateChromeMcpScript: chromeMcpMocks.evaluateChromeMcpScript,
  fillChromeMcpElement: chromeMcpMocks.fillChromeMcpElement,
  fillChromeMcpForm: vi.fn(async () => {}),
  hoverChromeMcpElement: vi.fn(async () => {}),
  navigateChromeMcpPage: chromeMcpMocks.navigateChromeMcpPage,
  pressChromeMcpKey: chromeMcpMocks.pressChromeMcpKey,
  resizeChromeMcpPage: vi.fn(async () => {}),
  takeChromeMcpScreenshot: chromeMcpMocks.takeChromeMcpScreenshot,
  takeChromeMcpSnapshot: chromeMcpMocks.takeChromeMcpSnapshot,
}));

vi.mock("../cdp.js", () => ({
  captureScreenshot: vi.fn(),
  snapshotAria: vi.fn(),
}));

vi.mock("../navigation-guard.js", () => ({
  assertBrowserNavigationAllowed: vi.fn(async () => {}),
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn(() => ({})),
}));

vi.mock("../screenshot.js", () => ({
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES: 128,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE: 64,
  normalizeBrowserScreenshot: vi.fn(async (buffer: Buffer) => ({
    buffer,
    contentType: "image/png",
  })),
}));

vi.mock("../../media/store.js", () => ({
  MEDIA_MAX_BYTES: 10_000_000,
  ensureMediaDir: vi.fn(async () => {}),
  saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/fake.png" })),
}));

vi.mock("./agent.shared.js", () => ({
  getPwAiModule: vi.fn(async () => null),
  handleRouteError: vi.fn(),
  readBody: vi.fn((req: BrowserRequest) => req.body ?? {}),
  requirePwAi: vi.fn(async () => {
    throw new Error("Playwright should not be used for existing-session tests");
  }),
  resolveProfileContext: vi.fn(() => routeState.profileCtx),
  resolveTargetIdFromBody: vi.fn((body: Record<string, unknown>) =>
    typeof body.targetId === "string" ? body.targetId : undefined,
  ),
  withPlaywrightRouteContext: vi.fn(),
  withRouteTabContext: vi.fn(async ({ run }: { run: (args: unknown) => Promise<void> }) => {
    await run({
      profileCtx: routeState.profileCtx,
      cdpUrl: "http://127.0.0.1:18800",
      tab: routeState.tab,
    });
  }),
}));

function getSnapshotGetHandler() {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { ssrfPolicy: undefined } }),
  } as never);
  const handler = getHandlers.get("/snapshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getSnapshotPostHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentSnapshotRoutes(app, {
    state: () => ({ resolved: { ssrfPolicy: undefined } }),
  } as never);
  const handler = postHandlers.get("/screenshot");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getActPostHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({ resolved: { evaluateEnabled: true } }),
  } as never);
  const handler = postHandlers.get("/act");
  expect(handler).toBeTypeOf("function");
  return handler;
}

function getDialogHookPostHandler() {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, {
    state: () => ({ resolved: { evaluateEnabled: true } }),
  } as never);
  const handler = postHandlers.get("/hooks/dialog");
  expect(handler).toBeTypeOf("function");
  return handler;
}

describe("existing-session browser routes", () => {
  beforeEach(() => {
    routeState.profileCtx.ensureTabAvailable.mockClear();
    chromeMcpMocks.clickChromeMcpElement.mockClear();
    chromeMcpMocks.fillChromeMcpElement.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.navigateChromeMcpPage.mockClear();
    chromeMcpMocks.pressChromeMcpKey.mockClear();
    chromeMcpMocks.takeChromeMcpScreenshot.mockClear();
    chromeMcpMocks.takeChromeMcpSnapshot.mockClear();
    chromeMcpMocks.evaluateChromeMcpScript
      .mockResolvedValueOnce({ labels: 1, skipped: 0 } as never)
      .mockResolvedValueOnce(true);
  });

  it("allows labeled AI snapshots for existing-session profiles", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();
    await handler?.({ params: {}, query: { format: "ai", labels: "1" } }, response.res);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      format: "ai",
      labels: true,
      labelsCount: 1,
      labelsSkipped: 0,
    });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
    });
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalled();
  });

  it("falls back to full-page snapshots when selector/frame is requested for existing-session profiles", async () => {
    const handler = getSnapshotGetHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: { format: "ai", selector: "#submit", frame: "iframe[name=checkout]" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      format: "ai",
      warnings: [
        expect.stringContaining(
          "selector/frame snapshots are not supported for existing-session profiles",
        ),
      ],
    });
    expect(chromeMcpMocks.takeChromeMcpSnapshot).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
    });
  });

  it("allows ref screenshots for existing-session profiles", async () => {
    const handler = getSnapshotPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { ref: "btn-1", type: "jpeg" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      path: "/tmp/fake.png",
      targetId: "7",
    });
    expect(chromeMcpMocks.takeChromeMcpScreenshot).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      uid: "btn-1",
      fullPage: false,
      format: "jpeg",
    });
  });

  it("rejects selector-based element screenshots for existing-session profiles", async () => {
    const handler = getSnapshotPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { element: "#submit" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("element screenshots are not supported"),
    });
    expect(chromeMcpMocks.takeChromeMcpScreenshot).not.toHaveBeenCalled();
  });

  it("degrades existing-session networkidle waits to document complete", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", loadState: "networkidle" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining('document.readyState === "complete"'),
    });
  });

  it("supports glob URL waits for existing-session profiles", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockImplementation(
      async ({ fn }: { fn: string }) =>
        (fn === "() => window.location.href" ? "https://example.com/" : true) as never,
    );

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "wait", url: "**/example.com/" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: "() => window.location.href",
    });
  });

  it("falls back to evaluate-based selector clicks for existing-session profiles", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "click", selector: "button[type='submit']", timeoutMs: 12_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.clickChromeMcpElement).not.toHaveBeenCalled();
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("document.querySelector"),
      timeoutMs: 12_000,
    });
  });

  it("recovers human text refs for existing-session clicks when Chrome MCP rejects the uid", async () => {
    chromeMcpMocks.clickChromeMcpElement.mockRejectedValueOnce(
      new Error('Error: Element uid "Kuala Lumpur" not found on page 3'),
    );
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "click", ref: "Kuala Lumpur", timeoutMs: 12_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      uid: "Kuala Lumpur",
      doubleClick: false,
      timeoutMs: 12_000,
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("No visible text ref matches"),
      timeoutMs: 12_000,
    });
  });

  it("refreshes stable existing-session click refs when Chrome MCP rejects the uid", async () => {
    chromeMcpMocks.clickChromeMcpElement.mockRejectedValueOnce(
      new Error('Error: Element uid "btn-1" not found on page 3'),
    );

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "click", ref: "btn-1", timeoutMs: 12_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.takeChromeMcpSnapshot).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
    });
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledTimes(2);
    expect(chromeMcpMocks.evaluateChromeMcpScript).not.toHaveBeenCalledWith(
      expect.objectContaining({ args: ["btn-1"] }),
    );
  });

  it("chooses searchable portal options through existing-session structured action", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce({
      optionText: "Bali/Denpasar (DPS)",
      matchedText: "Bali/Denpasar (DPS)",
      selectedText: "To Bali/Denpasar (DPS)",
      changed: true,
    } as never);

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "chooseOption",
          ref: "combo-to",
          optionText: "Bali/Denpasar (DPS)",
          timeoutMs: 14_000,
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      targetId: "7",
      result: {
        optionText: "Bali/Denpasar (DPS)",
        changed: true,
      },
    });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("ant-select-dropdown"),
      args: ["combo-to"],
      timeoutMs: 14_000,
    });
    const script = chromeMcpMocks.evaluateChromeMcpScript.mock.calls[0]?.[0].fn;
    expect(script).toContain("setValue(editable, queryText)");
    expect(script).not.toContain("matchTexts");
    expect(script).not.toContain("matchTexts.push(queryText)");
  });

  it("rejects existing-session chooseOption when query matches the wrong visible option", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce({
      optionText: "Kuala Lumpur (KUL)",
      matchedText: "Bengkulu (BKS)",
      selectedText: "Bengkulu (BKS)",
      changed: true,
    } as never);

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "chooseOption",
          ref: "combo-to",
          optionText: "Kuala Lumpur (KUL)",
          query: "KUL",
          match: "contains",
          timeoutMs: 14_000,
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: expect.stringContaining('chooseOption matched "Bengkulu (BKS)"'),
    });
    expect(response.body).not.toMatchObject({ ok: true });
    const script = chromeMcpMocks.evaluateChromeMcpScript.mock.calls[0]?.[0].fn;
    expect(script).toContain("setValue(editable, queryText)");
    expect(script).not.toContain("matchTexts");
    expect(script).not.toContain("matchTexts.push(queryText)");
  });

  it("keeps scrollIntoView timeout overrides at the MCP request layer", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "scrollIntoView",
          ref: "fare-return-1",
          timeoutMs: 14_000,
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("scrollIntoView"),
      args: ["fare-return-1"],
      timeoutMs: 14_000,
    });
  });

  it("focuses ref targets before existing-session press", async () => {
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "press", ref: "combo-title", key: "Enter", timeoutMs: 10_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      uid: "combo-title",
      timeoutMs: 10_000,
    });
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      key: "Enter",
      timeoutMs: 10_000,
    });
  });

  it("focuses selector targets before existing-session press", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);

    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "press", selector: "[role='combobox']", key: "ArrowDown", timeoutMs: 10_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("el.focus"),
      args: ["[role='combobox']"],
      timeoutMs: 10_000,
    });
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      key: "ArrowDown",
      timeoutMs: 10_000,
    });
  });

  it("passes timeout overrides through existing-session evaluate", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "evaluate", fn: "() => 123", timeoutMs: 9_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7", result: true });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: "() => 123",
      args: undefined,
      timeoutMs: 9_000,
    });
  });

  it("normalizes existing-session dialog timeoutMs instead of hard-failing", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);
    const handler = getDialogHookPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { accept: true, promptText: "Ada", timeoutMs: 9_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    expect(JSON.stringify(response.body)).not.toContain(
      "existing-session dialog handling does not support timeoutMs",
    );
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("__openclawDialogHook"),
    });
  });

  it("fills selector-only fields for existing-session profiles via evaluate fallback", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValue(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "fill",
          timeoutMs: 11_000,
          fields: [{ selector: "input[name='arrival']", value: "DXB" }],
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("document.querySelector"),
      timeoutMs: 11_000,
    });
  });

  it("normalizes existing-session type slowly=true to normal fill behavior", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "type",
          ref: "input-1",
          text: "Ada",
          slowly: true,
          timeoutMs: 11_000,
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      targetId: "7",
      normalized: { slowly: false },
    });
    expect(chromeMcpMocks.fillChromeMcpElement).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      uid: "input-1",
      value: "Ada",
      timeoutMs: 11_000,
    });
  });

  it("types into selector-only existing-session targets through evaluate fallback", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "type",
          selector: "input[name='firstName']",
          text: "Ada",
          submit: true,
          timeoutMs: 12_000,
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("document.querySelector"),
      timeoutMs: 12_000,
    });
  });

  it("passes only real element refs as evaluate_script args for chooseOption", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce({
      matchedText: "Kuala Lumpur",
    } as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: {
          kind: "chooseOption",
          ref: "airport-from",
          optionText: "Kuala Lumpur",
          timeoutMs: 30_000,
        },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      fn: expect.stringContaining("Kuala Lumpur"),
      args: ["airport-from"],
      timeoutMs: 30_000,
    });
  });

  it("refreshes snapshot once and retries stale existing-session element refs", async () => {
    chromeMcpMocks.clickChromeMcpElement
      .mockRejectedValueOnce(new Error('Element uid "btn-1" not found'))
      .mockResolvedValueOnce(undefined);
    chromeMcpMocks.takeChromeMcpSnapshot.mockClear();
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "click", ref: "btn-1" },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.takeChromeMcpSnapshot).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
    });
    expect(chromeMcpMocks.clickChromeMcpElement).toHaveBeenCalledTimes(2);
  });

  it("focuses selector targets before existing-session press", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "press", selector: "input[name='from']", key: "Enter", timeoutMs: 8_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "chrome-live",
        targetId: "7",
        fn: expect.stringContaining("document.querySelector"),
        args: ["input[name='from']"],
        timeoutMs: 8_000,
      }),
    );
    expect(chromeMcpMocks.pressChromeMcpKey).toHaveBeenCalledWith({
      profileName: "chrome-live",
      targetId: "7",
      key: "Enter",
      timeoutMs: 8_000,
    });
  });

  it("normalizes existing-session scrollIntoView timeoutMs instead of hard-failing", async () => {
    chromeMcpMocks.evaluateChromeMcpScript.mockReset();
    chromeMcpMocks.evaluateChromeMcpScript.mockResolvedValueOnce(true as never);
    const handler = getActPostHandler();
    const response = createBrowserRouteResponse();
    await handler?.(
      {
        params: {},
        query: {},
        body: { kind: "scrollIntoView", ref: "section-1", timeoutMs: 8_000 },
      },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, targetId: "7" });
    expect(JSON.stringify(response.body)).not.toContain(
      "existing-session scrollIntoView does not support timeoutMs overrides",
    );
    expect(chromeMcpMocks.evaluateChromeMcpScript).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "chrome-live",
        targetId: "7",
        fn: expect.stringContaining("scrollIntoView"),
        args: ["section-1"],
        timeoutMs: 8_000,
      }),
    );
  });
});
