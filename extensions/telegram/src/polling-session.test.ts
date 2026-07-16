import { type RunOptions } from "@grammyjs/runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot } from "../../../src/channels/plugins/types.js";
import { classifyTelegramPollingWatchdogTick, TelegramPollingSession } from "./polling-session.js";

const createTelegramBotMock = vi.hoisted(() => vi.fn());
const waitForTelegramBotTransportCloseMock = vi.hoisted(() =>
  vi.fn<(bot: object) => Promise<void>>(async () => undefined),
);
const runMock = vi.hoisted(() => vi.fn());

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
  waitForTelegramBotTransportClose: waitForTelegramBotTransportCloseMock,
}));

vi.mock("@grammyjs/runner", async () => {
  const actual = await vi.importActual<typeof import("@grammyjs/runner")>("@grammyjs/runner");
  return {
    ...actual,
    run: runMock,
  };
});

type TestBot = {
  api: {
    deleteWebhook: ReturnType<typeof vi.fn>;
    config: { use: ReturnType<typeof vi.fn> };
  };
  stop: ReturnType<typeof vi.fn>;
};

function makeBot(deleteWebhook: () => Promise<unknown>): TestBot {
  return {
    api: {
      deleteWebhook: vi.fn(deleteWebhook),
      config: { use: vi.fn() },
    },
    stop: vi.fn(async () => undefined),
  };
}

function makeRecoverableNetworkError(code = "ETIMEDOUT"): Error {
  const socketError = Object.assign(new Error(`connect ${code} api.telegram.org:443`), { code });
  return Object.assign(new TypeError("fetch failed"), { cause: socketError });
}

function createSession(
  abortSignal: AbortSignal,
  setStatus?: (next: Partial<ChannelAccountSnapshot>) => void,
  log: (line: string) => void = vi.fn(),
): TelegramPollingSession {
  return new TelegramPollingSession({
    token: "test-token",
    config: {},
    accountId: "default",
    runtime: undefined,
    proxyFetch: undefined,
    abortSignal,
    runnerOptions: {} as RunOptions<unknown>,
    getLastUpdateId: () => null,
    persistUpdateId: async () => undefined,
    log,
    setStatus,
  });
}

afterEach(() => {
  createTelegramBotMock.mockReset();
  waitForTelegramBotTransportCloseMock.mockClear();
  runMock.mockReset();
  vi.useRealTimers();
});

describe("TelegramPollingSession", () => {
  it("starts polling on the same bot after recoverable webhook cleanup failure", async () => {
    const abort = new AbortController();
    let finishTransportClose: (() => void) | undefined;
    waitForTelegramBotTransportCloseMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTransportClose = resolve;
        }),
    );
    const bot = makeBot(async () => {
      throw makeRecoverableNetworkError();
    });
    createTelegramBotMock.mockReturnValueOnce(bot).mockImplementationOnce(() => {
      throw new Error("unexpected second bot after recoverable deleteWebhook failure");
    });
    runMock.mockReturnValue({
      task: async () => {
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    });

    let sessionSettled = false;
    const sessionRun = createSession(abort.signal)
      .runUntilAbort()
      .then(() => {
        sessionSettled = true;
      });
    await vi.waitFor(() => expect(waitForTelegramBotTransportCloseMock).toHaveBeenCalledWith(bot));
    expect(sessionSettled).toBe(false);
    finishTransportClose?.();
    await sessionRun;

    expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(createTelegramBotMock).toHaveBeenCalledTimes(1);
    expect(createTelegramBotMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", transportGeneration: 1 }),
    );
    expect(runMock).toHaveBeenCalledWith(bot, expect.any(Object));
  });

  it("keeps successful getUpdates proof while the next long poll is in flight", async () => {
    const abort = new AbortController();
    const statuses: Partial<ChannelAccountSnapshot>[] = [];
    const bot = makeBot(async () => undefined);
    createTelegramBotMock.mockReturnValue(bot);

    let finishSecondPoll: (() => void) | undefined;
    let markSecondPollStarted: (() => void) | undefined;
    const secondPollStarted = new Promise<void>((resolve) => {
      markSecondPollStarted = resolve;
    });
    runMock.mockImplementation(() => ({
      task: async () => {
        const middleware = bot.api.config.use.mock.calls[0]?.[0] as (
          prev: () => Promise<unknown>,
          method: string,
          payload: unknown,
          signal?: AbortSignal,
        ) => Promise<unknown>;
        await middleware(async () => [], "getUpdates", {});
        const secondPoll = middleware(
          () =>
            new Promise<unknown>((resolve) => {
              finishSecondPoll = () => resolve([]);
              markSecondPollStarted?.();
            }),
          "getUpdates",
          {},
        );
        await secondPoll;
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    }));

    const sessionRun = createSession(abort.signal, (status) =>
      statuses.push(status),
    ).runUntilAbort();
    await secondPollStarted;

    const firstSuccess = statuses.find((status) => status.lastPollOutcome === "completed");
    const nextInFlight = statuses.at(-1);
    expect(firstSuccess?.lastPollSuccessAt).toEqual(expect.any(Number));
    expect(nextInFlight).toMatchObject({
      pollingInFlight: true,
      lastPollOutcome: "in-flight",
      lastPollSuccessAt: firstSuccess?.lastPollSuccessAt,
    });

    finishSecondPoll?.();
    await sessionRun;
  });

  it("classifies a materially late watchdog tick separately from network idle time", () => {
    const result = classifyTelegramPollingWatchdogTick({
      nowMs: 250_000,
      lastTickAtMs: 30_000,
      lastGetUpdatesAtMs: 10_000,
      watchdogIntervalMs: 30_000,
      stallThresholdMs: 90_000,
    });

    expect(result).toEqual({
      kind: "event-loop-delay",
      pollIdleMs: 240_000,
      timerGapMs: 220_000,
      timerDelayMs: 190_000,
      timerMateriallyLate: true,
    });
  });

  it("keeps a recent successful poll healthy when the watchdog callback runs late", () => {
    const result = classifyTelegramPollingWatchdogTick({
      nowMs: 250_000,
      lastTickAtMs: 30_000,
      lastGetUpdatesAtMs: 240_000,
      watchdogIntervalMs: 30_000,
      stallThresholdMs: 90_000,
    });

    expect(result).toEqual({
      kind: "healthy",
      pollIdleMs: 10_000,
      timerGapMs: 220_000,
      timerDelayMs: 190_000,
      timerMateriallyLate: true,
    });
  });

  it("keeps an on-time watchdog stall classified as polling inactivity", () => {
    const result = classifyTelegramPollingWatchdogTick({
      nowMs: 120_001,
      lastTickAtMs: 90_000,
      lastGetUpdatesAtMs: 0,
      watchdogIntervalMs: 30_000,
      stallThresholdMs: 90_000,
    });

    expect(result).toEqual({
      kind: "polling-stall",
      pollIdleMs: 120_001,
      timerGapMs: 30_001,
      timerDelayMs: 1,
      timerMateriallyLate: false,
    });
  });

  it("records a delayed watchdog tick without stopping when fresh polling evidence follows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const abort = new AbortController();
    const statuses: Partial<ChannelAccountSnapshot>[] = [];
    const log = vi.fn();
    const bot = makeBot(async () => undefined);
    createTelegramBotMock.mockReturnValue(bot);

    let finishRunner: (() => void) | undefined;
    const runnerTask = new Promise<void>((resolve) => {
      finishRunner = resolve;
    });
    const stop = vi.fn(async () => finishRunner?.());
    runMock.mockReturnValue({
      task: () => runnerTask,
      stop,
      isRunning: () => true,
    });

    const sessionRun = createSession(
      abort.signal,
      (status) => statuses.push(status),
      log,
    ).runUntilAbort();
    await vi.advanceTimersByTimeAsync(0);
    expect(runMock).toHaveBeenCalledTimes(1);

    // Move wall time forward without running the interval, then fire its next
    // scheduled callback. This deterministically models sleep/event-loop starvation.
    vi.setSystemTime(150_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(stop).not.toHaveBeenCalled();
    expect(bot.stop).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      lastPollOutcome: "started",
      transportActivity: {
        lastError: null,
        stallCount: 0,
        watchdog: {
          lastStallAt: null,
          lastTimerGapAt: 180_000,
          lastTimerGapMs: 180_000,
          timerDelayMs: 150_000,
          escalation: null,
        },
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("gateway event-loop starvation"));

    const middleware = bot.api.config.use.mock.calls[0]?.[0] as (
      prev: () => Promise<unknown>,
      method: string,
      payload: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    await middleware(async () => [], "getUpdates", {});
    await vi.advanceTimersByTimeAsync(30_000);

    expect(stop).not.toHaveBeenCalled();
    expect(bot.stop).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      connected: true,
      lastPollOutcome: "completed",
      transportActivity: {
        stallCount: 0,
        watchdog: {
          lastStallAt: null,
          lastTimerGapAt: null,
          lastTimerGapMs: null,
          timerDelayMs: null,
          escalation: null,
        },
      },
    });

    abort.abort();
    await sessionRun;
  });

  it("waits for a timely watchdog tick before confirming a stall after a delayed tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const abort = new AbortController();
    const statuses: Partial<ChannelAccountSnapshot>[] = [];
    const bot = makeBot(async () => undefined);
    createTelegramBotMock.mockReturnValue(bot);

    let finishRunner: (() => void) | undefined;
    const runnerTask = new Promise<void>((resolve) => {
      finishRunner = resolve;
    });
    const stop = vi.fn(async () => finishRunner?.());
    runMock.mockReturnValue({
      task: () => runnerTask,
      stop,
      isRunning: () => true,
    });

    const sessionRun = createSession(abort.signal, (status) =>
      statuses.push(status),
    ).runUntilAbort();
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(150_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stop).not.toHaveBeenCalled();
    expect(bot.stop).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      lastPollOutcome: "started",
      transportActivity: {
        lastError: null,
        stallCount: 0,
        watchdog: { lastStallAt: null, escalation: null },
      },
    });

    // The next interval is timely relative to the delayed callback. With no
    // intervening getUpdates activity, it can now attribute the idle period to
    // polling and enter the existing recovery path.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(bot.stop).toHaveBeenCalledTimes(1);
    expect(statuses.findLast((status) => status.connected === false)).toMatchObject({
      connected: false,
      lastPollOutcome: "stalled",
      transportActivity: {
        stallCount: 1,
        watchdog: { lastStallAt: 210_000, escalation: null },
      },
    });

    abort.abort();
    await sessionRun;
  });
});
