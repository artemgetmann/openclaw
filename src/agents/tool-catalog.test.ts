import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("includes core coding tools in the coding profile policy", () => {
    const policy = resolveCoreToolProfilePolicy("coding");
    expect(policy).toBeDefined();
    expect(policy!.allow).toContain("web_search");
    expect(policy!.allow).toContain("web_fetch");
    expect(policy!.allow).toContain("image_generate");
    expect(policy!.allow).toContain("monitor");
  });
});
