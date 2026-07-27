import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readTelegramSafeReuseFenceState,
  writePendingTelegramSafeReuseFence,
  writeReadingTelegramSafeReuseFence,
} from "../../extensions/telegram/src/safe-reuse-fence-store.ts";
import {
  runTelegramSafeReuseFenceTransaction,
  TelegramSafeReuseManualRecoveryError,
} from "../../extensions/telegram/src/safe-reuse-fence.ts";
import { acquireTelegramTesterScenarioReservation } from "../../scripts/lib/telegram-tester-scenario-reservations.mjs";
import {
  COUNTERPARTY_ARTEM_USER_ID,
  CounterpartyManualRecoveryError,
  createCounterpartyProtocol,
  resolveCounterpartyStatePath,
  runCounterpartyHarness as runCounterpartyHarnessRaw,
} from "../../scripts/telegram-counterparty-harness.ts";

const token = "12345:harness-test-token";
const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
const runId = "GA-FRESH-20260727-01";
const protocol = createCounterpartyProtocol(runId);
const expectedBotId = "12345";
const expectedBotUsername = "Artem_jarvis_email_bot";
const temporaryRoots: string[] = [];

type FakeApiOptions = {
  botId?: string;
  botUsername?: string;
  webhookUrl?: string;
  updateBatches?: Array<Array<Record<string, unknown>>>;
  failSend?: boolean;
};

function telegramEnvelope(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeBotApi(options: FakeApiOptions = {}) {
  const updateBatches = [...(options.updateBatches ?? [[]])];
  const calls: Array<{ method: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = requestUrl.split("/").at(-1) ?? "";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, body });
    if (method === "getMe") {
      return telegramEnvelope({
        id: Number(options.botId ?? expectedBotId),
        username: options.botUsername ?? expectedBotUsername,
      });
    }
    if (method === "getWebhookInfo") {
      return telegramEnvelope({ url: options.webhookUrl ?? "" });
    }
    if (method === "getUpdates") {
      return telegramEnvelope(updateBatches.shift() ?? []);
    }
    if (method === "sendMessage") {
      if (options.failSend) {
        throw new Error("simulated ambiguous send");
      }
      return telegramEnvelope({ message_id: 1 });
    }
    throw new Error(`Unexpected Bot API method: ${method}`);
  });
  return { calls, fetchImpl };
}

async function ownedEnvironment(
  params: { selectedRunId?: string; scenarioId?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  const selectedRunId = params.selectedRunId ?? runId;
  const selectedProtocol = createCounterpartyProtocol(selectedRunId);
  const reservationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-counterparty-harness-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-counterparty-owner-"));
  temporaryRoots.push(reservationRoot, worktree);
  const reservation = await acquireTelegramTesterScenarioReservation({
    token,
    scenarioId: params.scenarioId ?? selectedProtocol.scenarioId,
    worktreePath: worktree,
    reservationRoot,
  });
  if (!reservation.ok || !reservation.generation) {
    throw new Error("Unable to create test reservation.");
  }
  return {
    OPENCLAW_COUNTERPARTY_ARTEM_USER_ID: COUNTERPARTY_ARTEM_USER_ID,
    OPENCLAW_COUNTERPARTY_EXPECTED_BOT_ID: expectedBotId,
    OPENCLAW_COUNTERPARTY_EXPECTED_BOT_USERNAME: expectedBotUsername,
    OPENCLAW_COUNTERPARTY_RUN_ID: selectedRunId,
    OPENCLAW_COUNTERPARTY_TELEGRAM_BOT_TOKEN: token,
    OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT: reservationRoot,
    OPENCLAW_TELEGRAM_TESTER_SCENARIO_ID: params.scenarioId ?? selectedProtocol.scenarioId,
    OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION: reservation.generation,
    OPENCLAW_TELEGRAM_TESTER_TOKEN_HASH: tokenHash,
    OPENCLAW_TELEGRAM_TESTER_WORKTREE: worktree,
    OPENCLAW_TELEGRAM_SAFE_REUSE_GENERATION: reservation.generation,
    OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH: tokenHash,
    OPENCLAW_TELEGRAM_SAFE_REUSE_ACCOUNT_ID: "default",
  };
}

function runCounterpartyHarness(
  command: Parameters<typeof runCounterpartyHarnessRaw>[0],
  params: Parameters<typeof runCounterpartyHarnessRaw>[1],
) {
  const reservationRoot = String(params.env?.OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT ?? "");
  return runCounterpartyHarnessRaw(command, {
    ...params,
    // Unit tests must never contend with or mutate the machine-wide live lease
    // registry. Production CLI execution has no override and uses canonical state.
    leaseRoot: path.join(reservationRoot, "test-token-leases"),
  });
}

function artemUpdate(
  updateId: number,
  text: string,
  sender = COUNTERPARTY_ARTEM_USER_ID,
  date = Math.floor(Date.now() / 1000) + 1,
) {
  return {
    update_id: updateId,
    message: {
      chat: { id: Number(sender) },
      date,
      from: { id: Number(sender) },
      text,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("shared Telegram safe-reuse fence transaction", () => {
  it("persists reading, pending, cutoff, and complete in order", async () => {
    const events: string[] = [];
    let state: { phase: "reading" | "pending" | "complete"; lastUpdateId: number | null } | null =
      null;

    await expect(
      runTelegramSafeReuseFenceTransaction({
        generation: "generation-1",
        resolveState: async () => state,
        markReading: async () => {
          events.push("reading");
          state = { phase: "reading", lastUpdateId: null };
        },
        readTail: async () => {
          events.push("tail");
          return [{ update_id: 41 }];
        },
        markPending: async (lastUpdateId) => {
          events.push(`pending:${lastUpdateId}`);
          state = { phase: "pending", lastUpdateId };
        },
        persistCutoff: async (lastUpdateId) => {
          events.push(`cutoff:${lastUpdateId}`);
        },
        markComplete: async (lastUpdateId) => {
          events.push(`complete:${lastUpdateId}`);
          state = { phase: "complete", lastUpdateId };
        },
        log: () => {},
      }),
    ).resolves.toBe("recreate");
    expect(events).toEqual(["reading", "tail", "pending:41", "cutoff:41", "complete:41"]);
  });

  it("recovers pending without another tail read and rejects ambiguous reading", async () => {
    const readTail = vi.fn(async () => []);
    const events: string[] = [];
    await runTelegramSafeReuseFenceTransaction({
      generation: "generation-2",
      resolveState: async () => ({ phase: "pending", lastUpdateId: 52 }),
      markReading: async () => {},
      readTail,
      markPending: async () => {},
      persistCutoff: async (lastUpdateId) => {
        events.push(`cutoff:${lastUpdateId}`);
      },
      markComplete: async (lastUpdateId) => {
        events.push(`complete:${lastUpdateId}`);
      },
      log: () => {},
    });
    expect(readTail).not.toHaveBeenCalled();
    expect(events).toEqual(["cutoff:52", "complete:52"]);

    await expect(
      runTelegramSafeReuseFenceTransaction({
        generation: "generation-3",
        resolveState: async () => ({ phase: "reading", lastUpdateId: null }),
        markReading: async () => {},
        readTail,
        markPending: async () => {},
        persistCutoff: async () => {},
        markComplete: async () => {},
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(TelegramSafeReuseManualRecoveryError);
  });
});

describe("deterministic Telegram counterparty harness", () => {
  it("derives a fresh scenario and every protocol string from a strict run ID", async () => {
    const freshRunId = "GA-FRESH-20260727-SECOND";
    const freshProtocol = createCounterpartyProtocol(freshRunId);
    const env = await ownedEnvironment({ selectedRunId: freshRunId });
    const api = fakeBotApi({ updateBatches: [[], []] });

    await runCounterpartyHarness("preflight", { env, fetchImpl: api.fetchImpl, waitMs: 0 });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-operational-detail-request", {
      env,
      fetchImpl: api.fetchImpl,
    });

    expect(freshProtocol.scenarioId).toBe(`${freshRunId}-counterparty`);
    expect(
      api.calls.filter((call) => call.method === "sendMessage").map((call) => call.body?.text),
    ).toEqual([freshProtocol.text.nonmatch, freshProtocol.text.operationalRequest]);
    expect(Object.values(freshProtocol.text).every((text) => text.startsWith(freshRunId))).toBe(
      true,
    );

    for (const invalidRunId of [
      " leading-space",
      "trailing-space ",
      "contains space",
      "contains/control\n",
      "-leading-hyphen",
      "trailing-hyphen-",
      "a".repeat(65),
    ]) {
      expect(() => createCounterpartyProtocol(invalidRunId)).toThrow(
        /must be 1-64 printable ASCII/,
      );
    }
  });

  it("preflights with no send and completes the durable shared fence", async () => {
    const env = await ownedEnvironment();
    const api = fakeBotApi({ updateBatches: [[{ update_id: 9 }]] });
    const state = await runCounterpartyHarness("preflight", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });

    expect(state).toMatchObject({ stage: "preflight_complete", lastUpdateId: 9 });
    expect(api.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
    const fence = await readTelegramSafeReuseFenceState({
      accountId: "default",
      botToken: token,
      generation: String(env.OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION),
      persistedLastUpdateId: state.lastUpdateId,
      env,
    });
    expect(fence).toEqual({ phase: "complete", lastUpdateId: 9 });
  });

  it("recovers pending without rereading the tail and rejects ambiguous reading", async () => {
    const pendingEnv = await ownedEnvironment();
    await writePendingTelegramSafeReuseFence({
      accountId: "default",
      botToken: token,
      generation: String(pendingEnv.OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION),
      lastUpdateId: 12,
      env: pendingEnv,
    });
    const pendingApi = fakeBotApi();
    await expect(
      runCounterpartyHarness("preflight", {
        env: pendingEnv,
        fetchImpl: pendingApi.fetchImpl,
        waitMs: 0,
      }),
    ).resolves.toMatchObject({ stage: "preflight_complete", lastUpdateId: 12 });
    expect(pendingApi.calls.filter((call) => call.method === "getUpdates")).toHaveLength(0);

    const readingEnv = await ownedEnvironment();
    await writeReadingTelegramSafeReuseFence({
      accountId: "default",
      botToken: token,
      generation: String(readingEnv.OPENCLAW_TELEGRAM_TESTER_RESERVATION_GENERATION),
      env: readingEnv,
    });
    const readingApi = fakeBotApi();
    await expect(
      runCounterpartyHarness("preflight", {
        env: readingEnv,
        fetchImpl: readingApi.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toBeInstanceOf(TelegramSafeReuseManualRecoveryError);
    expect(readingApi.calls.filter((call) => call.method === "getUpdates")).toHaveLength(0);
  });

  it("fails closed on bot identity, scenario, webhook, and safe-scope mismatches", async () => {
    const identityEnv = await ownedEnvironment();
    await expect(
      runCounterpartyHarness("preflight", {
        env: identityEnv,
        fetchImpl: fakeBotApi({ botUsername: "wrong_bot" }).fetchImpl,
      }),
    ).rejects.toThrow(/explicitly expected tester bot/);

    const botIdEnv = await ownedEnvironment();
    await expect(
      runCounterpartyHarness("preflight", {
        env: botIdEnv,
        fetchImpl: fakeBotApi({ botId: "99999" }).fetchImpl,
      }),
    ).rejects.toThrow(/explicitly expected tester bot/);

    const callerAssertedBotIdEnv = await ownedEnvironment();
    callerAssertedBotIdEnv.OPENCLAW_COUNTERPARTY_EXPECTED_BOT_ID = "99999";
    await expect(
      runCounterpartyHarness("preflight", {
        env: callerAssertedBotIdEnv,
        fetchImpl: fakeBotApi({ botId: "99999" }).fetchImpl,
      }),
    ).rejects.toThrow(/explicitly expected tester bot/);

    const scenarioEnv = await ownedEnvironment();
    scenarioEnv.OPENCLAW_COUNTERPARTY_RUN_ID = "GA-FRESH-DIFFERENT";
    await expect(
      runCounterpartyHarness("preflight", {
        env: scenarioEnv,
        fetchImpl: fakeBotApi().fetchImpl,
      }),
    ).rejects.toThrow(/must exactly equal GA-FRESH-DIFFERENT-counterparty/);

    const webhookEnv = await ownedEnvironment();
    await expect(
      runCounterpartyHarness("preflight", {
        env: webhookEnv,
        fetchImpl: fakeBotApi({ webhookUrl: "https://example.test/hook" }).fetchImpl,
      }),
    ).rejects.toThrow(/webhook/);

    const scopeEnv = await ownedEnvironment();
    scopeEnv.OPENCLAW_TELEGRAM_SAFE_REUSE_TOKEN_HASH = "0".repeat(64);
    await expect(
      runCounterpartyHarness("preflight", {
        env: scopeEnv,
        fetchImpl: fakeBotApi().fetchImpl,
      }),
    ).rejects.toThrow(/safe-reuse scope/);
  });

  it("refuses to run while another process owns the bot polling lease", async () => {
    const env = await ownedEnvironment();
    const reservationRoot = String(env.OPENCLAW_TELEGRAM_TESTER_RESERVATION_ROOT);
    const leaseRoot = path.join(reservationRoot, "test-token-leases");
    const leasePath = path.join(leaseRoot, `12345-${tokenHash}.json`);
    fs.mkdirSync(leaseRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      leasePath,
      `${JSON.stringify({
        version: 1,
        pid: process.ppid,
        starttime: null,
        createdAt: new Date().toISOString(),
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        botId: "12345",
        accountId: "default",
        configPath: null,
        worktree: "/another/active/runtime",
      })}\n`,
      { mode: 0o600 },
    );
    const api = fakeBotApi();

    await expect(
      runCounterpartyHarness("preflight", {
        env,
        fetchImpl: api.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toThrow(/lease already owned/);
    expect(api.calls).toHaveLength(0);
  });

  it("runs the exact persistent stage sequence and literal messages", async () => {
    const env = await ownedEnvironment();
    const api = fakeBotApi({
      updateBatches: [
        [{ update_id: 1 }],
        [],
        [artemUpdate(2, protocol.text.operationalReply)],
        [],
        [artemUpdate(3, protocol.text.paymentApprovedReply)],
      ],
    });

    await runCounterpartyHarness("preflight", { env, fetchImpl: api.fetchImpl, waitMs: 0 });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-operational-detail-request", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await runCounterpartyHarness("wait-operational-detail-reply", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-payment-approval", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await runCounterpartyHarness("assert-payment-approval-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    env.OPENCLAW_COUNTERPARTY_FOUNDER_APPROVAL_RECEIPT = `${protocol.scenarioId}:test-founder-approval`;
    await runCounterpartyHarness("record-founder-approval", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await runCounterpartyHarness("wait-approved-payment-continuation", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("mark-restart-boundary", {
      env,
      fetchImpl: api.fetchImpl,
    });
    const final = await runCounterpartyHarness("emit-completion", {
      env,
      fetchImpl: api.fetchImpl,
    });

    expect(final.stage).toBe("completion_sent");
    expect(protocol.text.operationalRequest).toContain(
      "target=Monas_Jakarta request=location_and_map",
    );
    expect(protocol.text.operationalReply).toContain(
      "map=https://maps.google.com/?q=-6.175392,106.827153",
    );
    expect(protocol.text.paymentApproval).toContain(
      "event=SYNTHETIC_SECURITY_DEPOSIT amount=IDR_100000 recipient=DEMO_VENDOR real_funds=false",
    );
    const sent = api.calls.filter((call) => call.method === "sendMessage").map((call) => call.body);
    expect(sent).toEqual([
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.nonmatch },
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.operationalRequest },
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.paymentApproval },
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.completion },
    ]);

    const persisted = JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(env), "utf8")) as {
      stage: string;
      lastUpdateId: number;
    };
    expect(persisted).toMatchObject({
      version: 2,
      stage: "completion_sent",
      lastUpdateId: 3,
      founderApprovalReceipt: `${protocol.scenarioId}:test-founder-approval`,
    });
  });

  it("requires silence for the synthetic payment until an approved continuation is allowed", async () => {
    const env = await ownedEnvironment();
    const api = fakeBotApi({
      updateBatches: [
        [],
        [],
        [artemUpdate(2, protocol.text.operationalReply)],
        [artemUpdate(3, protocol.text.paymentApprovedReply)],
      ],
    });

    await runCounterpartyHarness("preflight", { env, fetchImpl: api.fetchImpl, waitMs: 0 });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-operational-detail-request", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await runCounterpartyHarness("wait-operational-detail-reply", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-payment-approval", {
      env,
      fetchImpl: api.fetchImpl,
    });

    await expect(
      runCounterpartyHarness("assert-payment-approval-silence", {
        env,
        fetchImpl: api.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);
    expect(JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(env), "utf8"))).toMatchObject({
      stage: "silence_violated",
      lastUpdateId: 3,
    });
  });

  it("rejects an exact continuation that predates the durable founder approval", async () => {
    const env = await ownedEnvironment();
    const approvalSecond = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue(approvalSecond * 1000);
    const api = fakeBotApi({
      updateBatches: [
        [],
        [],
        [artemUpdate(2, protocol.text.operationalReply)],
        [],
        [
          artemUpdate(
            3,
            protocol.text.paymentApprovedReply,
            COUNTERPARTY_ARTEM_USER_ID,
            approvalSecond,
          ),
        ],
      ],
    });

    await runCounterpartyHarness("preflight", { env, fetchImpl: api.fetchImpl, waitMs: 0 });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-operational-detail-request", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await runCounterpartyHarness("wait-operational-detail-reply", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-payment-approval", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await runCounterpartyHarness("assert-payment-approval-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    env.OPENCLAW_COUNTERPARTY_FOUNDER_APPROVAL_RECEIPT = `${protocol.scenarioId}:test-founder-approval`;
    await runCounterpartyHarness("record-founder-approval", {
      env,
      fetchImpl: api.fetchImpl,
    });

    await expect(
      runCounterpartyHarness("wait-approved-payment-continuation", {
        env,
        fetchImpl: api.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);
    expect(JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(env), "utf8"))).toMatchObject({
      stage: "reply_mismatched",
      lastUpdateId: 3,
    });
  });

  it("keeps a confirmed send idempotent instead of duplicating it", async () => {
    const env = await ownedEnvironment();
    const api = fakeBotApi({ updateBatches: [[]] });

    await runCounterpartyHarness("preflight", { env, fetchImpl: api.fetchImpl, waitMs: 0 });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });

    expect(api.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(env), "utf8"))).toMatchObject({
      stage: "nonmatch_sent",
    });
  });

  it("replays the exact NONMATCH only after baseline and then resumes operational detail", async () => {
    const env = await ownedEnvironment();
    const api = fakeBotApi({
      updateBatches: [[{ update_id: 1 }], [], []],
    });

    await runCounterpartyHarness("preflight", { env, fetchImpl: api.fetchImpl, waitMs: 0 });
    await runCounterpartyHarness("emit-nonmatch", { env, fetchImpl: api.fetchImpl });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });

    const replayed = await runCounterpartyHarness("replay-nonmatch-after-baseline", {
      env,
      fetchImpl: api.fetchImpl,
    });
    expect(replayed.stage).toBe("replay_sent");

    const sendCountAfterReplay = api.calls.filter((call) => call.method === "sendMessage").length;
    await expect(
      runCounterpartyHarness("replay-nonmatch-after-baseline", {
        env,
        fetchImpl: api.fetchImpl,
      }),
    ).resolves.toMatchObject({ stage: "replay_sent" });
    expect(api.calls.filter((call) => call.method === "sendMessage")).toHaveLength(
      sendCountAfterReplay,
    );

    const replaySilent = await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    expect(replaySilent.stage).toBe("replay_silent");

    const pollCountAfterSilence = api.calls.filter((call) => call.method === "getUpdates").length;
    await expect(
      runCounterpartyHarness("assert-nonmatch-silence", {
        env,
        fetchImpl: api.fetchImpl,
        waitMs: 0,
      }),
    ).resolves.toMatchObject({ stage: "replay_silent" });
    expect(api.calls.filter((call) => call.method === "getUpdates")).toHaveLength(
      pollCountAfterSilence,
    );

    await expect(
      runCounterpartyHarness("emit-operational-detail-request", {
        env,
        fetchImpl: api.fetchImpl,
      }),
    ).resolves.toMatchObject({ stage: "operational_sent" });

    expect(
      api.calls.filter((call) => call.method === "sendMessage").map((call) => call.body),
    ).toEqual([
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.nonmatch },
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.nonmatch },
      { chat_id: COUNTERPARTY_ARTEM_USER_ID, text: protocol.text.operationalRequest },
    ]);
  });

  it("fails closed when the post-baseline NONMATCH replay send is ambiguous", async () => {
    const env = await ownedEnvironment();
    const setupApi = fakeBotApi({ updateBatches: [[], []] });
    await runCounterpartyHarness("preflight", {
      env,
      fetchImpl: setupApi.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-nonmatch", {
      env,
      fetchImpl: setupApi.fetchImpl,
    });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env,
      fetchImpl: setupApi.fetchImpl,
      waitMs: 0,
    });

    await expect(
      runCounterpartyHarness("replay-nonmatch-after-baseline", {
        env,
        fetchImpl: fakeBotApi({ failSend: true }).fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);
    expect(JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(env), "utf8"))).toMatchObject({
      stage: "replay_sending",
    });

    const retryApi = fakeBotApi();
    await expect(
      runCounterpartyHarness("replay-nonmatch-after-baseline", {
        env,
        fetchImpl: retryApi.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);
    expect(retryApi.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });

  it("rejects wrong stage, sender, chat, and reply text", async () => {
    const stageEnv = await ownedEnvironment();
    await runCounterpartyHarness("preflight", {
      env: stageEnv,
      fetchImpl: fakeBotApi().fetchImpl,
      waitMs: 0,
    });
    await expect(
      runCounterpartyHarness("emit-operational-detail-request", {
        env: stageEnv,
        fetchImpl: fakeBotApi().fetchImpl,
      }),
    ).rejects.toThrow(/expected nonmatch_silent/);
    await expect(
      runCounterpartyHarness("replay-nonmatch-after-baseline", {
        env: stageEnv,
        fetchImpl: fakeBotApi().fetchImpl,
      }),
    ).rejects.toThrow(/expected nonmatch_silent/);

    const senderEnv = await ownedEnvironment();
    const senderApi = fakeBotApi({
      updateBatches: [[], [], [artemUpdate(2, protocol.text.operationalReply, "42")]],
    });
    await runCounterpartyHarness("preflight", {
      env: senderEnv,
      fetchImpl: senderApi.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-nonmatch", {
      env: senderEnv,
      fetchImpl: senderApi.fetchImpl,
    });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env: senderEnv,
      fetchImpl: senderApi.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-operational-detail-request", {
      env: senderEnv,
      fetchImpl: senderApi.fetchImpl,
    });
    await expect(
      runCounterpartyHarness("wait-operational-detail-reply", {
        env: senderEnv,
        fetchImpl: senderApi.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toThrow(/not received/);

    const textEnv = await ownedEnvironment();
    const textApi = fakeBotApi({
      updateBatches: [[], [], [artemUpdate(3, "wrong text")]],
    });
    await runCounterpartyHarness("preflight", {
      env: textEnv,
      fetchImpl: textApi.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-nonmatch", {
      env: textEnv,
      fetchImpl: textApi.fetchImpl,
    });
    await runCounterpartyHarness("assert-nonmatch-silence", {
      env: textEnv,
      fetchImpl: textApi.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-operational-detail-request", {
      env: textEnv,
      fetchImpl: textApi.fetchImpl,
    });
    await expect(
      runCounterpartyHarness("wait-operational-detail-reply", {
        env: textEnv,
        fetchImpl: textApi.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toThrow(/unexpected Artem reply text/);
    expect(
      JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(textEnv), "utf8")),
    ).toMatchObject({
      stage: "reply_mismatched",
      lastUpdateId: 3,
    });
    const textRetryApi = fakeBotApi();
    await expect(
      runCounterpartyHarness("wait-operational-detail-reply", {
        env: textEnv,
        fetchImpl: textRetryApi.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toThrow(/expected operational_sent/);
    expect(textRetryApi.calls.filter((call) => call.method === "getUpdates")).toHaveLength(0);
  });

  it("persists a silence violation so retry cannot erase it", async () => {
    const env = await ownedEnvironment();
    const api = fakeBotApi({
      updateBatches: [[], [artemUpdate(4, "unexpected reply")]],
    });
    await runCounterpartyHarness("preflight", {
      env,
      fetchImpl: api.fetchImpl,
      waitMs: 0,
    });
    await runCounterpartyHarness("emit-nonmatch", {
      env,
      fetchImpl: api.fetchImpl,
    });
    await expect(
      runCounterpartyHarness("assert-nonmatch-silence", {
        env,
        fetchImpl: api.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);
    expect(JSON.parse(fs.readFileSync(resolveCounterpartyStatePath(env), "utf8"))).toMatchObject({
      stage: "silence_violated",
      lastUpdateId: 4,
    });

    const retryApi = fakeBotApi();
    await expect(
      runCounterpartyHarness("assert-nonmatch-silence", {
        env,
        fetchImpl: retryApi.fetchImpl,
        waitMs: 0,
      }),
    ).rejects.toThrow(/expected nonmatch_sent/);
    expect(retryApi.calls.filter((call) => call.method === "getUpdates")).toHaveLength(0);
  });

  it("leaves an ambiguous send in a fail-closed intent stage", async () => {
    const env = await ownedEnvironment();
    const preflightApi = fakeBotApi();
    await runCounterpartyHarness("preflight", {
      env,
      fetchImpl: preflightApi.fetchImpl,
      waitMs: 0,
    });
    const failingApi = fakeBotApi({ failSend: true });
    await expect(
      runCounterpartyHarness("emit-nonmatch", {
        env,
        fetchImpl: failingApi.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);

    const retryApi = fakeBotApi();
    await expect(
      runCounterpartyHarness("emit-nonmatch", {
        env,
        fetchImpl: retryApi.fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CounterpartyManualRecoveryError);
    expect(retryApi.calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
  });
});
