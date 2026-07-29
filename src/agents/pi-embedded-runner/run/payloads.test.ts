import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { buildPayloads, expectSingleToolErrorPayload } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  it("suppresses exec tool errors when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });

    expect(payloads).toHaveLength(0);
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      absentDetail: "permission denied",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
    {
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel,
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail,
      absentDetail,
    });
  });

  it("suppresses sessions_send errors to avoid leaking transient relay failures", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "sessions_send", error: "delivery timeout" },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses sessions_send errors even when marked mutating", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "sessions_send",
        error: "delivery timeout",
        mutatingAction: true,
      },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(0);
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });

    expect(payloads).toHaveLength(0);
  });

  it("lets terminal NO_REPLY suppress earlier tool-adjacent commentary", () => {
    const lastAssistant: AssistantMessage = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "NO_REPLY" }],
    });

    const payloads = buildPayloads({
      assistantTexts: ["Checking the watched Telegram chat for fresh evidence.", "NO_REPLY"],
      lastAssistant,
    });

    expect(payloads).toHaveLength(0);
  });

  it("does not let an errored NO_REPLY-shaped assistant hide the failure", () => {
    const lastAssistant: AssistantMessage = makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: "provider failed",
      content: [{ type: "text", text: "NO_REPLY" }],
    });

    const payloads = buildPayloads({ lastAssistant });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
  });
});
