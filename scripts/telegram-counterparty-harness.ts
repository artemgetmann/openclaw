#!/usr/bin/env -S node --import tsx

/**
 * Deterministic, non-AI Telegram counterparty for GA-LIVE-20260724-01.
 *
 * The harness owns exactly one tester-bot reservation and one Telegram user
 * chat. Preflight performs the same durable safe-reuse transaction as the
 * production poller. Every later command is a literal state transition; there
 * is no generated text and no way to select another recipient.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  readTelegramSafeReuseFenceState,
  resolveTelegramSafeReuseFenceRequest,
  writeCompletedTelegramSafeReuseFence,
  writePendingTelegramSafeReuseFence,
  writeReadingTelegramSafeReuseFence,
} from "../extensions/telegram/src/safe-reuse-fence-store.js";
import {
  runTelegramSafeReuseFenceTransaction,
  TelegramSafeReuseManualRecoveryError,
} from "../extensions/telegram/src/safe-reuse-fence.js";
import { validateTelegramTesterScenarioReservation } from "../src/infra/telegram-tester-scenario-reservation.js";
import { acquireTelegramTokenLease } from "../src/infra/telegram-token-lease.js";

export const COUNTERPARTY_BOT_USERNAME = "Artem_jarvis_email_bot";
export const COUNTERPARTY_ARTEM_USER_ID = "1336356696";
export const COUNTERPARTY_SCENARIO_ID = "GA-LIVE-20260724-01-counterparty";

export const COUNTERPARTY_TEXT = {
  nonmatch: "GA-LIVE-20260724-01 NONMATCH kind=unrelated-weather",
  inScope: "GA-LIVE-20260724-01 IN_SCOPE status=READY reply_exact=GA-LIVE-20260724-01 ACK READY",
  inScopeReply: "GA-LIVE-20260724-01 ACK READY",
  approval:
    "GA-LIVE-20260724-01 APPROVAL_REQUIRED change=SYNTHETIC_COMMITMENT reply_exact=GA-LIVE-20260724-01 APPROVED CONTINUE",
  approvalReply: "GA-LIVE-20260724-01 APPROVED CONTINUE",
  completion: "GA-LIVE-20260724-01 COMPLETE evidence=FRESH_AFTER_RESTART",
} as const;

const ENV = {
  artemUserId: "OPENCLAW_COUNTERPARTY_ARTEM_USER_ID",
  token: "OPENCLAW_COUNTERPARTY_TELEGRAM_BOT_TOKEN",
  reservationRoot: "OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT",
  scenarioId: "OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID",
  generation: "OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION",
  tokenHash: "OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH",
  worktree: "OPENCLAW_TELEGRAM_TESTER_WORKTREE",
} as const;

export type CounterpartyCommand =
  | "preflight"
  | "emit-nonmatch"
  | "assert-nonmatch-silence"
  | "emit-in-scope"
  | "wait-in-scope-reply"
  | "emit-approval"
  | "assert-approval-silence"
  | "wait-approved-reply"
  | "mark-restart-boundary"
  | "emit-completion";

export type CounterpartyStage =
  | "new"
  | "preflight_complete"
  | "nonmatch_sending"
  | "nonmatch_sent"
  | "nonmatch_silent"
  | "in_scope_sending"
  | "in_scope_sent"
  | "in_scope_replied"
  | "approval_sending"
  | "approval_sent"
  | "approval_silent"
  | "approval_replied"
  | "restart_marked"
  | "completion_sending"
  | "completion_sent"
  | "silence_violated"
  | "reply_mismatched";

export type CounterpartyHarnessState = {
  version: 1;
  scenarioId: string;
  generation: string;
  stage: CounterpartyStage;
  lastUpdateId: number | null;
};

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
};

type TelegramBotIdentity = {
  username?: string;
};

type TelegramWebhookInfo = {
  url?: string;
};

type TelegramMessage = {
  chat?: { id?: number | string };
  from?: { id?: number | string };
  text?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

type HarnessContext = {
  artemUserId: string;
  botToken: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  generation: string;
  reservationRoot: string;
  scenarioId: string;
  tokenHash: string;
  worktree: string;
};

export class CounterpartyManualRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CounterpartyManualRecoveryError";
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] ?? "").trim();
  if (!value) {
    throw new Error(`${key} is required; refusing counterparty execution.`);
  }
  return value;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sanitizeStatePart(value: string): string {
  return value.replace(/[^a-z0-9._-]/giu, "_");
}

export function resolveCounterpartyStatePath(env: NodeJS.ProcessEnv): string {
  const reservationRoot = path.resolve(required(env, ENV.reservationRoot));
  const scenarioId = sanitizeStatePart(required(env, ENV.scenarioId));
  const generation = sanitizeStatePart(required(env, ENV.generation));
  return path.join(reservationRoot, "counterparty-harness", `${scenarioId}-${generation}.json`);
}

function resolveCounterpartyLockPath(env: NodeJS.ProcessEnv): string {
  return `${resolveCounterpartyStatePath(env)}.lock`;
}

function parseContext(params: { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch }): HarnessContext {
  const botToken = required(params.env, ENV.token);
  const artemUserId = required(params.env, ENV.artemUserId);
  const scenarioId = required(params.env, ENV.scenarioId);
  const generation = required(params.env, ENV.generation);
  const tokenHash = required(params.env, ENV.tokenHash);

  if (artemUserId !== COUNTERPARTY_ARTEM_USER_ID) {
    throw new Error("The configured Telegram user is not the approved Artem test account.");
  }
  if (scenarioId !== COUNTERPARTY_SCENARIO_ID) {
    throw new Error("The configured tester scenario is not the approved GA counterparty scenario.");
  }
  if (tokenHash !== hashToken(botToken)) {
    throw new Error("The tester reservation token hash does not match the bot token.");
  }

  const fenceRequest = resolveTelegramSafeReuseFenceRequest({
    botToken,
    accountId: "default",
    env: params.env,
  });
  if (!fenceRequest || fenceRequest.generation !== generation) {
    throw new Error("The Telegram safe-reuse scope does not match this reservation.");
  }

  return {
    artemUserId,
    botToken,
    env: params.env,
    fetchImpl: params.fetchImpl,
    generation,
    reservationRoot: required(params.env, ENV.reservationRoot),
    scenarioId,
    tokenHash,
    worktree: required(params.env, ENV.worktree),
  };
}

function newState(context: HarnessContext): CounterpartyHarnessState {
  return {
    version: 1,
    scenarioId: context.scenarioId,
    generation: context.generation,
    stage: "new",
    lastUpdateId: null,
  };
}

function isValidStage(value: unknown): value is CounterpartyStage {
  return (
    typeof value === "string" &&
    [
      "new",
      "preflight_complete",
      "nonmatch_sending",
      "nonmatch_sent",
      "nonmatch_silent",
      "in_scope_sending",
      "in_scope_sent",
      "in_scope_replied",
      "approval_sending",
      "approval_sent",
      "approval_silent",
      "approval_replied",
      "restart_marked",
      "completion_sending",
      "completion_sent",
      "silence_violated",
      "reply_mismatched",
    ].includes(value)
  );
}

async function loadState(context: HarnessContext): Promise<CounterpartyHarnessState> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(resolveCounterpartyStatePath(context.env), "utf8"),
    ) as Partial<CounterpartyHarnessState>;
    if (
      parsed.version !== 1 ||
      parsed.scenarioId !== context.scenarioId ||
      parsed.generation !== context.generation ||
      !isValidStage(parsed.stage) ||
      (parsed.lastUpdateId !== null &&
        (!Number.isSafeInteger(parsed.lastUpdateId) || Number(parsed.lastUpdateId) < 0))
    ) {
      throw new Error("Counterparty harness state is malformed or belongs to another owner.");
    }
    return {
      version: 1,
      scenarioId: parsed.scenarioId,
      generation: parsed.generation,
      stage: parsed.stage,
      lastUpdateId: parsed.lastUpdateId ?? null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return newState(context);
    }
    throw error;
  }
}

async function saveState(context: HarnessContext, state: CounterpartyHarnessState): Promise<void> {
  const filePath = resolveCounterpartyStatePath(context.env);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
    flag: "w",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function withCommandLock<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const lockPath = resolveCounterpartyLockPath(env);
  // The state directory may not exist on the first command. Create only the
  // shared parent; the non-recursive lock mkdir below remains the atomic
  // single-owner operation.
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CounterpartyManualRecoveryError(
        `Counterparty command lock already exists at ${lockPath}; manual recovery is required.`,
      );
    }
    throw error;
  }

  try {
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return await fn();
  } finally {
    // This process created this exact directory and never waits on or removes a
    // successor's lock. A crash intentionally leaves evidence for manual recovery.
    await fs.rm(lockPath, { recursive: true }).catch(() => {});
  }
}

async function telegramApi<T>(
  context: HarnessContext,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await context.fetchImpl(
    `https://api.telegram.org/bot${context.botToken}/${method}`,
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}.`);
  }
  const envelope = (await response.json()) as TelegramApiEnvelope<T>;
  if (!envelope.ok || envelope.result === undefined) {
    throw new Error(`${method} returned a Telegram API error.`);
  }
  return envelope.result;
}

async function validateLiveOwnership(context: HarnessContext): Promise<void> {
  const reservation = await validateTelegramTesterScenarioReservation({
    token: context.botToken,
    scenarioId: context.scenarioId,
    generation: context.generation,
    tokenHash: context.tokenHash,
    worktree: context.worktree,
    reservationRoot: context.reservationRoot,
  });
  if (reservation !== "owned") {
    throw new Error("The durable tester reservation is not owned by this counterparty.");
  }

  const identity = await telegramApi<TelegramBotIdentity>(context, "getMe");
  if (identity.username !== COUNTERPARTY_BOT_USERNAME) {
    throw new Error("The reserved token does not belong to the approved counterparty bot.");
  }

  const webhook = await telegramApi<TelegramWebhookInfo>(context, "getWebhookInfo");
  if (String(webhook.url ?? "").trim()) {
    throw new Error("The counterparty bot has a webhook; refusing to enter polling mode.");
  }
}

async function runPreflight(
  context: HarnessContext,
  state: CounterpartyHarnessState,
): Promise<CounterpartyHarnessState> {
  if (state.stage === "preflight_complete") {
    return state;
  }
  expectStage(state, "new");

  await runTelegramSafeReuseFenceTransaction({
    generation: context.generation,
    resolveState: async () => {
      const fenceState = await readTelegramSafeReuseFenceState({
        accountId: "default",
        botToken: context.botToken,
        generation: context.generation,
        persistedLastUpdateId: state.lastUpdateId,
        env: context.env,
      });
      return fenceState ? { ...fenceState, recreateBot: false } : null;
    },
    markReading: () =>
      writeReadingTelegramSafeReuseFence({
        accountId: "default",
        botToken: context.botToken,
        generation: context.generation,
        env: context.env,
      }),
    markPending: (lastUpdateId) =>
      writePendingTelegramSafeReuseFence({
        accountId: "default",
        botToken: context.botToken,
        generation: context.generation,
        lastUpdateId,
        env: context.env,
      }),
    persistCutoff: async (lastUpdateId) => {
      state.lastUpdateId = lastUpdateId;
      await saveState(context, state);
    },
    markComplete: (lastUpdateId) =>
      writeCompletedTelegramSafeReuseFence({
        accountId: "default",
        botToken: context.botToken,
        generation: context.generation,
        lastUpdateId,
        env: context.env,
      }),
    readTail: () =>
      telegramApi<TelegramUpdate[]>(context, "getUpdates", {
        offset: -1,
        limit: 1,
        timeout: 0,
      }),
    log: () => {},
  });

  state.stage = "preflight_complete";
  await saveState(context, state);
  return state;
}

function expectStage(state: CounterpartyHarnessState, expected: CounterpartyStage): void {
  if (state.stage !== expected) {
    throw new Error(
      `Counterparty stage ${state.stage} cannot perform this command; expected ${expected}.`,
    );
  }
}

async function sendTransition(params: {
  context: HarnessContext;
  state: CounterpartyHarnessState;
  expected: CounterpartyStage;
  sending: CounterpartyStage;
  sent: CounterpartyStage;
  text: string;
}): Promise<CounterpartyHarnessState> {
  if (params.state.stage === params.sent) {
    return params.state;
  }
  if (params.state.stage === params.sending) {
    throw new CounterpartyManualRecoveryError(
      `Counterparty send outcome is ambiguous at stage ${params.sending}; manual recovery is required.`,
    );
  }
  expectStage(params.state, params.expected);

  // Persist intent before the network call. A timeout after Telegram accepted
  // sendMessage therefore cannot cause an automatic duplicate on retry.
  params.state.stage = params.sending;
  await saveState(params.context, params.state);
  try {
    await telegramApi(params.context, "sendMessage", {
      chat_id: COUNTERPARTY_ARTEM_USER_ID,
      text: params.text,
    });
  } catch (error) {
    throw new CounterpartyManualRecoveryError(
      `Counterparty send outcome is ambiguous at stage ${params.sending}: ${
        error instanceof Error ? error.message : String(error)
      }. Manual recovery is required.`,
    );
  }
  params.state.stage = params.sent;
  await saveState(params.context, params.state);
  return params.state;
}

function updateId(update: TelegramUpdate): number {
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) {
    throw new Error("Telegram returned an invalid counterparty update id.");
  }
  return Number(update.update_id);
}

async function pollForArtem(params: {
  context: HarnessContext;
  state: CounterpartyHarnessState;
  expectedText?: string;
  matchedStage: CounterpartyStage;
  silence: boolean;
  waitMs: number;
}): Promise<void> {
  const deadline = Date.now() + Math.max(0, params.waitMs);
  let firstAttempt = true;

  while (firstAttempt || Date.now() < deadline) {
    firstAttempt = false;
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeoutSeconds =
      params.waitMs === 0 ? 0 : Math.max(1, Math.min(20, Math.ceil(remainingMs / 1000)));
    const updates = await telegramApi<TelegramUpdate[]>(params.context, "getUpdates", {
      offset: params.state.lastUpdateId === null ? 0 : params.state.lastUpdateId + 1,
      timeout: timeoutSeconds,
    });
    if (!Array.isArray(updates)) {
      throw new Error("Telegram returned a malformed counterparty update list.");
    }

    for (const update of updates) {
      const id = updateId(update);
      params.state.lastUpdateId = Math.max(params.state.lastUpdateId ?? -1, id);
      const message = update.message;
      if (
        !message ||
        String(message.chat?.id ?? "") !== COUNTERPARTY_ARTEM_USER_ID ||
        String(message.from?.id ?? "") !== COUNTERPARTY_ARTEM_USER_ID
      ) {
        continue;
      }

      if (params.silence) {
        // The violation and consumed update share one durable state write. A
        // retry therefore cannot skip the forbidden reply and incorrectly
        // declare the silence window successful.
        params.state.stage = "silence_violated";
        await saveState(params.context, params.state);
        throw new CounterpartyManualRecoveryError(
          "Received an unexpected Artem reply during a required silence stage; manual recovery is required.",
        );
      }
      if (message.text !== params.expectedText) {
        params.state.stage = "reply_mismatched";
        await saveState(params.context, params.state);
        throw new CounterpartyManualRecoveryError(
          `Received unexpected Artem reply text; expected ${
            params.expectedText ?? "none"
          }. Manual recovery is required.`,
        );
      }
      // Commit the consumed reply cursor and successful transition together.
      // There is no crash window where a retry skips the reply but still sees
      // the old stage.
      params.state.stage = params.matchedStage;
      await saveState(params.context, params.state);
      return;
    }
    await saveState(params.context, params.state);
  }

  if (!params.silence) {
    throw new Error(`Expected Artem reply was not received: ${params.expectedText ?? "none"}.`);
  }
}

async function waitTransition(params: {
  context: HarnessContext;
  state: CounterpartyHarnessState;
  expected: CounterpartyStage;
  next: CounterpartyStage;
  expectedText?: string;
  silence: boolean;
  waitMs: number;
}): Promise<CounterpartyHarnessState> {
  if (params.state.stage === params.next) {
    return params.state;
  }
  expectStage(params.state, params.expected);
  await pollForArtem({ ...params, matchedStage: params.next });
  if (params.silence) {
    params.state.stage = params.next;
    await saveState(params.context, params.state);
  }
  return params.state;
}

async function runLockedCommand(params: {
  command: CounterpartyCommand;
  context: HarnessContext;
  waitMs: number;
}): Promise<CounterpartyHarnessState> {
  await validateLiveOwnership(params.context);
  const state = await loadState(params.context);

  switch (params.command) {
    case "preflight":
      return runPreflight(params.context, state);
    case "emit-nonmatch":
      return sendTransition({
        context: params.context,
        state,
        expected: "preflight_complete",
        sending: "nonmatch_sending",
        sent: "nonmatch_sent",
        text: COUNTERPARTY_TEXT.nonmatch,
      });
    case "assert-nonmatch-silence":
      return waitTransition({
        context: params.context,
        state,
        expected: "nonmatch_sent",
        next: "nonmatch_silent",
        silence: true,
        waitMs: params.waitMs,
      });
    case "emit-in-scope":
      return sendTransition({
        context: params.context,
        state,
        expected: "nonmatch_silent",
        sending: "in_scope_sending",
        sent: "in_scope_sent",
        text: COUNTERPARTY_TEXT.inScope,
      });
    case "wait-in-scope-reply":
      return waitTransition({
        context: params.context,
        state,
        expected: "in_scope_sent",
        next: "in_scope_replied",
        expectedText: COUNTERPARTY_TEXT.inScopeReply,
        silence: false,
        waitMs: params.waitMs,
      });
    case "emit-approval":
      return sendTransition({
        context: params.context,
        state,
        expected: "in_scope_replied",
        sending: "approval_sending",
        sent: "approval_sent",
        text: COUNTERPARTY_TEXT.approval,
      });
    case "assert-approval-silence":
      return waitTransition({
        context: params.context,
        state,
        expected: "approval_sent",
        next: "approval_silent",
        silence: true,
        waitMs: params.waitMs,
      });
    case "wait-approved-reply":
      return waitTransition({
        context: params.context,
        state,
        expected: "approval_silent",
        next: "approval_replied",
        expectedText: COUNTERPARTY_TEXT.approvalReply,
        silence: false,
        waitMs: params.waitMs,
      });
    case "mark-restart-boundary":
      if (state.stage === "restart_marked") {
        return state;
      }
      expectStage(state, "approval_replied");
      state.stage = "restart_marked";
      await saveState(params.context, state);
      return state;
    case "emit-completion":
      return sendTransition({
        context: params.context,
        state,
        expected: "restart_marked",
        sending: "completion_sending",
        sent: "completion_sent",
        text: COUNTERPARTY_TEXT.completion,
      });
  }
}

export async function runCounterpartyHarness(
  command: CounterpartyCommand,
  params: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    /** Test-only override. CLI execution always uses the canonical lease root. */
    leaseRoot?: string;
    waitMs?: number;
  } = {},
): Promise<CounterpartyHarnessState> {
  const env = params.env ?? process.env;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is unavailable; refusing counterparty execution.");
  }
  const context = parseContext({ env, fetchImpl });
  return withCommandLock(env, async () => {
    // Hold the same process-level token lease as the real poller for the full
    // command. The lease acquisition revalidates scenario ownership under the
    // reservation guard, closing both active-poller and reassignment races.
    const tokenLease = await acquireTelegramTokenLease({
      token: context.botToken,
      accountId: "default",
      worktree: context.worktree,
      leaseRoot: params.leaseRoot,
      scenarioId: context.scenarioId,
      scenarioGeneration: context.generation,
      scenarioTokenHash: context.tokenHash,
      reservationRoot: context.reservationRoot,
    });
    try {
      return await runLockedCommand({
        command,
        context,
        waitMs: params.waitMs ?? 20_000,
      });
    } finally {
      await tokenLease.release();
    }
  });
}

function parseCommand(value: string | undefined): CounterpartyCommand {
  const command = value ?? "preflight";
  const allowed: CounterpartyCommand[] = [
    "preflight",
    "emit-nonmatch",
    "assert-nonmatch-silence",
    "emit-in-scope",
    "wait-in-scope-reply",
    "emit-approval",
    "assert-approval-silence",
    "wait-approved-reply",
    "mark-restart-boundary",
    "emit-completion",
  ];
  if (!allowed.includes(command as CounterpartyCommand)) {
    throw new Error(`Unknown counterparty command: ${command}.`);
  }
  return command as CounterpartyCommand;
}

async function main(): Promise<void> {
  const state = await runCounterpartyHarness(parseCommand(process.argv[2]));
  process.stdout.write(
    `${JSON.stringify({
      scenarioId: state.scenarioId,
      generation: state.generation,
      stage: state.stage,
      lastUpdateId: state.lastUpdateId,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof TelegramSafeReuseManualRecoveryError ||
      error instanceof CounterpartyManualRecoveryError ||
      error instanceof Error
        ? error.message
        : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
