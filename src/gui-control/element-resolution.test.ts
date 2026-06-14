import { describe, expect, it } from "vitest";
import { resolveElementRef } from "./element-resolution.js";
import type { GuiSnapshot } from "./types.js";

function snapshot(elements: GuiSnapshot["elements"]): GuiSnapshot {
  return {
    id: "s1",
    appName: "Claude",
    windowTitle: "Claude",
    elements,
  };
}

describe("resolveElementRef", () => {
  it("resolves an exact ref from the latest snapshot", () => {
    const result = resolveElementRef(snapshot([{ ref: "@input", role: "textArea" }]), {
      ref: "@input",
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.element.ref : "").toBe("@input");
  });

  it("resolves a unique text input by intent and label", () => {
    const result = resolveElementRef(
      snapshot([
        { ref: "@title", role: "text", label: "Title" },
        { ref: "@message", role: "textArea", label: "Message Claude composer" },
      ]),
      { intent: "text-input", labelIncludes: "message" },
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.element.ref : "").toBe("@message");
  });

  it("matches button intent and labelIncludes against AX description", () => {
    const result = resolveElementRef(
      snapshot([
        { ref: "@composer", role: "textArea", label: "Message" },
        { ref: "@send", role: "button", description: "Send message" },
      ]),
      { intent: "button", labelIncludes: "send message" },
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.element.ref : "").toBe("@send");
  });

  it("does not treat a send-message button as a text input", () => {
    const result = resolveElementRef(
      snapshot([
        {
          ref: "@composer",
          role: "textfield",
          label: "Write your prompt to Claude",
          value: "Write a message…",
        },
        { ref: "@send", role: "button", description: "Send message" },
      ]),
      { intent: "text-input", labelIncludes: "message" },
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.element.ref : "").toBe("@composer");
  });

  it("fails closed when a semantic match is ambiguous", () => {
    const result = resolveElementRef(
      snapshot([
        { ref: "@a", role: "button", label: "Send" },
        { ref: "@b", role: "button", label: "Send later" },
      ]),
      { intent: "button", labelIncludes: "send" },
    );

    expect(result.ok).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(result.summary).toContain("refusing to guess");
  });
});
