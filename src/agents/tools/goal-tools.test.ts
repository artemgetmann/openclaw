import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionGoal, getSessionGoal, updateSessionStore } from "../../config/sessions.js";
import { resolveMonitorStorePath, saveMonitorStore } from "../../monitor/store.js";
import type { MonitorRecord } from "../../monitor/types.js";
import { createCreateGoalTool, createGetGoalTool, createUpdateGoalTool } from "./goal-tools.js";

describe("goal tools", () => {
  let tempDir = "";
  let storePath = "";
  let cronStorePath = "";
  let monitorStorePath = "";
  const sessionKey = "agent:main:telegram:direct:123";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-goal-tools-"));
    storePath = path.join(tempDir, "sessions.json");
    cronStorePath = path.join(tempDir, "cron", "jobs.json");
    monitorStorePath = resolveMonitorStorePath({ cronStorePath });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = { sessionId: "session-1", updatedAt: 1 };
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, reads, and updates the current session goal", async () => {
    const options = {
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    };
    const create = createCreateGoalTool(options);
    const get = createGetGoalTool(options);
    const update = createUpdateGoalTool(options);

    const created = await create.execute?.("call-1", {
      objective: "Book dinner between 7 and 8.",
    });
    expect(created?.details).toMatchObject({
      status: "created",
      goal: { objective: "Book dinner between 7 and 8.", status: "active" },
    });

    const snapshot = await get.execute?.("call-2", {});
    expect(snapshot?.details).toMatchObject({
      status: "found",
      goal: { objective: "Book dinner between 7 and 8." },
    });

    const completed = await update.execute?.("call-3", {
      status: "complete",
      note: "Time and place agreed.",
    });
    expect(completed?.details).toMatchObject({
      status: "updated",
      goal: { status: "complete", lastStatusNote: "Time and place agreed." },
    });
  });

  it("ignores model-supplied token budgets", async () => {
    const create = createCreateGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const created = await create.execute?.("call-1", { objective: "Do it.", token_budget: 1 });
    expect(created?.details).toMatchObject({
      status: "created",
      goal: { objective: "Do it.", status: "active" },
    });
    expect((created?.details as { goal?: { tokenBudget?: number } })?.goal?.tokenBudget).toBe(
      undefined,
    );
  });

  it("updates the origin session goal when called from a monitor session", async () => {
    const originGoal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
    });
    const monitorSessionKey = "agent:main:monitor:monitor-1";
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        {
          monitorId: "monitor-1",
          agentId: "main",
          originSessionKey: sessionKey,
          monitorSessionKey,
          sourceType: "gmail",
          sourceTarget: { account: "me@example.com", threadId: "thread-1" },
          cadence: { kind: "every", everyMs: 300_000 },
          actionPolicy: "notify_draft",
          goal: { id: originGoal.id, objective: originGoal.objective },
          status: "active",
          cronJobId: "cron-job-1",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });

    const update = createUpdateGoalTool({
      agentSessionKey: monitorSessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const completed = await update.execute?.("call-monitor-complete", {
      status: "complete",
      note: "Refund received.",
    });

    expect(completed?.details).toMatchObject({
      status: "updated",
      goal: { status: "complete", lastStatusNote: "Refund received." },
    });
    const originSnapshot = await getSessionGoal({ sessionKey, storePath, persist: false });
    expect(originSnapshot.goal?.status).toBe("complete");
    expect((await getSessionGoal({ sessionKey: monitorSessionKey, storePath })).status).toBe(
      "missing",
    );
  });

  it("ignores goal mutation tools from monitor sessions without a bound goal", async () => {
    const monitorSessionKey = "agent:main:monitor:monitor-no-goal";
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        {
          monitorId: "monitor-no-goal",
          agentId: "main",
          originSessionKey: sessionKey,
          monitorSessionKey,
          sourceType: "whatsapp",
          sourceTarget: { target: "12345@lid" },
          cadence: { kind: "every", everyMs: 300_000 },
          actionPolicy: "notify_draft",
          status: "active",
          cronJobId: "cron-job-no-goal",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    });

    const options = {
      agentSessionKey: monitorSessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    };
    const create = createCreateGoalTool(options);
    const update = createUpdateGoalTool(options);

    await expect(
      create.execute?.("call-monitor-create", { objective: "Accidentally create goal." }),
    ).resolves.toMatchObject({
      details: {
        status: "ignored",
        reason: "monitor sessions do not own user goals",
        monitorId: "monitor-no-goal",
      },
    });
    await expect(
      update.execute?.("call-monitor-update", { status: "complete" }),
    ).resolves.toMatchObject({
      details: {
        status: "ignored",
        reason: "monitor session has no bound goal",
        monitorId: "monitor-no-goal",
      },
    });
    expect((await getSessionGoal({ sessionKey: monitorSessionKey, storePath })).status).toBe(
      "missing",
    );
  });

  function buildMonitor(overrides: Partial<MonitorRecord>): MonitorRecord {
    const monitorId = overrides.monitorId ?? "monitor-1";
    return {
      monitorId,
      agentId: "main",
      originSessionKey: sessionKey,
      monitorSessionKey: `agent:main:monitor:${monitorId}`,
      sourceType: "gmail",
      sourceTarget: { account: "me@example.com", threadId: monitorId },
      cadence: { kind: "every", everyMs: 300_000 },
      actionPolicy: "notify_draft",
      goal: { id: "goal-1", objective: "Get the refund confirmed." },
      status: "active",
      cronJobId: `cron-${monitorId}`,
      createdAtMs: 1,
      updatedAtMs: 1,
      ...overrides,
    };
  }

  it("includes active and degraded monitors bound to the current goal", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
    });
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        buildMonitor({
          monitorId: "monitor-active",
          name: "Refund thread",
          goal: { id: goal.id, objective: goal.objective },
          status: "active",
          actionPolicy: "notify_draft",
          lastWakeStatus: "active",
          updatedAtMs: 20,
          expiryAt: "2026-07-05T00:00:00.000Z",
        }),
        buildMonitor({
          monitorId: "monitor-degraded",
          goal: { id: goal.id, objective: goal.objective },
          status: "degraded",
          sourceType: "telegram-user",
          actionPolicy: "auto_send",
          lastWakeStatus: "degraded",
          updatedAtMs: 30,
        }),
      ],
    });

    const get = createGetGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const snapshot = await get.execute?.("call-get-waits", {});

    expect(snapshot?.details).toMatchObject({
      status: "found",
      waitingOnMonitors: [
        {
          monitorId: "monitor-active",
          status: "active",
          name: "Refund thread",
          sourceType: "gmail",
          actionPolicy: "notify_draft",
          lastWakeStatus: "active",
          updatedAtMs: 20,
          expiryAt: "2026-07-05T00:00:00.000Z",
        },
        {
          monitorId: "monitor-degraded",
          status: "degraded",
          sourceType: "telegram-user",
          actionPolicy: "auto_send",
          lastWakeStatus: "degraded",
          updatedAtMs: 30,
        },
      ],
    });
    expect(JSON.stringify(snapshot?.details)).not.toContain("sourceTarget");
    expect(JSON.stringify(snapshot?.details)).not.toContain("cronJobId");
    expect(JSON.stringify(snapshot?.details)).not.toContain("trigger");
  });

  it("omits terminal monitors from current goal waits", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
    });
    const goalSnapshot = { id: goal.id, objective: goal.objective };
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        buildMonitor({ monitorId: "monitor-stopped", goal: goalSnapshot, status: "stopped" }),
        buildMonitor({ monitorId: "monitor-completed", goal: goalSnapshot, status: "completed" }),
        buildMonitor({ monitorId: "monitor-expired", goal: goalSnapshot, status: "expired" }),
      ],
    });

    const get = createGetGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const snapshot = await get.execute?.("call-get-terminal", {});

    expect(snapshot?.details).toMatchObject({ status: "found" });
    expect(snapshot?.details).not.toHaveProperty("waitingOnMonitors");
  });

  it("omits monitors bound to unrelated goal IDs", async () => {
    await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
    });
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [buildMonitor({ goal: { id: "goal-other", objective: "Do something else." } })],
    });

    const get = createGetGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const snapshot = await get.execute?.("call-get-other-goal", {});

    expect(snapshot?.details).toMatchObject({ status: "found" });
    expect(snapshot?.details).not.toHaveProperty("waitingOnMonitors");
  });

  it("omits monitors with the same goal ID but a different origin session", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
    });
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        buildMonitor({
          goal: { id: goal.id, objective: goal.objective },
          originSessionKey: "agent:main:telegram:direct:999",
        }),
      ],
    });

    const get = createGetGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const snapshot = await get.execute?.("call-get-other-origin", {});

    expect(snapshot?.details).toMatchObject({ status: "found" });
    expect(snapshot?.details).not.toHaveProperty("waitingOnMonitors");
  });

  it("resolves origin-scope waits when get_goal is called from a monitor session", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
    });
    const monitorSessionKey = "agent:main:monitor:monitor-origin";
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [
        buildMonitor({
          monitorId: "monitor-origin",
          monitorSessionKey,
          goal: { id: goal.id, objective: goal.objective },
          status: "active",
          updatedAtMs: 40,
        }),
      ],
    });

    const get = createGetGoalTool({
      agentSessionKey: monitorSessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const snapshot = await get.execute?.("call-get-monitor-session", {});

    expect(snapshot?.details).toMatchObject({
      status: "found",
      goal: { id: goal.id, objective: goal.objective },
      waitingOnMonitors: [{ monitorId: "monitor-origin", updatedAtMs: 40 }],
    });
  });

  it("keeps missing goals unchanged without empty waiting metadata", async () => {
    await saveMonitorStore(monitorStorePath, {
      version: 1,
      monitors: [buildMonitor({ monitorId: "monitor-without-goal-session" })],
    });

    const get = createGetGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath }, cron: { store: cronStorePath } },
    });
    const snapshot = await get.execute?.("call-get-missing", {});

    expect(snapshot?.details).toEqual({ status: "missing" });
  });
});
