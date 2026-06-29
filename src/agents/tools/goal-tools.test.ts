import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateSessionStore } from "../../config/sessions.js";
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

  it("rejects invalid token budgets and model-updated statuses", async () => {
    const create = createCreateGoalTool({
      agentSessionKey: sessionKey,
      config: { session: { store: storePath } },
    });
    await expect(
      create.execute?.("call-1", { objective: "Do it.", token_budget: 0 }),
    ).rejects.toThrow("token_budget must be positive");
  });
});
