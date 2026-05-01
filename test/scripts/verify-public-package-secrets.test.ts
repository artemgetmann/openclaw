import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPublicPackageSecretFindings } from "../../scripts/verify-public-package-secrets.mjs";

describe("scripts/verify-public-package-secrets.mjs", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-public-package-secrets-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags raw provider keys in consumer seeded defaults", async () => {
    await fs.mkdir(path.join(root, "Contents", "Resources"), { recursive: true });
    await fs.writeFile(
      path.join(root, "Contents", "Resources", "consumer-seeded-defaults.json"),
      JSON.stringify(
        {
          env: {
            vars: {
              OPENAI_API_KEY: "plain-provider-value",
            },
          },
          tools: {
            web: {
              search: {
                apiKey: "plain-search-provider-value",
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const findings = await findPublicPackageSecretFindings(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "Contents/Resources/consumer-seeded-defaults.json",
          location: "env.vars.OPENAI_API_KEY",
        }),
        expect.objectContaining({
          file: "Contents/Resources/consumer-seeded-defaults.json",
          location: "tools.web.search.apiKey",
        }),
      ]),
    );
  });

  it("allows BYOK references and managed backend config without provider keys", async () => {
    await fs.mkdir(path.join(root, "Contents", "Resources"), { recursive: true });
    await fs.writeFile(
      path.join(root, "Contents", "Resources", "consumer-seeded-defaults.json"),
      JSON.stringify(
        {
          jarvis: {
            backend: {
              baseUrl: "https://jarvis.example.invalid",
            },
            managedServices: {
              mode: "managed",
            },
          },
          tools: {
            media: {
              audio: {
                models: [{ provider: "openai", apiKey: "${OPENAI_API_KEY}" }],
              },
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(findPublicPackageSecretFindings(root)).resolves.toEqual([]);
  });

  it("ignores dependency package metadata while scanning app-owned surfaces", async () => {
    const packageJson = path.join(root, "Contents", "Resources", "node_modules", "dep");
    await fs.mkdir(packageJson, { recursive: true });
    await fs.writeFile(
      path.join(packageJson, "package.json"),
      JSON.stringify({ config: { apiKey: "example-package-value" } }),
    );

    await expect(findPublicPackageSecretFindings(root)).resolves.toEqual([]);
  });
});
