import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserDispatchResponse } from "./routes/dispatcher.js";

function okDispatchResponse(): BrowserDispatchResponse {
  return { status: 200, body: { ok: true } };
}

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    gateway: {
      auth: {
        token: "loopback-token",
      },
    },
  })),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (): Promise<BrowserDispatchResponse> => okDispatchResponse()),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: mocks.dispatch,
  })),
}));

import { browserAct } from "./client-actions.js";
import { fetchBrowserJson } from "./client-fetch.js";

function stubJsonFetchOk() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function expectThrownBrowserFetchError(
  request: () => Promise<unknown>,
  params: {
    contains: string[];
    omits?: string[];
  },
) {
  const thrown = await request().catch((err: unknown) => err);
  expect(thrown).toBeInstanceOf(Error);
  if (!(thrown instanceof Error)) {
    throw new Error(`Expected Error, got ${String(thrown)}`);
  }
  for (const snippet of params.contains) {
    expect(thrown.message).toContain(snippet);
  }
  for (const snippet of params.omits ?? []) {
    expect(thrown.message).not.toContain(snippet);
  }
  return thrown;
}

describe("fetchBrowserJson loopback auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    });
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue({ ok: true });
    mocks.dispatch.mockReset().mockResolvedValue(okDispatchResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds bearer auth for loopback absolute HTTP URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    const res = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/");
    expect(res.ok).toBe(true);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps caller-supplied auth header", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://localhost:18888/", {
      headers: {
        Authorization: "Bearer caller-token",
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-token");
  });

  it("injects auth for IPv6 loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("injects auth for IPv4-mapped IPv6 loopback URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::ffff:127.0.0.1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("reports dispatcher timeouts as browser operation timeouts", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Browser operation timed out", "Chrome CDP handshake timeout"],
      omits: [
        "Can't reach the OpenClaw browser control service",
        "Restart the OpenClaw gateway",
        "Do NOT retry the browser tool",
      ],
    });
  });

  it("bounds the entire dispatcher call when browser-control startup stalls", async () => {
    vi.useFakeTimers();
    try {
      mocks.startBrowserControlServiceFromConfig.mockImplementationOnce(
        () => new Promise(() => {}),
      );

      const request = fetchBrowserJson<{ ok: boolean }>("/act", {
        method: "POST",
        body: JSON.stringify({ kind: "press", ref: "1_153", key: "Enter" }),
        timeoutMs: 10_000,
      });
      const assertion = expect(request).rejects.toThrow(
        "Browser operation timed out inside the OpenClaw browser control service after 10000ms",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(mocks.dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles on time and observes a late dispatcher rejection", async () => {
    vi.useFakeTimers();
    try {
      let rejectDispatch: ((reason?: unknown) => void) | undefined;
      mocks.dispatch.mockImplementationOnce(
        () =>
          new Promise<BrowserDispatchResponse>((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      );

      const request = fetchBrowserJson<{ ok: boolean }>("/act", { timeoutMs: 100 });
      const assertion = expect(request).rejects.toThrow(
        "Browser operation timed out inside the OpenClaw browser control service after 100ms",
      );

      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      // The route may finish after the caller deadline if Chrome ignored abort.
      // Its rejection must remain observed rather than becoming unhandled.
      rejectDispatch?.(new Error("late Chrome MCP rejection"));
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a browser action alive for the existing-session readiness budget", async () => {
    vi.useFakeTimers();
    try {
      // Existing-session profiles are allowed 60 seconds to attach before a
      // default 45-second action runs. Model the full valid route sequence so
      // the public client contract, rather than internal constants, decides it.
      mocks.dispatch.mockImplementationOnce(
        () =>
          new Promise<BrowserDispatchResponse>((resolve) => {
            setTimeout(() => resolve(okDispatchResponse()), 105_000);
          }),
      );

      const request = browserAct(undefined, {
        kind: "click",
        ref: "button-1",
      });
      // Observe rejection immediately so the fake clock can cross the current
      // 45-second deadline without producing an unrelated unhandled rejection.
      const outcome = request.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      await vi.advanceTimersByTimeAsync(105_000);
      await expect(outcome).resolves.toMatchObject({
        status: "resolved",
        value: { ok: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves retryable chrome attach guidance without restart or no-retry hints", async () => {
    mocks.dispatch.mockRejectedValueOnce(
      new Error(
        'Chrome MCP existing-session attach for profile "user-live" timed out waiting for tabs to become available. Approve the browser attach prompt, keep the browser open, and retry.',
      ),
    );

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: [
        'Chrome MCP existing-session attach for profile "user-live"',
        "Approve the browser attach prompt",
      ],
      omits: [
        "Restart the OpenClaw gateway",
        "Do NOT retry the browser tool",
        "Can't reach the OpenClaw browser control service",
      ],
    });
  });

  it("preserves closed remote-debugging connection guidance without generic gateway text", async () => {
    mocks.dispatch.mockRejectedValueOnce(
      new Error(
        'Chrome MCP existing-session attach failed for profile "user-live". Chrome closed the remote-debugging connection during the approval handshake. Keep Chrome open, click Allow if prompted, or enable remote debugging at chrome://inspect/#remote-debugging, then retry. Details: MCP error -32000: Connection closed',
      ),
    );

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: [
        "Chrome closed the remote-debugging connection during the approval handshake",
        "chrome://inspect/#remote-debugging",
      ],
      omits: [
        "Restart the OpenClaw gateway",
        "Do NOT retry the browser tool",
        "Can't reach the OpenClaw browser control service",
      ],
    });
  });

  it("keeps generic user-live dispatcher action timeouts out of approval guidance", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("timed out"));

    await expectThrownBrowserFetchError(
      () =>
        fetchBrowserJson<{ ok: boolean }>("/act?profile=user-live", {
          method: "POST",
          body: JSON.stringify({ kind: "click", ref: "e1" }),
        }),
      {
        contains: ["Browser operation timed out", "timed out"],
        omits: ["Chrome is waiting for remote-debugging approval", "click Allow if prompted"],
      },
    );
  });

  it("maps attach-like user-live timeouts to remote-debugging approval guidance", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Network.enable timed out"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs?profile=user-live"),
      {
        contains: [
          "Chrome is waiting for remote-debugging approval",
          "chrome://inspect/#remote-debugging",
          "click Allow if prompted",
        ],
        omits: [
          "Restart the OpenClaw gateway",
          "Do NOT retry the browser tool",
          "Can't reach the OpenClaw browser control service",
        ],
      },
    );
  });

  it("keeps generic user-live absolute loopback timeouts out of approval guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await expectThrownBrowserFetchError(
      () =>
        fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/tabs/open?profile=user-live", {
          timeoutMs: 1,
        }),
      {
        contains: [
          "Can't reach the OpenClaw browser control service",
          "Do NOT retry the browser tool",
        ],
        omits: ["Chrome is waiting for remote-debugging approval", "click Allow if prompted"],
      },
    );
  });

  it("keeps generic user-live absolute loopback service timeouts out of approval guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("timed out", { status: 504 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/tabs/open?profile=user-live"),
      {
        contains: ["timed out"],
        omits: ["Chrome is waiting for remote-debugging approval", "click Allow if prompted"],
      },
    );
  });

  it("keeps non-user-live dispatcher timeouts out of gateway-restart guidance", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("timed out"));

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("/tabs/open?profile=openclaw"),
      {
        contains: ["Browser operation timed out", "timed out"],
        omits: [
          "Restart the OpenClaw gateway",
          "Do NOT retry the browser tool",
          "Chrome is waiting for remote-debugging approval",
          "chrome://inspect/#remote-debugging",
        ],
      },
    );
  });

  it("surfaces 429 from HTTP URL as rate-limit error with no-retry hint", async () => {
    const response = new Response("max concurrent sessions exceeded", { status: 429 });
    const text = vi.spyOn(response, "text");
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["Browser service rate limit reached", "Do NOT retry the browser tool"],
        omits: ["max concurrent sessions exceeded"],
      },
    );
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("surfaces 429 from HTTP URL without body detail when empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["rate limit reached", "Do NOT retry the browser tool"],
      },
    );
  });

  it("keeps Browserbase-specific wording for Browserbase 429 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("max concurrent sessions exceeded", { status: 429 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("https://connect.browserbase.com/session"),
      {
        contains: ["Browserbase rate limit reached", "upgrade your plan"],
        omits: ["max concurrent sessions exceeded"],
      },
    );
  });

  it("non-429 errors still produce generic messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/"),
      {
        contains: ["internal error"],
        omits: ["rate limit"],
      },
    );
  });

  it("surfaces 429 from dispatcher path as rate-limit error", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 429,
      body: { error: "too many sessions" },
    });

    await expectThrownBrowserFetchError(() => fetchBrowserJson<{ ok: boolean }>("/tabs"), {
      contains: ["Browser service rate limit reached", "Do NOT retry the browser tool"],
      omits: ["too many sessions"],
    });
  });

  it("keeps absolute URL failures wrapped as reachability errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    await expectThrownBrowserFetchError(
      () => fetchBrowserJson<{ ok: boolean }>("http://example.com/"),
      {
        contains: [
          "Can't reach the OpenClaw browser control service",
          "Do NOT retry the browser tool",
        ],
      },
    );
  });
});
