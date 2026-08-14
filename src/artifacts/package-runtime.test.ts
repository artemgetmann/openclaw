import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

describe("document creation runtime verifier", () => {
  it("fails when any discovered artifacts CLI route has a missing creator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-document-runtime-gate-"));
    await writeFixture(root, "package.json", JSON.stringify({ type: "module" }));
    // Keep the fixture self-contained so ambient node_modules cannot satisfy
    // the verifier's staged-runtime package check.
    await writeFixture(
      root,
      "node_modules/jszip/package.json",
      JSON.stringify({ name: "jszip", type: "module", exports: "./index.js" }),
    );
    await writeFixture(root, "node_modules/jszip/index.js", "export default {};\n");
    await writeFixture(
      root,
      "dist/artifacts-good.js",
      [
        "export const artifactsCreatePdfCommand = () => {};",
        "export const artifactsCreateDocxCommand = () => {};",
        "export const artifactsCreateXlsxCommand = () => {};",
        "export const artifactsCreatePptxCommand = () => {};",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "dist/artifacts-cli-a.js",
      'export const load = () => import("./artifacts-good.js");\n',
    );
    await writeFixture(
      root,
      "dist/artifacts-cli-b.js",
      'export const load = () => import("./artifacts-missing.js");\n',
    );

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/verify-document-creation-runtime.mjs"), root],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ERROR: bundled Jarvis document creation runtime is incomplete.",
    );
    expect(result.stderr).toContain(
      "artifacts-cli-b.js: missing or unloadable ./artifacts-missing.js",
    );
  });
});
