#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = path.resolve(process.argv[2] || "");
const packageJson = path.join(runtimeRoot, "package.json");
const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
const requiredPackages = ["docx", "exceljs", "pdf-lib", "pptxgenjs"];

if (!process.argv[2] || !fs.existsSync(packageJson)) {
  console.error(`ERROR: document-creation runtime package is missing: ${packageJson}`);
  process.exit(1);
}

// Resolve from the staged runtime, not this source checkout. This makes the
// package gate fail when pnpm deploy, pruning, or cache reuse drops a creator
// dependency even though the developer's full node_modules can still import it.
const requireFromRuntime = createRequire(packageJson);
const missing = [];
for (const packageName of requiredPackages) {
  try {
    const resolved = fs.realpathSync(requireFromRuntime.resolve(packageName));
    const nodeModulesRoot = fs.realpathSync(runtimeNodeModules);
    const relative = path.relative(nodeModulesRoot, resolved);
    // Node resolution walks parent directories. Reject any result outside the
    // staged tree so a checkout's ambient node_modules cannot satisfy this
    // release gate for an incomplete app bundle or runtime cache.
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      missing.push(packageName);
      continue;
    }
    // Resolution alone does not prove that transitive dependencies survived
    // deploy and pruning. Load the staged entry point exactly as packaged.
    await import(pathToFileURL(resolved).href);
  } catch {
    missing.push(packageName);
  }
}

if (missing.length > 0) {
  console.error("ERROR: bundled Jarvis document creation runtime is incomplete.");
  console.error(
    `Missing required package${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
  );
  console.error(`Runtime root: ${runtimeRoot}`);
  process.exit(1);
}

console.log(`Document creation runtime complete: ${requiredPackages.join(", ")}`);
