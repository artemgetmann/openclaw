import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionGoal, getSessionGoal, updateSessionStore } from "../../config/sessions.js";
import { resolveMonitorStorePath, saveMonitorStore } from "../../monitor/store.js";
import { createCreateGoalTool, createGetGoalTool, createUpdateGoalTool } from "./goal-tools.js";

describe("goal tools", () => {
  let tempDir = "";
  let storePath = "";
  const sessionKey = "agent:main:telegram:direct:123";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-goal-tools-"));
    storePath = path.join(tempDir, "sessions.json");
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
      config: { session: { store: storePath } },
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
      config: { session: { store: storePath } },
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
    const cronStorePath = path.join(tempDir, "cron", "jobs.json");
    const monitorSessionKey = "agent:main:monitor:monitor-1";
    await saveMonitorStore(resolveMonitorStorePath({ cronStorePath }), {
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
});
