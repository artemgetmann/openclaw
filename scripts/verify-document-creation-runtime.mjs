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

const requiredCreatorExports = [
  "artifactsCreatePdfCommand",
  "artifactsCreateDocxCommand",
  "artifactsCreateXlsxCommand",
  "artifactsCreatePptxCommand",
];
const creatorComponents = new Set();
const creatorRouteFailures = [];
try {
  // The build gives lazy CLI chunks content hashes. Read the packaged CLI route
  // to locate every compiled creator it can load. Validating only the first
  // loadable chunk could let another packaged CLI route point at a missing or
  // stale creator.
  const cliChunks = fs
    .readdirSync(runtimeDist)
    .filter((name) => /^artifacts-cli-.*\.js$/u.test(name))
    .toSorted();
  if (cliChunks.length === 0) {
    creatorRouteFailures.push("no compiled artifacts CLI route found");
  }
  for (const cliChunk of cliChunks) {
    const cliSource = fs.readFileSync(path.join(runtimeDist, cliChunk), "utf8");
    const creatorImports = new Set(
      Array.from(
        cliSource.matchAll(/import\((["'])(\.\/artifacts-(?!cli-)[^"']+\.js)\1\)/gu),
        (match) => match[2],
      ),
    );
    if (creatorImports.size === 0) {
      creatorRouteFailures.push(`${cliChunk}: no document creator import found`);
      continue;
    }
    for (const creatorImport of creatorImports) {
      try {
        const resolvedCreator = fs.realpathSync(path.resolve(runtimeDist, creatorImport));
        const relative = path.relative(runtimeRealPath, resolvedCreator);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          creatorRouteFailures.push(`${cliChunk}: creator resolves outside runtime`);
          continue;
        }
        const creator = await import(pathToFileURL(resolvedCreator).href);
        const missingExports = requiredCreatorExports.filter(
          (name) => typeof creator[name] !== "function",
        );
        if (missingExports.length > 0) {
          creatorRouteFailures.push(
            `${cliChunk}: ${creatorImport} lacks ${missingExports.join(", ")}`,
          );
          continue;
        }
        creatorComponents.add(resolvedCreator);
      } catch {
        creatorRouteFailures.push(`${cliChunk}: missing or unloadable ${creatorImport}`);
      }
    }
  }
} catch {
  creatorRouteFailures.push("compiled artifacts CLI routes are missing or unreadable");
}

if (missingPackages.length > 0 || creatorRouteFailures.length > 0) {
  console.error("ERROR: bundled Jarvis document creation runtime is incomplete.");
  if (missingPackages.length > 0) {
    console.error(
      `Missing required package${missingPackages.length === 1 ? "" : "s"}: ${missingPackages.join(", ")}`,
    );
  }
  for (const failure of creatorRouteFailures) {
    console.error(`Invalid compiled creator route: ${failure}`);
  }
  console.error(`Runtime root: ${runtimeRoot}`);
  process.exit(1);
}

console.log(
  `Document creation runtime complete: ${requiredPackages.join(", ")}; ${Array.from(
    creatorComponents,
    (component) => path.relative(runtimeRoot, component),
  )
    .toSorted()
    .join(", ")}`,
);
