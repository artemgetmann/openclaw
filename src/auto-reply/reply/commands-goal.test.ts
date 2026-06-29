import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateSessionStore } from "../../config/sessions.js";
import { handleGoalCommand, parseGoalCommand } from "./commands-goal.js";
import type { HandleCommandsParams } from "./commands-types.js";

describe("goal command", () => {
  let tempDir = "";
  let storePath = "";
  const sessionKey = "agent:main:telegram:direct:123";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-goal-command-"));
    storePath = path.join(tempDir, "sessions.json");
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = { sessionId: "session-1", updatedAt: 1 };
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function params(commandBody: string): HandleCommandsParams {
    const ctx = { Body: commandBody } as never;
    return {
      ctx,
      cfg: {} as never,
      command: {
        surface: "text",
        channel: "telegram",
        ownerList: [],
        senderIsOwner: true,
        isAuthorizedSender: true,
        rawBodyNormalized: commandBody,
        commandBodyNormalized: commandBody,
      },
      directives: {} as never,
      elevated: { enabled: false, allowed: false, failures: [] },
      sessionStore: {},
      sessionKey,
      storePath,
      workspaceDir: tempDir,
      defaultGroupActivation: () => "always",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      provider: "test",
      model: "test",
      contextTokens: 0,
      isGroup: false,
    };
  }

  it("parses explicit and shorthand goal commands", () => {
    expect(parseGoalCommand("/goal")).toEqual({ action: "status", text: "" });
    expect(parseGoalCommand("/goal start get a refund")).toEqual({
      action: "start",
      text: "get a refund",
    });
    expect(parseGoalCommand("/goal get a refund")).toEqual({
      action: "start",
      text: "get a refund",
    });
  });

  it("starts a goal and rewrites the agent continuation prompt", async () => {
    const commandParams = params("/goal start get a refund");
    const result = await handleGoalCommand(commandParams, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(commandParams.command.commandBodyNormalized).toBe("get a refund");
    expect((commandParams.ctx as { Body?: string }).Body).toBe("get a refund");

    const status = await handleGoalCommand(params("/goal"), true);
    expect(status?.reply?.text).toContain("Objective: get a refund");
  });

  it("pauses, resumes, completes, blocks, and clears a goal", async () => {
    await handleGoalCommand(params("/goal start organize dinner"), true);
    expect((await handleGoalCommand(params("/goal pause waiting"), true))?.reply?.text).toContain(
      "Goal paused",
    );
    expect((await handleGoalCommand(params("/goal resume"), true))?.shouldContinue).toBe(true);
    expect(
      (await handleGoalCommand(params("/goal block need input"), true))?.reply?.text,
    ).toContain("Goal blocked");
    expect((await handleGoalCommand(params("/goal complete agreed"), true))?.reply?.text).toContain(
      "Goal complete",
    );
    expect((await handleGoalCommand(params("/goal clear"), true))?.reply?.text).toBe(
      "Goal cleared.",
    );
  });
});
