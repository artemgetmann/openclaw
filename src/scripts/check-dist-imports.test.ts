import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findMissingDistImports,
  formatMissingDistImports,
} from "../../scripts/check-dist-imports.mjs";

describe("check dist imports", () => {
  async function withDistFixture(run: (distDir: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dist-imports-"));
    try {
      const distDir = path.join(root, "dist");
      await fs.mkdir(distDir, { recursive: true });
      await run(distDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("passes when generated relative chunks exist", async () => {
    await withDistFixture(async (distDir) => {
      await fs.writeFile(
        path.join(distDir, "setup-surface-current.js"),
        `await import("./provider-runtime.runtime-current.js");\nexport { x } from "./shared.js";\n`,
      );
      await fs.writeFile(path.join(distDir, "provider-runtime.runtime-current.js"), "export {};\n");
      await fs.writeFile(path.join(distDir, "shared.js"), "export const x = 1;\n");

      expect(findMissingDistImports(distDir)).toEqual([]);
    });
  });

  it("reports missing dynamic chunks with the importing file", async () => {
    await withDistFixture(async (distDir) => {
      await fs.writeFile(
        path.join(distDir, "setup-surface-stale.js"),
        `const runtime = () => import("./provider-runtime.runtime-stale.js");\n`,
      );

      const missing = findMissingDistImports(distDir);

      expect(missing).toEqual([
        {
          importer: "setup-surface-stale.js",
          specifier: "./provider-runtime.runtime-stale.js",
          missing: "provider-runtime.runtime-stale.js",
        },
      ]);
      expect(formatMissingDistImports(missing)).toContain(
        "setup-surface-stale.js imports ./provider-runtime.runtime-stale.js",
      );
    });
  });

  it("ignores import-looking text in generated comments", async () => {
    await withDistFixture(async (distDir) => {
      await fs.writeFile(
        path.join(distDir, "comments.js"),
        [
          `// import "./comment-only.js";`,
          `/* @typedef {import("./types-only.js").Thing} Thing */`,
          `/* @import {Thing} from './jsdoc-only.js'; */`,
          `const actual = () => import("./actual.js");`,
        ].join("\n"),
      );
      await fs.writeFile(path.join(distDir, "actual.js"), "export {};\n");

      expect(findMissingDistImports(distDir)).toEqual([]);
    });
  });
});
