import { describe, expect, it } from "vitest";
import { appendCronDeliveryInstruction } from "./run.js";

describe("appendCronDeliveryInstruction", () => {
  it("keeps reply mode strict and reply-only for automatic delivery", () => {
    const message = appendCronDeliveryInstruction({
      commandBody: "Base prompt",
      deliveryRequested: true,
      deliveryPromptMode: "reply",
    });

    expect(message).toContain("Return only the exact reply content to deliver automatically.");
    expect(message).toContain("Write it like a direct reply, not a monitor note.");
    expect(message).toContain(
      "If the task needs user input or approval, use the message tool to ask on the configured origin route from the monitor instructions, then return exactly NO_REPLY.",
    );
    expect(message).toContain("If no message should be sent, return exactly NO_REPLY.");
  });

  it("frames summary mode as natural assistant language for delivery", () => {
    const message = appendCronDeliveryInstruction({
      commandBody: "Base prompt",
      deliveryRequested: true,
      deliveryPromptMode: "summary",
    });

    expect(message).toContain("Write your response like an assistant talking to the user");
    expect(message).toContain("Return plain text only.");
    expect(message).toContain("note who/where it should go instead of sending it yourself");
  });
});
