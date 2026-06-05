import { type RunOptions, run } from "@grammyjs/runner";
import type { ChannelAccountSnapshot } from "../../../src/channels/plugins/types.js";
import { computeBackoff, sleepWithAbort } from "../../../src/infra/backoff.js";
import { formatErrorMessage } from "../../../src/infra/errors.js";
import { formatDurationPrecise } from "../../../src/infra/format-time/format-duration.ts";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const TELEGRAM_POLL_STOP_TIMEOUT_POLICY = {
  initialMs: 10_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.15,
};

const POLL_STALL_THRESHOLD_MS = 90_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;
const POLL_STOP_GRACE_MS = 15_000;
const POLL_STALL_ESCALATION_LIMIT = 2;
const POLL_STOP_TIMEOUT_ESCALATION_LIMIT = 3;

const waitForGracefulStop = async (
  stop: () => Promise<void>,
): Promise<"completed" | "timed-out"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      stop(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, POLL_STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  return timedOut ? "timed-out" : "completed";
};

type TelegramBot = ReturnType<typeof createTelegramBot>;
type TelegramPollingOutcome =
  | "started"
  | "in-flight"
  | "completed"
  | "error"
  | "aborted"
  | "stalled"
  | "conflict"
  | "unhealthy";

type TelegramPollingSessionOpts = {
  token: string;
  config: Parameters<typeof createTelegramBot>[0]["config"];
  accountId: string;
  runtime: Parameters<typeof createTelegramBot>[0]["runtime"];
  proxyFetch: Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  proxyFetchFactory?: () => Parameters<typeof createTelegramBot>[0]["proxyFetch"];
  abortSignal?: AbortSignal;
  runnerOptions: RunOptions<unknown>;
  getLastUpdateId: () => number | null;
  persistUpdateId: (updateId: number) => Promise<void>;
  log: (line: string) => void;
  setStatus?: (next: Partial<ChannelAccountSnapshot>) => void;
};

export class TelegramPollingSession {
  #restartAttempts = 0;
  #webhookCleared = false;
  #forceRestarted = false;
  #activeRunner: ReturnType<typeof run> | undefined;
  #activeFetchAbort: AbortController | undefined;
  #consecutiveStalls = 0;
  #stopTimeoutBursts = 0;
  #transportGeneration = 0;
  #pollStartedCount = 0;
  #pollCompletedCount = 0;
  #pollInFlight = 0;
  #lastPollStartedAt: number | null = null;
  #lastPollCompletedAt: number | null = null;
  #lastPollOutcome: TelegramPollingOutcome | null = null;
  #lastPollError: string | null = null;
  #lastPollDurationMs: number | null = null;
  #lastStallAt: number | null = null;
  #lastStopTimeoutAt: number | null = null;
  #watchdogEscalation: string | null = null;

  constructor(private readonly opts: TelegramPollingSessionOpts) {}

  get activeRunner() {
    return this.#activeRunner;
  }

  markForceRestarted() {
    this.#forceRestarted = true;
  }

  abortActiveFetch() {
    this.#activeFetchAbort?.abort();
  }

  #buildTransportActivity(): NonNullable<ChannelAccountSnapshot["transportActivity"]> {
    return {
      mode: "polling",
      active: this.#pollInFlight > 0,
      inFlight: this.#pollInFlight,
      startedCount: this.#pollStartedCount,
      completedCount: this.#pollCompletedCount,
      lastStartedAt: this.#lastPollStartedAt,
      lastCompletedAt: this.#lastPollCompletedAt,
      lastOutcome: this.#lastPollOutcome,
      lastError: this.#lastPollError,
      lastDurationMs: this.#lastPollDurationMs,
      transportGeneration: this.#transportGeneration,
      restartAttempts: this.#restartAttempts,
      stallCount: this.#consecutiveStalls,
      stopTimeoutCount: this.#stopTimeoutBursts,
      watchdog: {
        lastStallAt: this.#lastStallAt,
        lastStopTimeoutAt: this.#lastStopTimeoutAt,
        escalation: this.#watchdogEscalation,
      },
    };
  }

  #publishStatus(next: Partial<ChannelAccountSnapshot>) {
    this.opts.setStatus?.({
      accountId: this.opts.accountId,
      mode: "polling",
      transportActivity: this.#buildTransportActivity(),
      ...next,
    });
  }

  #publishPollingStatus(next: Partial<ChannelAccountSnapshot> = {}) {
    this.#publishStatus({
      pollingInFlight: this.#pollInFlight > 0,
      lastPollStartedAt: this.#lastPollStartedAt,
      lastPollCompletedAt: this.#lastPollCompletedAt,
      lastPollOutcome: this.#lastPollOutcome,
      lastTransportActivityAt: this.#lastPollCompletedAt ?? this.#lastPollStartedAt,
      ...next,
    });
  }

  async runUntilAbort(): Promise<void> {
    while (!this.opts.abortSignal?.aborted) {
      const bot = await this.#createPollingBot();
      if (!bot) {
        continue;
      }

      const cleanupState = await this.#ensureWebhookCleanup(bot);
      if (cleanupState === "retry") {
        continue;
      }
      if (cleanupState === "exit") {
        return;
      }

      const state = await this.#runPollingCycle(bot);
      if (state === "exit") {
        return;
      }
    }
  }

  async #waitBeforeRestart(buildLine: (delay: string) => string): Promise<boolean> {
    this.#restartAttempts += 1;
    const restartDelayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
    const stopTimeoutDelayMs =
      this.#stopTimeoutBursts > 0
        ? computeBackoff(TELEGRAM_POLL_STOP_TIMEOUT_POLICY, this.#stopTimeoutBursts)
        : 0;
    const delayMs = Math.max(restartDelayMs, stopTimeoutDelayMs);
    const delay = formatDurationPrecise(delayMs);
    this.#publishPollingStatus();
    this.opts.log(buildLine(delay));
    try {
      await sleepWithAbort(delayMs, this.opts.abortSignal);
    } catch (sleepErr) {
      if (this.opts.abortSignal?.aborted) {
        return false;
      }
      throw sleepErr;
    }
    return true;
  }

  async #waitBeforeRetryOnRecoverableSetupError(err: unknown, logPrefix: string): Promise<boolean> {
    if (this.opts.abortSignal?.aborted) {
      return false;
    }
    if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) {
      throw err;
    }
    return this.#waitBeforeRestart(
      (delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`,
    );
  }

  async #createPollingBot(): Promise<TelegramBot | undefined> {
    const fetchAbortController = new AbortController();
    this.#activeFetchAbort = fetchAbortController;
    this.#transportGeneration += 1;
    this.#watchdogEscalation = null;
    this.#publishPollingStatus({
      connected: false,
      lastError: null,
    });
    try {
      return createTelegramBot({
        token: this.opts.token,
        runtime: this.opts.runtime,
        // Rebuild resolver-owned Telegram transport for every polling cycle.
        // Stalled undici keep-alive dispatchers can otherwise survive a bot
        // restart and keep failing after DNS/network recovery.
        proxyFetch: this.opts.proxyFetchFactory?.() ?? this.opts.proxyFetch,
        config: this.opts.config,
        accountId: this.opts.accountId,
        fetchAbortSignal: fetchAbortController.signal,
        updateOffset: {
          lastUpdateId: this.opts.getLastUpdateId(),
          onUpdateId: this.opts.persistUpdateId,
        },
      });
    } catch (err) {
      await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
      return undefined;
    }
  }

  async #ensureWebhookCleanup(bot: TelegramBot): Promise<"ready" | "retry" | "exit"> {
    if (this.#webhookCleared) {
      return "ready";
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "deleteWebhook",
        runtime: this.opts.runtime,
        fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
      });
      this.#webhookCleared = true;
      return "ready";
    } catch (err) {
      const shouldRetry = await this.#waitBeforeRetryOnRecoverableSetupError(
        err,
        "Telegram webhook cleanup failed",
      );
      return shouldRetry ? "retry" : "exit";
    }
  }

  async #runPollingCycle(bot: TelegramBot): Promise<"continue" | "exit"> {
    let lastGetUpdatesAt = Date.now();
    this.#lastPollOutcome = "started";
    this.#publishPollingStatus({
      connected: true,
      lastError: null,
    });
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "getUpdates") {
        const startedAt = Date.now();
        lastGetUpdatesAt = startedAt;
        this.#pollInFlight += 1;
        this.#pollStartedCount += 1;
        this.#lastPollStartedAt = startedAt;
        this.#lastPollOutcome = "in-flight";
        this.#lastPollError = null;
        this.#publishPollingStatus({
          connected: true,
          lastError: null,
        });
        try {
          const result = await prev(method, payload, signal);
          this.#recordPollCompletion("completed", startedAt);
          return result;
        } catch (err) {
          this.#recordPollCompletion(
            isAbortLikeError(err, signal) ? "aborted" : "error",
            startedAt,
            err,
          );
          throw err;
        }
      }
      return prev(method, payload, signal);
    });

    const runner = run(bot, this.opts.runnerOptions);
    this.#activeRunner = runner;
    const fetchAbortController = this.#activeFetchAbort;
    let stopPromise: Promise<void> | undefined;
    let stalledRestart = false;
    let stopTimedOut = false;
    let forceCycleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCycleResolve: (() => void) | undefined;
    const forceCyclePromise = new Promise<void>((resolve) => {
      forceCycleResolve = resolve;
    });
    const stopRunner = () => {
      fetchAbortController?.abort();
      stopPromise ??= Promise.resolve(runner.stop())
        .then(() => undefined)
        .catch(() => {
          // Runner may already be stopped by abort/retry paths.
        });
      return stopPromise;
    };
    const stopBot = () => {
      return Promise.resolve(bot.stop())
        .then(() => undefined)
        .catch(() => {
          // Bot may already be stopped by runner stop/abort paths.
        });
    };
    const stopOnAbort = () => {
      if (this.opts.abortSignal?.aborted) {
        void stopRunner();
      }
    };

    const watchdog = setInterval(() => {
      if (this.opts.abortSignal?.aborted) {
        return;
      }
      if (stalledRestart) {
        return;
      }
      const elapsed = Date.now() - lastGetUpdatesAt;
      if (elapsed > POLL_STALL_THRESHOLD_MS && runner.isRunning()) {
        stalledRestart = true;
        this.#consecutiveStalls += 1;
        this.#lastPollOutcome = "stalled";
        this.#lastPollError = `Polling stall detected (${this.#pollInFlight > 0 ? "getUpdates in-flight" : "no completed getUpdates"} for ${formatDurationPrecise(elapsed)})`;
        this.#lastStallAt = Date.now();
        this.#watchdogEscalation =
          this.#consecutiveStalls >= POLL_STALL_ESCALATION_LIMIT
            ? `telegram polling stalled ${this.#consecutiveStalls} consecutive time(s)`
            : null;
        this.#publishPollingStatus({
          connected: false,
          lastError: this.#watchdogEscalation ?? this.#lastPollError,
        });
        this.opts.log(
          `[telegram] Polling stall detected (no getUpdates for ${formatDurationPrecise(elapsed)}); forcing restart.`,
        );
        void stopRunner();
        void stopBot();
        if (!forceCycleTimer) {
          forceCycleTimer = setTimeout(() => {
            if (this.opts.abortSignal?.aborted) {
              return;
            }
            this.opts.log(
              `[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`,
            );
            stopTimedOut = true;
            this.#stopTimeoutBursts += 1;
            this.#lastStopTimeoutAt = Date.now();
            this.#watchdogEscalation =
              this.#stopTimeoutBursts >= POLL_STOP_TIMEOUT_ESCALATION_LIMIT
                ? `telegram polling stop timed out ${this.#stopTimeoutBursts} consecutive time(s)`
                : this.#watchdogEscalation;
            this.#publishPollingStatus({
              connected: false,
              lastError:
                this.#watchdogEscalation ??
                `polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}`,
            });
            forceCycleResolve?.();
          }, POLL_STOP_GRACE_MS);
        }
      }
    }, POLL_WATCHDOG_INTERVAL_MS);

    this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      await Promise.race([runner.task(), forceCyclePromise]);
      if (this.opts.abortSignal?.aborted) {
        return "exit";
      }
      const reason = stalledRestart
        ? "polling stall detected"
        : this.#forceRestarted
          ? "unhandled network error"
          : "runner stopped (maxRetryTime exceeded or graceful stop)";
      this.#forceRestarted = false;
      if (stalledRestart) {
        const shouldEscalate =
          this.#consecutiveStalls >= POLL_STALL_ESCALATION_LIMIT ||
          (stopTimedOut && this.#stopTimeoutBursts >= POLL_STOP_TIMEOUT_ESCALATION_LIMIT);
        if (shouldEscalate) {
          const escalationReason = stopTimedOut
            ? "repeated polling stop timeouts"
            : "repeated polling stalls";
          const message = `Telegram polling unhealthy: ${escalationReason}`;
          this.#lastPollOutcome = "unhealthy";
          this.#lastPollError = message;
          this.#watchdogEscalation = message;
          this.#publishPollingStatus({
            connected: false,
            lastError: message,
          });
          throw new Error(message);
        }
      } else {
        this.#consecutiveStalls = 0;
        this.#stopTimeoutBursts = 0;
        this.#watchdogEscalation = null;
      }
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } catch (err) {
      this.#forceRestarted = false;
      if (this.opts.abortSignal?.aborted) {
        throw err;
      }
      const isConflict = isGetUpdatesConflict(err);
      if (isConflict) {
        this.#webhookCleared = false;
      }
      const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
      if (!isConflict && !isRecoverable) {
        throw err;
      }
      this.#lastPollOutcome = isConflict ? "conflict" : "error";
      this.#lastPollError = formatErrorMessage(err);
      this.#publishPollingStatus({
        connected: false,
        lastError: this.#lastPollError,
      });
      const reason = isConflict ? "getUpdates conflict" : "network error";
      const errMsg = formatErrorMessage(err);
      const shouldRestart = await this.#waitBeforeRestart(
        (delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`,
      );
      return shouldRestart ? "continue" : "exit";
    } finally {
      clearInterval(watchdog);
      if (forceCycleTimer) {
        clearTimeout(forceCycleTimer);
      }
      this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      const runnerStop = await waitForGracefulStop(stopRunner);
      const botStop = await waitForGracefulStop(stopBot);
      if (!stopTimedOut && (runnerStop === "timed-out" || botStop === "timed-out")) {
        this.#stopTimeoutBursts += 1;
        this.#lastStopTimeoutAt = Date.now();
        this.#watchdogEscalation =
          this.#stopTimeoutBursts >= POLL_STOP_TIMEOUT_ESCALATION_LIMIT
            ? `telegram polling cleanup timed out ${this.#stopTimeoutBursts} consecutive time(s)`
            : this.#watchdogEscalation;
        this.#publishPollingStatus({
          connected: false,
          lastError:
            this.#watchdogEscalation ??
            `polling cleanup timed out (runner=${runnerStop}, bot=${botStop})`,
        });
      }
      this.#activeRunner = undefined;
      if (this.#activeFetchAbort === fetchAbortController) {
        this.#activeFetchAbort = undefined;
      }
    }
  }

  #recordPollCompletion(
    outcome: "completed" | "error" | "aborted",
    startedAt: number,
    err?: unknown,
  ) {
    const completedAt = Date.now();
    this.#pollInFlight = Math.max(0, this.#pollInFlight - 1);
    this.#pollCompletedCount += 1;
    this.#lastPollCompletedAt = completedAt;
    this.#lastPollOutcome = outcome;
    this.#lastPollError = outcome === "completed" ? null : formatErrorMessage(err);
    this.#lastPollDurationMs = Math.max(0, completedAt - startedAt);
    if (outcome === "completed") {
      // A completed getUpdates request is transport liveness even when Telegram
      // returns zero user messages. Reset watchdog counters so quiet chats stay
      // healthy without changing auth, allowlist, group, topic, or command flow.
      this.#restartAttempts = 0;
      this.#consecutiveStalls = 0;
      this.#stopTimeoutBursts = 0;
      this.#lastStallAt = null;
      this.#lastStopTimeoutAt = null;
      this.#watchdogEscalation = null;
    }
    this.#publishPollingStatus({
      connected: outcome === "completed",
      lastError: this.#lastPollError,
    });
  }
}

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

const isAbortLikeError = (err: unknown, signal?: { aborted?: boolean }) => {
  if (signal?.aborted) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as { name?: string; code?: string };
  return typed.name === "AbortError" || typed.code === "ABORT_ERR";
};
