import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, validateConfigObject } from "./config.js";
import { withTempHome } from "./home-env.test-harness.js";
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

  it("accepts backend URL, account summary, and managed services mode", () => {
    const result = validateConfigObject({
      jarvis: {
        backend: {
          baseUrl: "https://jarvis.example",
          account: {
            accountId: "acct_123",
            email: "founder@example.com",
            license: "pro",
          },
          accessToken: { source: "env", provider: "default", id: "JARVIS_ACCESS_TOKEN" },
          deviceId: "device-1",
          accountAccessToken: {
            source: "env",
            provider: "default",
            id: "JARVIS_ACCOUNT_ACCESS_TOKEN",
          },
          accountEmail: "founder@example.com",
          timeoutMs: 5000,
        },
        managedServices: {
          mode: "license-only",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("loads account summary from config and preserves accountAccessToken handling", async () => {
    await withTempHome("openclaw-jarvis-config-", async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            jarvis: {
              backend: {
                baseUrl: "https://jarvis.example",
                account: {
                  accountId: "acct_123",
                  email: "founder@example.com",
                  license: "pro",
                },
                accountAccessToken: {
                  source: "env",
                  provider: "default",
                  id: "JARVIS_ACCOUNT_ACCESS_TOKEN",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const config = loadConfig();

      expect(config.jarvis?.backend?.account).toEqual({
        accountId: "acct_123",
        email: "founder@example.com",
        license: "pro",
      });
      expect(config.jarvis?.backend?.accountAccessToken).toEqual({
        source: "env",
        provider: "default",
        id: "JARVIS_ACCOUNT_ACCESS_TOKEN",
      });
    });
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
