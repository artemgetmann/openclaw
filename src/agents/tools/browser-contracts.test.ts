import { describe, expect, it } from "vitest";
import { executeBrowserContractAction, __testing } from "./browser-contracts.js";

describe("browser contracts", () => {
  it("resolves X/Twitter URLs to the site-specific posting contract", () => {
    const contract = __testing.resolveBrowserContract("https://x.com/compose/post");

    expect(contract?.id).toBe("x");
  });

  it("resolves Gmail and LinkedIn URLs to site-specific contracts", () => {
    expect(__testing.resolveBrowserContract("https://mail.google.com/mail/u/0/#inbox")?.id).toBe(
      "gmail",
    );
    expect(__testing.resolveBrowserContract("https://www.linkedin.com/feed/")?.id).toBe("linkedin");
  });

  it("falls back to the generic external mutation contract", () => {
    const result = executeBrowserContractAction({
      url: "https://example.com/admin/delete",
      intent: "external_mutation",
    });

    expect(result.details).toMatchObject({
      ok: true,
      contractId: "generic-external-mutation",
      contractAvailable: false,
      intent: "external_mutation",
    });
    expect(result.details.contract.requiredFlow).toContain(
      "verify the final artifact contains the expected text, media, target, and state before reporting success",
    );
  });

  it("returns the X contract with rich-editor and final-artifact proof guidance", () => {
    const result = executeBrowserContractAction({
      url: "https://x.com/compose/post",
      intent: "post",
    });

    expect(result.details).toMatchObject({
      ok: true,
      contractId: "x",
      contractAvailable: true,
      intent: "post",
    });
    expect(result.details.contract.hazards.join(" ")).toMatch(/rich app-controlled composers/i);
    expect(result.details.contract.avoid.join(" ")).toMatch(/composer snapshots alone/i);
    expect(result.details.contract.proof.join(" ")).toMatch(/expected caption/i);
  });

  it("keeps contracts small and proof-oriented for lazy loading", () => {
    const result = executeBrowserContractAction({
      url: "https://mail.google.com/mail/u/0/#inbox",
      intent: "send",
    });

    expect(result.details).toMatchObject({
      ok: true,
      contractId: "gmail",
      contractAvailable: true,
      intent: "send",
    });
    expect(JSON.stringify(result.details.contract)).toMatch(/sent-message artifact/i);
    expect(JSON.stringify(result.details.contract)).toMatch(/explicit user approval/i);
  });
});
