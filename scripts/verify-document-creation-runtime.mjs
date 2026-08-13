#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const runtimeRoot = path.resolve(process.argv[2] || "");
const packageJson = path.join(runtimeRoot, "package.json");
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
    requireFromRuntime.resolve(packageName);
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
