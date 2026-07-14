import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  browserReplyObserveCommand,
  resolveBrowserMonitorHookToken,
} from "./reply-monitor-command.js";
import {
  BROWSER_REPLY_DISPATCH_TIMEOUT_MS,
  compileApprovedBrowserUrlPattern,
  loadBrowserReplyCursorStore,
  observeBrowserReplyOnce,
  BrowserReplyObserverConfigurationError,
  BrowserReplyObserverDispatchTimeoutError,
  BrowserReplyObserverHookHttpError,
  resolveLocalBrowserMonitorHookUrl,
  type BrowserReplyObserverConfig,
} from "./reply-monitor.js";

const tempRoots: string[] = [];

async function tempCursorPath(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-reply-"));
  tempRoots.push(root);
  return path.join(root, "cursors.json");
}

function baseConfig(cursorStorePath: string): BrowserReplyObserverConfig {
  return {
    cursorStorePath,
    hookUrl: "http://127.0.0.1:18789/hooks/monitor-event",
    matchMode: "contains",
    matchValue: "Replied",
    monitorId: "monitor-browser-1",
    profile: "isolated-test",
    selector: "[data-test=reply]",
    targetId: "tab-1",
    urlPattern: "https://example.test/thread/*",
  };
}

function commandOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hookUrl: "http://127.0.0.1:18789/hooks/monitor-event",
    matchMode: "contains",
    matchValue: "Replied",
    monitorId: "monitor-browser-1",
    pollIntervalMs: "25",
    profile: "isolated-test",
    selector: "[data-test=reply]",
    targetId: "tab-1",
    urlPattern: "https://example.test/thread/*",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe("browser reply observer scope", () => {
  it("reads only the dedicated hooks credential", () => {
    expect(
      resolveBrowserMonitorHookToken({
        OPENCLAW_HOOKS_TOKEN: " hooks-secret ",
        OPENCLAW_GATEWAY_TOKEN: "wrong-gateway-secret",
      }),
    ).toBe("hooks-secret");
    expect(
      resolveBrowserMonitorHookToken({ OPENCLAW_GATEWAY_TOKEN: "gateway-only" }),
    ).toBeUndefined();
    expect(resolveBrowserMonitorHookToken({})).toBeUndefined();
  });

  it("retries bounded watch failures but keeps one-shot fail-fast", async () => {
    const watchRuntime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as unknown as RuntimeEnv;
    const observeOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error(`transient\n${"x".repeat(500)}`))
      .mockResolvedValueOnce({
        cursorStorePath: "/tmp/cursor.json",
        dispatched: false,
        found: false,
        matched: false,
        stateChanged: false,
      });
    const wait = vi.fn(async () => undefined);

    await browserReplyObserveCommand(commandOptions({ watch: true, maxRuns: "2" }), watchRuntime, {
      env: { OPENCLAW_HOOKS_TOKEN: "test-hooks-secret" },
      observeOnce,
      sleep: wait,
    });

    expect(observeOnce).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(25);
    const loggedError = vi.mocked(watchRuntime.error).mock.calls[0]?.[0] as string;
    expect(loggedError).not.toContain("\n");
    expect(loggedError.split(": ").at(-1)?.length).toBeLessThanOrEqual(300);
    expect(watchRuntime.log).toHaveBeenCalledOnce();

    const oneShotRuntime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as unknown as RuntimeEnv;
    const oneShotError = new Error("one-shot failure");
    await expect(
      browserReplyObserveCommand(commandOptions(), oneShotRuntime, {
        env: { OPENCLAW_HOOKS_TOKEN: "test-hooks-secret" },
        observeOnce: async () => await Promise.reject(oneShotError),
        sleep: vi.fn(),
      }),
    ).rejects.toBe(oneShotError);
    expect(oneShotRuntime.error).not.toHaveBeenCalled();

    await expect(
      browserReplyObserveCommand(commandOptions({ watch: true }), watchRuntime, {
        env: { OPENCLAW_GATEWAY_TOKEN: "wrong-secret" },
        observeOnce,
        sleep: wait,
      }),
    ).rejects.toThrow("requires OPENCLAW_HOOKS_TOKEN");
  });

  it("stops watch mode for permanent configuration and hook-authentication failures", async () => {
    const permanentErrors = [
      new BrowserReplyObserverConfigurationError("invalid selector"),
      new BrowserReplyObserverHookHttpError(400, "browser reply monitor hook returned HTTP 400"),
      new BrowserReplyObserverHookHttpError(401, "browser reply monitor hook returned HTTP 401"),
      new BrowserReplyObserverHookHttpError(403, "browser reply monitor hook returned HTTP 403"),
      new BrowserReplyObserverHookHttpError(404, "browser reply monitor hook returned HTTP 404"),
    ];

    for (const error of permanentErrors) {
      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as unknown as RuntimeEnv;
      const observeOnce = vi.fn(async () => await Promise.reject(error));
      const wait = vi.fn(async () => undefined);

      await expect(
        browserReplyObserveCommand(commandOptions({ watch: true, maxRuns: "2" }), runtime, {
          env: { OPENCLAW_HOOKS_TOKEN: "test-hooks-secret" },
          observeOnce,
          sleep: wait,
        }),
      ).rejects.toBe(error);
      expect(observeOnce).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    }
  });

  it("retries rate-limit, server, and generic watch failures", async () => {
    const retryableErrors = [
      new BrowserReplyObserverHookHttpError(408, "browser reply monitor hook returned HTTP 408"),
      new BrowserReplyObserverHookHttpError(429, "browser reply monitor hook returned HTTP 429"),
      new BrowserReplyObserverHookHttpError(500, "browser reply monitor hook returned HTTP 500"),
      new Error("network disconnected"),
      new BrowserReplyObserverDispatchTimeoutError("hook dispatch timed out"),
    ];

    for (const error of retryableErrors) {
      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } as unknown as RuntimeEnv;
      const observeOnce = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({
        cursorStorePath: "/tmp/cursor.json",
        dispatched: false,
        found: false,
        matched: false,
        stateChanged: false,
      });
      const wait = vi.fn(async () => undefined);

      await browserReplyObserveCommand(commandOptions({ watch: true, maxRuns: "2" }), runtime, {
        env: { OPENCLAW_HOOKS_TOKEN: "test-hooks-secret" },
        observeOnce,
        sleep: wait,
      });
      expect(observeOnce).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledWith(25);
      expect(runtime.error).toHaveBeenCalledOnce();
    }
  });

  it("requires an absolute fixed origin and supports path-only globs", () => {
    const pattern = compileApprovedBrowserUrlPattern("https://example.test/thread/**");
    expect(pattern.test("https://example.test/thread/one/replies")).toBe(true);
    expect(pattern.test("https://example.test.evil/thread/one/replies")).toBe(false);
    expect(() => compileApprovedBrowserUrlPattern("example.test/thread/*")).toThrow(
      BrowserReplyObserverConfigurationError,
    );
    expect(() => compileApprovedBrowserUrlPattern("https://*.example.test/thread/*")).toThrow(
      "wildcards only after the origin",
    );
  });

  it("requires the generic monitor hook on loopback", () => {
    expect(resolveLocalBrowserMonitorHookUrl("http://localhost:18789/hooks/monitor-event/")).toBe(
      "http://localhost:18789/hooks/monitor-event",
    );
    expect(() =>
      resolveLocalBrowserMonitorHookUrl("https://gateway.example/hooks/monitor-event"),
    ).toThrow("local gateway");
  });
});

describe("browser reply observer cursor", () => {
  it("persists a hash-only first nonmatch without waking and suppresses it after restart", async () => {
    const cursorStorePath = await tempCursorPath();
    const dispatchEvent = vi.fn();
    const readPage = async () => ({
      allowed: true,
      found: true,
      text: "Still waiting for a response",
      url: "https://example.test/thread/42",
    });
    const first = await observeBrowserReplyOnce(baseConfig(cursorStorePath), {
      dispatchEvent,
      nowMs: 1_720_000_000_000,
      readPage,
    });
    const second = await observeBrowserReplyOnce(baseConfig(cursorStorePath), {
      dispatchEvent,
      nowMs: 1_720_000_001_000,
      readPage,
    });

    expect(first).toMatchObject({ dispatched: false, matched: false, stateChanged: true });
    expect(second).toMatchObject({ dispatched: false, matched: false, stateChanged: false });
    expect(dispatchEvent).not.toHaveBeenCalled();
    const serialized = await fs.promises.readFile(cursorStorePath, "utf8");
    expect(serialized).not.toContain("Still waiting for a response");
    expect(serialized).not.toContain("data-test");
    expect(
      Object.values((await loadBrowserReplyCursorStore(cursorStorePath)).cursors),
    ).toHaveLength(1);
  });

  it("dispatches again when a matching DOM state returns after a nonmatch", async () => {
    const cursorStorePath = await tempCursorPath();
    const dispatchEvent = vi.fn(async (_params: { event: { idempotencyKey?: string } }) => ({
      wakes: [{ monitorId: "monitor-browser-1", enqueue: { ok: true, enqueued: true } }],
    }));
    let text = "Replied: first";
    const readPage = async () => ({
      allowed: true,
      found: true,
      text,
      url: "https://example.test/thread/42",
    });

    await expect(
      observeBrowserReplyOnce(baseConfig(cursorStorePath), { dispatchEvent, readPage }),
    ).resolves.toMatchObject({ dispatched: true, matched: true });
    text = "Still waiting";
    await expect(
      observeBrowserReplyOnce(baseConfig(cursorStorePath), { dispatchEvent, readPage }),
    ).resolves.toMatchObject({ dispatched: false, matched: false, stateChanged: true });
    text = "Replied: first";
    await expect(
      observeBrowserReplyOnce(baseConfig(cursorStorePath), { dispatchEvent, readPage }),
    ).resolves.toMatchObject({ dispatched: true, matched: true });

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    const firstKey = dispatchEvent.mock.calls[0]?.[0].event.idempotencyKey;
    const secondKey = dispatchEvent.mock.calls[1]?.[0].event.idempotencyKey;
    expect(firstKey).toMatch(/^browser:[a-f0-9]{64}$/);
    expect(secondKey).toMatch(/^browser:[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(firstKey);
    const serialized = await fs.promises.readFile(cursorStorePath, "utf8");
    expect(serialized).not.toContain("Replied: first");
    expect(serialized).not.toContain("Still waiting");
  });

  it("reuses the transition idempotency key when a failed dispatch is retried", async () => {
    const cursorStorePath = await tempCursorPath();
    const config = baseConfig(cursorStorePath);
    const dispatchEvent = vi
      .fn(async (_params: { event: { idempotencyKey?: string } }) => ({
        wakes: [{ monitorId: config.monitorId, enqueue: { ok: true, enqueued: true } }],
      }))
      .mockRejectedValueOnce(new Error("temporary hook failure"));
    const readPage = async () => ({
      allowed: true,
      found: true,
      text: "Replied: retry this transition",
      url: "https://example.test/thread/42",
    });

    await expect(observeBrowserReplyOnce(config, { dispatchEvent, readPage })).rejects.toThrow(
      "temporary hook failure",
    );
    await expect(
      observeBrowserReplyOnce(config, { dispatchEvent, readPage }),
    ).resolves.toMatchObject({ dispatched: true, matched: true });

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    const failedKey = dispatchEvent.mock.calls[0]?.[0].event.idempotencyKey;
    const retryKey = dispatchEvent.mock.calls[1]?.[0].event.idempotencyKey;
    expect(retryKey).toBe(failedKey);
  });

  it("dispatches again when a missing selector separates identical matches", async () => {
    const cursorStorePath = await tempCursorPath();
    const dispatchEvent = vi.fn(async () => ({
      wakes: [{ monitorId: "monitor-browser-1", enqueue: { ok: true, enqueued: true } }],
    }));
    let found = true;
    const readPage = async () => ({
      allowed: true,
      found,
      text: found ? "Replied: selector returned" : "",
      url: "https://example.test/thread/42",
    });

    await observeBrowserReplyOnce(baseConfig(cursorStorePath), { dispatchEvent, readPage });
    found = false;
    await expect(
      observeBrowserReplyOnce(baseConfig(cursorStorePath), { dispatchEvent, readPage }),
    ).resolves.toMatchObject({
      dispatched: false,
      found: false,
      matched: false,
      stateChanged: true,
    });
    found = true;
    await observeBrowserReplyOnce(baseConfig(cursorStorePath), { dispatchEvent, readPage });

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    const serialized = await fs.promises.readFile(cursorStorePath, "utf8");
    expect(serialized).not.toContain("selector returned");
  });

  it("persists only hashes and suppresses the same DOM state after restart", async () => {
    const cursorStorePath = await tempCursorPath();
    const dispatchEvent = vi.fn(async (_params: unknown) => ({
      wakes: [
        {
          monitorId: "monitor-browser-1",
          enqueue: { ok: true, enqueued: true },
        },
      ],
    }));
    const readPage = async () => ({
      allowed: true,
      found: true,
      text: "Replied: ship it",
      url: "https://example.test/thread/42",
    });

    const first = await observeBrowserReplyOnce(baseConfig(cursorStorePath), {
      dispatchEvent,
      nowMs: 1_720_000_000_000,
      readPage,
    });
    // A second call reloads the cursor from disk, matching process-restart behavior.
    const second = await observeBrowserReplyOnce(baseConfig(cursorStorePath), {
      dispatchEvent,
      nowMs: 1_720_000_001_000,
      readPage,
    });

    expect(first).toMatchObject({ dispatched: true, matched: true, stateChanged: true });
    expect(second).toMatchObject({ dispatched: false, matched: true, stateChanged: false });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const serialized = await fs.promises.readFile(cursorStorePath, "utf8");
    expect(serialized).not.toContain("ship it");
    expect(serialized).not.toContain("Replied");
    expect(serialized).not.toContain("data-test");
    const store = await loadBrowserReplyCursorStore(cursorStorePath);
    expect(Object.values(store.cursors)[0]).toMatchObject({
      lastStateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ruleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      transitionGeneration: 1,
      updatedAtMs: 1_720_000_000_000,
    });

    const dispatched = dispatchEvent.mock.calls[0]?.[0] as
      | { event?: Record<string, unknown> }
      | undefined;
    expect(JSON.stringify(dispatched)).not.toContain("ship it");
    expect(dispatched?.event).toMatchObject({
      triggerKind: "browser_observer",
      sourceType: "browser",
      eventType: "dom.text.matched",
      idempotencyKey: expect.stringMatching(/^browser:[a-f0-9]{64}$/),
      evidence: {
        found: true,
        matchMode: "contains",
        observedTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("does not advance the cursor unless the selected monitor wake is confirmed", async () => {
    const cursorStorePath = await tempCursorPath();
    const config = baseConfig(cursorStorePath);
    const readPage = async () => ({
      allowed: true,
      found: true,
      text: "Replied: retry me",
      url: "https://example.test/thread/42",
    });

    await expect(
      observeBrowserReplyOnce(config, {
        dispatchEvent: async () => ({ matched: 0, wakes: [] }),
        readPage,
      }),
    ).rejects.toThrow("did not confirm a monitor wake");
    await expect(fs.promises.access(cursorStorePath)).rejects.toMatchObject({ code: "ENOENT" });

    const dispatchEvent = vi.fn(async () => ({
      wakes: [{ monitorId: config.monitorId, enqueue: { ok: true, ran: true } }],
    }));
    await expect(
      observeBrowserReplyOnce(config, { dispatchEvent, readPage }),
    ).resolves.toMatchObject({ dispatched: true });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("aborts a timed-out in-lock dispatch and leaves the cursor absent", async () => {
    const cursorStorePath = await tempCursorPath();
    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatchEvent = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          markDispatchStarted();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    vi.useFakeTimers();
    try {
      const observation = observeBrowserReplyOnce(baseConfig(cursorStorePath), {
        dispatchEvent,
        dispatchTimeoutMs: 10,
        readPage: async () => ({
          allowed: true,
          found: true,
          text: "Replied: timeout",
          url: "https://example.test/thread/42",
        }),
      });
      await dispatchStarted;
      await vi.advanceTimersByTimeAsync(10);
      await expect(observation).rejects.toBeInstanceOf(BrowserReplyObserverDispatchTimeoutError);
      expect(dispatchEvent).toHaveBeenCalledOnce();
      await expect(fs.promises.access(cursorStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
    }
    expect(BROWSER_REPLY_DISPATCH_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("classifies an invalid CSS selector as permanent before cursor persistence", async () => {
    const cursorStorePath = await tempCursorPath();

    await expect(
      observeBrowserReplyOnce(baseConfig(cursorStorePath), {
        readPage: async () => ({
          allowed: true,
          configurationError: "invalid_selector",
          found: false,
          text: "",
          url: "https://example.test/thread/42",
        }),
      }),
    ).rejects.toBeInstanceOf(BrowserReplyObserverConfigurationError);
    await expect(fs.promises.access(cursorStorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent cursor transactions without dropping sibling cursors", async () => {
    const cursorStorePath = await tempCursorPath();
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstDispatch = vi.fn(async () => {
      markFirstEntered();
      await firstCanFinish;
      return {
        wakes: [{ monitorId: "monitor-browser-1", enqueue: { ok: true, enqueued: true } }],
      };
    });
    const secondDispatch = vi.fn(async () => ({
      wakes: [{ monitorId: "monitor-browser-2", enqueue: { ok: true, enqueued: true } }],
    }));
    const readPage = async () => ({
      allowed: true,
      found: true,
      text: "Replied: concurrent",
      url: "https://example.test/thread/42",
    });

    const first = observeBrowserReplyOnce(baseConfig(cursorStorePath), {
      dispatchEvent: firstDispatch,
      readPage,
    });
    await firstEntered;
    const second = observeBrowserReplyOnce(
      { ...baseConfig(cursorStorePath), monitorId: "monitor-browser-2" },
      { dispatchEvent: secondDispatch, readPage },
    );
    await new Promise((resolve) => setImmediate(resolve));

    // The second dispatch is inside the cursor transaction, so this proves it
    // cannot read and later overwrite the first observer's stale snapshot.
    expect(secondDispatch).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);

    expect(secondDispatch).toHaveBeenCalledOnce();
    const store = await loadBrowserReplyCursorStore(cursorStorePath);
    expect(Object.keys(store.cursors)).toHaveLength(2);
    expect(Object.keys(store.cursors)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("monitor:monitor-browser-1:"),
        expect.stringContaining("monitor:monitor-browser-2:"),
      ]),
    );
    await expect(fs.promises.access(`${cursorStorePath}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
