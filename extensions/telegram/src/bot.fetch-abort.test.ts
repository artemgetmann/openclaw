import { afterEach, describe, expect, it, vi } from "vitest";
import { botCtorSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";
import { getTelegramNetworkErrorOrigin } from "./network-errors.js";

function createWrappedTelegramClientFetch(
  proxyFetch: typeof fetch,
  options?: Partial<Parameters<typeof createTelegramBot>[0]>,
) {
  const shutdown = new AbortController();
  botCtorSpy.mockClear();
  createTelegramBot({
    token: "tok",
    fetchAbortSignal: shutdown.signal,
    proxyFetch,
    ...options,
  });
  const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
    ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
  expect(clientFetch).toBeTypeOf("function");
  return { clientFetch, shutdown };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTelegramBot fetch abort", () => {
  it("aborts wrapped client fetch when fetchAbortSignal aborts", async () => {
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch, shutdown } = createWrappedTelegramClientFetch(
      fetchSpy as unknown as typeof fetch,
    );

    const observedSignalPromise = clientFetch("https://example.test");
    shutdown.abort(new Error("shutdown"));
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
  });

  it("tags wrapped Telegram fetch failures with the Bot API method", async () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const fetchSpy = vi.fn(async () => {
      throw fetchError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      fetchError,
    );
    expect(getTelegramNetworkErrorOrigin(fetchError)).toEqual({
      method: "getupdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates",
    });
  });

  it("caps long-polling getUpdates independently from the general Telegram API timeout", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch, {
      config: {
        channels: {
          telegram: {
            timeoutSeconds: 600,
          },
        },
      },
    });

    const observedSignalPromise = clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates");
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal.aborted).toBe(true);
    expect(observedSignal.reason).toBeInstanceOf(Error);
    expect((observedSignal.reason as Error).message).toContain(
      "telegram getUpdates fetch timed out",
    );
  });

  it("does not apply the getUpdates cap to normal Telegram sends", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch, shutdown } = createWrappedTelegramClientFetch(
      fetchSpy as unknown as typeof fetch,
    );

    const observedSignalPromise = clientFetch("https://api.telegram.org/bot123456:ABC/sendMessage");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(false);

    shutdown.abort(new Error("shutdown"));
    const observedSignal = (await observedSignalPromise) as AbortSignal;
    expect(observedSignal.aborted).toBe(true);
    expect((observedSignal.reason as Error).message).toBe("shutdown");
  });

  it("preserves the original fetch error when tagging cannot attach metadata", async () => {
    const frozenError = Object.freeze(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect timeout"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    );
    const fetchSpy = vi.fn(async () => {
      throw frozenError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      frozenError,
    );
    expect(getTelegramNetworkErrorOrigin(frozenError)).toBeNull();
  });
});
