import { describe, expect, it } from "vitest";
import { resolveReplyRunPayloads } from "./run-result-payloads.js";

describe("resolveReplyRunPayloads", () => {
  it("restores intentional silence after render payload normalization", () => {
    expect(resolveReplyRunPayloads({ payloads: [], meta: { silentReply: true } })).toEqual([
      { text: "NO_REPLY" },
    ]);
  });

  it("keeps a genuinely empty provider result empty", () => {
    expect(resolveReplyRunPayloads({ payloads: [], meta: {} })).toEqual([]);
  });
});
