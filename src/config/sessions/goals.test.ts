import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionGoal,
  createSessionGoal,
  getSessionGoal,
  updateSessionGoalStatus,
} from "./goals.js";
import { loadSessionStore, updateSessionStore } from "./store.js";

describe("session goals", () => {
  let tempDir = "";
  let storePath = "";
  const sessionKey = "agent:main:telegram:direct:123";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-goals-"));
    storePath = path.join(tempDir, "sessions.json");
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: "session-1",
        updatedAt: 1,
        totalTokens: 10,
        totalTokensFresh: true,
      };
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, reads, updates, and clears one goal per session", async () => {
    const goal = await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Get the refund confirmed.",
      tokenBudget: 100,
      now: 1000,
    });

    expect(goal.objective).toBe("Get the refund confirmed.");
    expect(goal.status).toBe("active");
    await expect(
      createSessionGoal({ sessionKey, storePath, objective: "Replace it" }),
    ).rejects.toThrow("goal already exists");

    const found = await getSessionGoal({ sessionKey, storePath, persist: false });
    expect(found.goal?.objective).toBe("Get the refund confirmed.");

    const blocked = await updateSessionGoalStatus({
      sessionKey,
      storePath,
      status: "blocked",
      note: "Need order number.",
      now: 2000,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastStatusNote).toBe("Need order number.");

    await expect(clearSessionGoal({ sessionKey, storePath })).resolves.toBe(true);
    expect((await getSessionGoal({ sessionKey, storePath })).status).toBe("missing");
  });

  it("accounts token budgets from fresh session usage", async () => {
    await createSessionGoal({
      sessionKey,
      storePath,
      objective: "Finish the dinner plan.",
      tokenBudget: 15,
      now: 1000,
    });
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        ...store[sessionKey],
        totalTokens: 30,
        totalTokensFresh: true,
      };
    });

    const snapshot = await getSessionGoal({ sessionKey, storePath, now: 2000 });
    expect(snapshot.goal?.tokensUsed).toBe(20);
    expect(snapshot.goal?.status).toBe("budget_limited");

    const store = loadSessionStore(storePath);
    expect(store[sessionKey]?.goal?.status).toBe("budget_limited");
  });
});
