#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = path.resolve(process.argv[2] || "");
const packageJson = path.join(runtimeRoot, "package.json");
const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
const requiredPackages = ["jszip"];
const runtimeDist = path.join(runtimeRoot, "dist");

if (!process.argv[2] || !fs.existsSync(packageJson)) {
  console.error(`ERROR: document-creation runtime package is missing: ${packageJson}`);
  process.exit(1);
}

// Resolve from the staged runtime, not this source checkout. This makes the
// package gate fail when pnpm deploy, pruning, or cache reuse drops a creator
// dependency even though the developer's full node_modules can still import it.
const requireFromRuntime = createRequire(packageJson);
const missingPackages = [];
const runtimeRealPath = fs.realpathSync(runtimeRoot);
const nodeModulesRoot = fs.existsSync(runtimeNodeModules)
  ? fs.realpathSync(runtimeNodeModules)
  : runtimeNodeModules;
for (const packageName of requiredPackages) {
  try {
    const resolved = fs.realpathSync(requireFromRuntime.resolve(packageName));
    const relative = path.relative(nodeModulesRoot, resolved);
    // Node resolution walks parent directories. Reject any result outside the
    // staged tree so a checkout's ambient node_modules cannot satisfy this
    // release gate for an incomplete app bundle or runtime cache.
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      missingPackages.push(packageName);
      continue;
    }
    // Resolution alone does not prove that transitive dependencies survived
    // deploy and pruning. Load the staged entry point exactly as packaged.
    await import(pathToFileURL(resolved).href);
  } catch {
    missingPackages.push(packageName);
  }
}

let creatorReady = false;
let creatorComponent = path.join(runtimeDist, "artifacts-<hash>.js");
try {
  // The build gives lazy CLI chunks content hashes. Read the packaged CLI route
  // to locate the exact compiled creator it will load instead of accepting a
  // stale source file or guessing a hash.
  const cliChunks = fs
    .readdirSync(runtimeDist)
    .filter((name) => /^artifacts-cli-.*\.js$/u.test(name));
  for (const cliChunk of cliChunks) {
    const cliSource = fs.readFileSync(path.join(runtimeDist, cliChunk), "utf8");
    const creatorImport = cliSource.match(/import\("(\.\/artifacts-(?!cli-)[^"]+\.js)"\)/u)?.[1];
    if (!creatorImport) {
      continue;
    }
    const resolvedCreator = fs.realpathSync(path.resolve(runtimeDist, creatorImport));
    const relative = path.relative(runtimeRealPath, resolvedCreator);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    const creator = await import(pathToFileURL(resolvedCreator).href);
    const requiredExports = [
      "artifactsCreatePdfCommand",
      "artifactsCreateDocxCommand",
      "artifactsCreateXlsxCommand",
      "artifactsCreatePptxCommand",
    ];
    if (requiredExports.every((name) => typeof creator[name] === "function")) {
      creatorComponent = resolvedCreator;
      creatorReady = true;
      break;
    }
  }
} catch {
  creatorReady = false;
}

if (missingPackages.length > 0 || !creatorReady) {
  console.error("ERROR: bundled Jarvis document creation runtime is incomplete.");
  if (missingPackages.length > 0) {
    console.error(
      `Missing required package${missingPackages.length === 1 ? "" : "s"}: ${missingPackages.join(", ")}`,
    );
  }
  if (!creatorReady) {
    console.error(`Missing or unloadable compiled creator: ${creatorComponent}`);
  }
  console.error(`Runtime root: ${runtimeRoot}`);
  process.exit(1);
}

console.log(
  `Document creation runtime complete: ${requiredPackages.join(", ")}; ${path.relative(runtimeRoot, creatorComponent)}`,
);
