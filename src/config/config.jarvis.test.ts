import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

type ConfigValidationResult =
  | { ok: true; config: OpenClawConfig }
  | { ok: false; issues: ConfigValidationIssue[] };

function expectConfigRejected(result: ConfigValidationResult): asserts result is {
  ok: false;
  issues: ConfigValidationIssue[];
} {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected config validation to reject");
  }
}

describe("Jarvis commercial backend config", () => {
  it("accepts an inert missing config", () => {
    expect(() => OpenClawSchema.parse({})).not.toThrow();
  });

  it("accepts backend URL and managed services mode", () => {
    const result = validateConfigObject({
      jarvis: {
        backend: {
          baseUrl: "https://jarvis.example",
          accessToken: { source: "env", provider: "default", id: "JARVIS_ACCESS_TOKEN" },
          deviceId: "device-1",
          timeoutMs: 5000,
        },
        managedServices: {
          mode: "license-only",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects non-http backend URLs", () => {
    const result = validateConfigObject({
      jarvis: {
        backend: {
          baseUrl: "file:///tmp/jarvis.sock",
        },
      },
    });

    expectConfigRejected(result);
    expect(result.issues[0]?.path).toBe("jarvis.backend.baseUrl");
  });

  it("rejects unknown managed services modes", () => {
    const result = validateConfigObject({
      jarvis: {
        managedServices: {
          mode: "always-on",
        },
      },
    });

    expectConfigRejected(result);
    expect(result.issues[0]?.path).toBe("jarvis.managedServices.mode");
  });
});
