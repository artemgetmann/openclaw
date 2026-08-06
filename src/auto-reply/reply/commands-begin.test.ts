import { describe, expect, it } from "vitest";
import { handleBeginCommand, PERSONAL_SETUP_PROMPT } from "./commands-begin.js";
import { handleCommands } from "./commands-core.js";
import type { HandleCommandsParams } from "./commands-types.js";

function createParams(
  commandBody: string,
  options: {
    chatType?: string;
    contextAllowFrom?: string[];
    ownerAllowFrom?: string[];
    senderIsOwner?: boolean;
    withRootCtx?: boolean;
  } = {},
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    RawBody: commandBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    BodyForAgent: commandBody,
    BodyStripped: commandBody,
    ChatType: options.chatType ?? "direct",
    ContextAllowFrom: options.contextAllowFrom,
    OwnerAllowFrom: options.ownerAllowFrom,
  };
  const rootCtx = options.withRootCtx
    ? {
        Body: commandBody,
        RawBody: commandBody,
        CommandBody: commandBody,
        BodyForCommands: commandBody,
        BodyForAgent: commandBody,
        BodyStripped: commandBody,
        ChatType: options.chatType ?? "direct",
        ContextAllowFrom: options.contextAllowFrom,
        OwnerAllowFrom: options.ownerAllowFrom,
      }
    : undefined;
  return {
    ctx: ctx as never,
    rootCtx: rootCtx as never,
    cfg: {} as never,
    command: {
      surface: "text",
      channel: "telegram",
      ownerList: options.ownerAllowFrom ?? ["owner"],
      senderIsOwner: options.senderIsOwner ?? true,
      isAuthorizedSender: true,
      senderId: "owner",
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
    },
    directives: {} as never,
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: "agent:main:telegram:test",
    workspaceDir: "/tmp/test-workspace",
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "test",
    model: "test",
    contextTokens: 0,
    isGroup: (options.chatType ?? "direct") !== "direct",
  };
}

function expectPromptApplied(ctx: HandleCommandsParams["ctx"]): void {
  expect(ctx).toMatchObject({
    Body: PERSONAL_SETUP_PROMPT,
    RawBody: PERSONAL_SETUP_PROMPT,
    CommandBody: PERSONAL_SETUP_PROMPT,
    BodyForCommands: PERSONAL_SETUP_PROMPT,
    BodyForAgent: PERSONAL_SETUP_PROMPT,
    BodyStripped: PERSONAL_SETUP_PROMPT,
  });
}

describe("begin command", () => {
  it.each(["/begin", "/init"])("continues Personal Setup for owner command %s", async (command) => {
    const params = createParams(command);

    expect(await handleBeginCommand(params, true)).toEqual({ shouldContinue: true });
    expectPromptApplied(params.ctx);
    expect(params.command.rawBodyNormalized).toBe(PERSONAL_SETUP_PROMPT);
    expect(params.command.commandBodyNormalized).toBe(PERSONAL_SETUP_PROMPT);
  });

  it("allows an owner-only personal group or topic", async () => {
    const params = createParams("/begin", {
      chatType: "group",
      ownerAllowFrom: ["owner"],
      contextAllowFrom: ["owner"],
    });

    expect(await handleBeginCommand(params, true)).toEqual({ shouldContinue: true });
    expectPromptApplied(params.ctx);
  });

  it("refuses a genuinely shared session with private-space guidance", async () => {
    const params = createParams("/begin", {
      chatType: "group",
      ownerAllowFrom: ["owner"],
      contextAllowFrom: ["owner", "guest"],
    });

    const result = await handleBeginCommand(params, true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Personal Setup needs a private or owner-only Jarvis space. Open one there and send /begin again.",
      },
    });
    expect(params.ctx.Body).toBe("/begin");
  });

  it("refuses a non-owner", async () => {
    const params = createParams("/begin", { senderIsOwner: false });

    expect(await handleBeginCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: "Personal Setup is only available to the Jarvis owner." },
    });
    expect(params.ctx.Body).toBe("/begin");
  });

  it("keeps the root context synchronized", async () => {
    const params = createParams("/begin", { withRootCtx: true });

    expect(await handleBeginCommand(params, true)).toEqual({ shouldContinue: true });
    expectPromptApplied(params.ctx);
    expectPromptApplied(params.rootCtx as HandleCommandsParams["ctx"]);
  });

  it.each(["/begin now", "/init review", "/start", "begin", "hello"])(
    "ignores unrelated or argument-bearing input %s",
    async (command) => {
      const params = createParams(command);
      expect(await handleBeginCommand(params, true)).toBeNull();
      expect(params.ctx.Body).toBe(command);
    },
  );

  it("is wired into the core command pipeline", async () => {
    const params = createParams("/begin");

    expect(await handleCommands(params)).toEqual({ shouldContinue: true });
    expectPromptApplied(params.ctx);
  });
});
