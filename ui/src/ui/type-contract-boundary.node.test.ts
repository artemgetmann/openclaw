import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));

// These modules are runtime implementations with large transitive graphs. UI code must consume the
// matching declaration-only contracts instead, otherwise its typecheck graph absorbs core again.
const FORBIDDEN_UI_IMPORTS = new Set(
  [
    "../../../src/agents/model-catalog.js",
    "../../../src/config/sessions/types.js",
    "../../../src/gateway/events.js",
    "../../../src/infra/session-cost-usage.js",
    "../../../src/infra/update-startup.js",
  ].map((relativePath) => path.resolve(UI_ROOT, relativePath)),
);

const CONTRACT_FILES = [
  "../../../src/shared/model-catalog-contract.ts",
  "../../../src/shared/session-system-prompt-report.ts",
  "../../../src/shared/update-contract.ts",
  "../../../src/shared/usage-normalization-contract.ts",
];

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function importSpecifiers(source: string): string[] {
  // Cover static imports, re-exports, and dynamic imports without pretending to parse arbitrary TS.
  // Import paths in this repository are string literals, so this deliberately narrow scan is stable.
  return [
    ...source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
    ),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

describe("UI type contract boundaries", () => {
  it("keeps UI imports off dense runtime implementations", () => {
    const violations = collectTypeScriptFiles(UI_ROOT).flatMap((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return importSpecifiers(source)
        .filter((specifier) =>
          specifier.startsWith(".")
            ? FORBIDDEN_UI_IMPORTS.has(path.resolve(path.dirname(filePath), specifier))
            : false,
        )
        .map((specifier) => `${path.relative(UI_ROOT, filePath)} -> ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  it("keeps extracted contract leaves dependency-free", () => {
    const violations = CONTRACT_FILES.flatMap((relativePath) => {
      const filePath = path.resolve(UI_ROOT, relativePath);
      return importSpecifiers(fs.readFileSync(filePath, "utf8")).map(
        (specifier) => `${relativePath} -> ${specifier}`,
      );
    });

    expect(violations).toEqual([]);
  });
});
