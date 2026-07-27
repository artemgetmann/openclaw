#!/usr/bin/env -S node --import tsx

/**
 * Deterministic, non-AI Telegram counterparty for a fresh acceptance run.
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

export const COUNTERPARTY_ARTEM_USER_ID = "1336356696";

export type CounterpartyProtocol = {
  scenarioId: string;
  text: {
    nonmatch: string;
    operationalRequest: string;
    operationalReply: string;
    paymentApproval: string;
    paymentApprovedReply: string;
    completion: string;
  };
};

const RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;
const BOT_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/u;
const BOT_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;

export function createCounterpartyProtocol(runId: string): CounterpartyProtocol {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "OPENCLAW_COUNTERPARTY_RUN_ID must be 1-64 printable ASCII letters, digits, dots, underscores, or hyphens, and must start and end with a letter or digit.",
    );
  }

  const operationalReply =
    `${runId} OPERATIONAL_DETAIL location=Monas_Jakarta ` +
    "map=https://maps.google.com/?q=-6.175392,106.827153";
  const paymentApprovedReply =
    `${runId} APPROVED_CONTINUATION event=SYNTHETIC_SECURITY_DEPOSIT ` +
    "amount=IDR_100000 recipient=DEMO_VENDOR";

  return {
    scenarioId: `${runId}-counterparty`,
    text: {
      nonmatch: `${runId} NONMATCH kind=unrelated-weather`,
      operationalRequest:
        `${runId} OPERATIONAL_DETAIL_REQUEST target=Monas_Jakarta request=location_and_map ` +
        `reply_exact=${operationalReply}`,
      operationalReply,
      paymentApproval:
        `${runId} APPROVAL_REQUIRED event=SYNTHETIC_SECURITY_DEPOSIT amount=IDR_100000 ` +
        `recipient=DEMO_VENDOR real_funds=false reply_exact=${paymentApprovedReply}`,
      paymentApprovedReply,
      completion: `${runId} COMPLETE evidence=FRESH_AFTER_RESTART`,
    },
  };
}

const ENV = {
  artemUserId: "OPENCLAW_COUNTERPARTY_ARTEM_USER_ID",
  expectedBotId: "OPENCLAW_COUNTERPARTY_EXPECTED_BOT_ID",
  expectedBotUsername: "OPENCLAW_COUNTERPARTY_EXPECTED_BOT_USERNAME",
  runId: "OPENCLAW_COUNTERPARTY_RUN_ID",
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
  | "replay-nonmatch-after-baseline"
  | "assert-nonmatch-silence"
  | "emit-operational-detail-request"
  | "wait-operational-detail-reply"
  | "emit-payment-approval"
  | "assert-payment-approval-silence"
  | "record-founder-approval"
  | "wait-approved-payment-continuation"
  | "mark-restart-boundary"
  | "emit-completion";

export type CounterpartyStage =
  | "new"
  | "preflight_complete"
  | "nonmatch_sending"
  | "nonmatch_sent"
  | "nonmatch_silent"
  | "replay_sending"
  | "replay_sent"
  | "replay_silent"
  | "operational_sending"
  | "operational_sent"
  | "operational_replied"
  | "payment_approval_sending"
  | "payment_approval_sent"
  | "payment_approval_silent"
  | "payment_founder_approved"
  | "payment_approved"
  | "restart_marked"
  | "completion_sending"
  | "completion_sent"
  | "silence_violated"
  | "reply_mismatched";

export type CounterpartyHarnessState = {
  version: 2;
  scenarioId: string;
  generation: string;
  stage: CounterpartyStage;
  lastUpdateId: number | null;
  founderApprovalReceipt: string | null;
  founderApprovedAtUnixSeconds: number | null;
};

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
};

type TelegramBotIdentity = {
  id?: number | string;
  username?: string;
};

type TelegramWebhookInfo = {
  url?: string;
};

type TelegramMessage = {
  chat?: { id?: number | string };
  date?: number;
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
  expectedBotId: string;
  expectedBotUsername: string;
  fetchImpl: typeof fetch;
  generation: string;
  reservationRoot: string;
  protocol: CounterpartyProtocol;
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
  const expectedBotId = required(params.env, ENV.expectedBotId);
  const expectedBotUsername = required(params.env, ENV.expectedBotUsername);
  const protocol = createCounterpartyProtocol(required(params.env, ENV.runId));
  const scenarioId = required(params.env, ENV.scenarioId);
  const generation = required(params.env, ENV.generation);
  const tokenHash = required(params.env, ENV.tokenHash);

  if (artemUserId !== COUNTERPARTY_ARTEM_USER_ID) {
    throw new Error("The configured Telegram user is not the approved Artem test account.");
  }
  if (!BOT_ID_PATTERN.test(expectedBotId)) {
    throw new Error("The expected Telegram bot ID must be an explicit positive decimal ID.");
  }
  if (!BOT_USERNAME_PATTERN.test(expectedBotUsername)) {
    throw new Error("The expected Telegram bot username has an invalid printable format.");
  }
  if (scenarioId !== protocol.scenarioId) {
    throw new Error(
      `The configured tester scenario must exactly equal ${protocol.scenarioId} for this run.`,
    );
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
    expectedBotId,
    expectedBotUsername,
    fetchImpl: params.fetchImpl,
    generation,
    protocol,
    reservationRoot: required(params.env, ENV.reservationRoot),
    scenarioId,
    tokenHash,
    worktree: required(params.env, ENV.worktree),
  };
}

function newState(context: HarnessContext): CounterpartyHarnessState {
  return {
    version: 2,
    scenarioId: context.scenarioId,
    generation: context.generation,
    stage: "new",
    lastUpdateId: null,
    founderApprovalReceipt: null,
    founderApprovedAtUnixSeconds: null,
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
      "replay_sending",
      "replay_sent",
      "replay_silent",
      "operational_sending",
      "operational_sent",
      "operational_replied",
      "payment_approval_sending",
      "payment_approval_sent",
      "payment_approval_silent",
      "payment_founder_approved",
      "payment_approved",
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
      parsed.version !== 2 ||
      parsed.scenarioId !== context.scenarioId ||
      parsed.generation !== context.generation ||
      !isValidStage(parsed.stage) ||
      (parsed.lastUpdateId !== null &&
        (!Number.isSafeInteger(parsed.lastUpdateId) || Number(parsed.lastUpdateId) < 0)) ||
      (parsed.founderApprovalReceipt !== null &&
        (typeof parsed.founderApprovalReceipt !== "string" ||
          !parsed.founderApprovalReceipt.startsWith(`${context.scenarioId}:`) ||
          parsed.founderApprovalReceipt.length > 300)) ||
      (parsed.founderApprovedAtUnixSeconds !== null &&
        (!Number.isSafeInteger(parsed.founderApprovedAtUnixSeconds) ||
          Number(parsed.founderApprovedAtUnixSeconds) < 0))
    ) {
      throw new Error("Counterparty harness state is malformed or belongs to another owner.");
    }
    return {
      version: 2,
      scenarioId: parsed.scenarioId,
      generation: parsed.generation,
      stage: parsed.stage,
      lastUpdateId: parsed.lastUpdateId ?? null,
      founderApprovalReceipt: parsed.founderApprovalReceipt ?? null,
      founderApprovedAtUnixSeconds: parsed.founderApprovedAtUnixSeconds ?? null,
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
  const tokenBotId = context.botToken.split(":", 1)[0]?.trim() ?? "";
  // Bind the reservation token to the pool bot selected by the operator. Both
  // immutable Telegram fields must agree, and the expected ID must also be the
  // ID encoded by the reserved token. Caller-supplied labels therefore cannot
  // authorize a different reserved bot.
  if (
    context.expectedBotId !== tokenBotId ||
    String(identity.id ?? "") !== context.expectedBotId ||
    identity.username !== context.expectedBotUsername
  ) {
    throw new Error("The reserved token does not belong to the explicitly expected tester bot.");
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

function expectStage(
  state: CounterpartyHarnessState,
  expected: CounterpartyStage | CounterpartyStage[],
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(state.stage)) {
    throw new Error(
      `Counterparty stage ${state.stage} cannot perform this command; expected ${allowed.join(" or ")}.`,
    );
  }
}

async function sendTransition(params: {
  context: HarnessContext;
  state: CounterpartyHarnessState;
  expected: CounterpartyStage | CounterpartyStage[];
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
  notBeforeUnixSeconds?: number;
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
      if (
        params.notBeforeUnixSeconds !== undefined &&
        (!Number.isSafeInteger(message.date) || Number(message.date) <= params.notBeforeUnixSeconds)
      ) {
        params.state.stage = "reply_mismatched";
        await saveState(params.context, params.state);
        throw new CounterpartyManualRecoveryError(
          "Received the expected reply before the durable founder-approval boundary; manual recovery is required.",
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
  notBeforeUnixSeconds?: number;
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
        text: params.context.protocol.text.nonmatch,
      });
    case "replay-nonmatch-after-baseline":
      return sendTransition({
        context: params.context,
        state,
        expected: "nonmatch_silent",
        sending: "replay_sending",
        sent: "replay_sent",
        text: params.context.protocol.text.nonmatch,
      });
    case "assert-nonmatch-silence":
      // The replay is deliberately a second branch of the same silence check.
      // Its distinct durable states preserve the original run while allowing
      // the listener to baseline first and observe the exact fresh NONMATCH.
      if (state.stage === "replay_sent" || state.stage === "replay_silent") {
        return waitTransition({
          context: params.context,
          state,
          expected: "replay_sent",
          next: "replay_silent",
          silence: true,
          waitMs: params.waitMs,
        });
      }
      return waitTransition({
        context: params.context,
        state,
        expected: "nonmatch_sent",
        next: "nonmatch_silent",
        silence: true,
        waitMs: params.waitMs,
      });
    case "emit-operational-detail-request":
      return sendTransition({
        context: params.context,
        state,
        // Both paths prove the same silence contract. The replay path exists
        // only for a listener that baselined the first NONMATCH as history.
        expected: ["nonmatch_silent", "replay_silent"],
        sending: "operational_sending",
        sent: "operational_sent",
        text: params.context.protocol.text.operationalRequest,
      });
    case "wait-operational-detail-reply":
      return waitTransition({
        context: params.context,
        state,
        expected: "operational_sent",
        next: "operational_replied",
        expectedText: params.context.protocol.text.operationalReply,
        silence: false,
        waitMs: params.waitMs,
      });
    case "emit-payment-approval":
      return sendTransition({
        context: params.context,
        state,
        expected: "operational_replied",
        sending: "payment_approval_sending",
        sent: "payment_approval_sent",
        text: params.context.protocol.text.paymentApproval,
      });
    case "assert-payment-approval-silence":
      return waitTransition({
        context: params.context,
        state,
        expected: "payment_approval_sent",
        next: "payment_approval_silent",
        silence: true,
        waitMs: params.waitMs,
      });
    case "record-founder-approval": {
      if (state.stage === "payment_founder_approved") {
        return state;
      }
      expectStage(state, "payment_approval_silent");
      const receipt = required(
        params.context.env,
        "OPENCLAW_COUNTERPARTY_FOUNDER_APPROVAL_RECEIPT",
      );
      if (!receipt.startsWith(`${params.context.scenarioId}:`) || receipt.length > 300) {
        throw new Error(
          `The founder approval receipt must start with ${params.context.scenarioId}: and be at most 300 characters.`,
        );
      }
      // This command is the explicit human checkpoint. Persist its source
      // receipt and time before polling again so a delayed pre-approval reply
      // cannot be mistaken for an authorized continuation.
      state.founderApprovalReceipt = receipt;
      state.founderApprovedAtUnixSeconds = Math.floor(Date.now() / 1000);
      state.stage = "payment_founder_approved";
      await saveState(params.context, state);
      return state;
    }
    case "wait-approved-payment-continuation":
      if (state.founderApprovedAtUnixSeconds === null || !state.founderApprovalReceipt) {
        throw new Error("The durable founder-approval checkpoint is missing.");
      }
      return waitTransition({
        context: params.context,
        state,
        expected: "payment_founder_approved",
        next: "payment_approved",
        expectedText: params.context.protocol.text.paymentApprovedReply,
        silence: false,
        waitMs: params.waitMs,
        notBeforeUnixSeconds: state.founderApprovedAtUnixSeconds,
      });
    case "mark-restart-boundary":
      if (state.stage === "restart_marked") {
        return state;
      }
      expectStage(state, "payment_approved");
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
        text: params.context.protocol.text.completion,
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
    "replay-nonmatch-after-baseline",
    "assert-nonmatch-silence",
    "emit-operational-detail-request",
    "wait-operational-detail-reply",
    "emit-payment-approval",
    "assert-payment-approval-silence",
    "record-founder-approval",
    "wait-approved-payment-continuation",
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
