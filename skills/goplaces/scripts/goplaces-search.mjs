#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasRuntimeCode(runtimeRoot) {
  return (
    fs.existsSync(path.join(runtimeRoot, "dist", "index.js")) ||
    fs.existsSync(path.join(runtimeRoot, "src", "index.ts"))
  );
}

function resolveEffectiveHomeDir() {
  const environmentHome =
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  if (!explicitHome) {
    return path.resolve(environmentHome);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/")) {
    return path.resolve(environmentHome, explicitHome === "~" ? "" : explicitHome.slice(2));
  }
  return path.resolve(explicitHome);
}

function resolvePathForComparison(input) {
  const effectiveHomeDir = resolveEffectiveHomeDir();
  if (input === "~") {
    return effectiveHomeDir;
  }
  if (input.startsWith("~/")) {
    return path.resolve(effectiveHomeDir, input.slice(2));
  }
  return path.resolve(input);
}

function resolveDefaultStateDir(homeDir) {
  const currentStateDir = path.join(homeDir, ".openclaw");
  if (process.env.OPENCLAW_TEST_FAST === "1" || fs.existsSync(currentStateDir)) {
    return currentStateDir;
  }
  for (const legacyName of [".clawdbot", ".moldbot", ".moltbot"]) {
    const legacyStateDir = path.join(homeDir, legacyName);
    if (fs.existsSync(legacyStateDir)) {
      return legacyStateDir;
    }
  }
  return currentStateDir;
}

function resolveRuntimeContext() {
  const checkoutRoot = path.resolve(__dirname, "../../..");
  // Empty environment entries are common when launchers forward optional
  // settings. Treat them as absent so they cannot hide a valid legacy state.
  const explicitStateValue =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  const explicitStateDir = explicitStateValue
    ? resolvePathForComparison(explicitStateValue)
    : undefined;
  const explicitStateRuntimeRoot = explicitStateDir
    ? path.join(explicitStateDir, "lib", "openclaw-bundled")
    : undefined;
  const packagedJarvisStateDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Jarvis",
    ".jarvis",
  );
  const packagedJarvisRuntimeRoot = path.join(packagedJarvisStateDir, "lib", "openclaw-bundled");
  // OPENCLAW_HOME is an explicit isolation boundary even when no state override
  // is present. Reproduce core state precedence before importing the runtime.
  const inferredStateDir = process.env.OPENCLAW_HOME?.trim()
    ? resolveDefaultStateDir(resolveEffectiveHomeDir())
    : packagedJarvisStateDir;

  // The shell wrapper pins a runtime after proving it is runnable. Preserve
  // that choice, and attach state provenance when the path is a known package.
  const pinnedRuntimeRoot = process.env.OPENCLAW_GOPLACES_RUNTIME_ROOT;
  if (pinnedRuntimeRoot && hasRuntimeCode(pinnedRuntimeRoot)) {
    if (explicitStateDir) {
      return { runtimeRoot: pinnedRuntimeRoot, stateDir: explicitStateDir };
    }
    if (path.resolve(pinnedRuntimeRoot) === path.resolve(packagedJarvisRuntimeRoot)) {
      return { runtimeRoot: pinnedRuntimeRoot, stateDir: inferredStateDir };
    }
    return { runtimeRoot: pinnedRuntimeRoot };
  }

  // A real checkout owns its local runtime and keeps normal BYOK config
  // behavior. Mirrored skill paths do not contain either entry and fall through.
  if (hasRuntimeCode(checkoutRoot)) {
    return { runtimeRoot: checkoutRoot };
  }

  if (explicitStateRuntimeRoot) {
    if (hasRuntimeCode(explicitStateRuntimeRoot)) {
      return { runtimeRoot: explicitStateRuntimeRoot, stateDir: explicitStateDir };
    }
    if (hasRuntimeCode(packagedJarvisRuntimeRoot)) {
      return { runtimeRoot: packagedJarvisRuntimeRoot, stateDir: explicitStateDir };
    }
    throw new Error(
      `could not locate a packaged OpenClaw runtime for explicit state: ${explicitStateDir}`,
    );
  }

  if (hasRuntimeCode(packagedJarvisRuntimeRoot)) {
    return { runtimeRoot: packagedJarvisRuntimeRoot, stateDir: inferredStateDir };
  }

  return { runtimeRoot: checkoutRoot };
}

function usage() {
  console.error(`Usage:
  goplaces-search.sh [search] <query> [--limit <1-10>] [--json]

Notes:
  - Jarvis managed mode routes search through the configured backend.
  - BYOK mode reads GOOGLE_PLACES_API_KEY or skills.entries.goplaces.apiKey.`);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "search") {
    args.shift();
  }
  let json = false;
  let limit;
  const queryParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      case "--json":
        json = true;
        break;
      case "--limit": {
        const next = args[index + 1];
        if (!next) {
          throw new Error("--limit requires a value");
        }
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
          throw new Error("--limit must be an integer between 1 and 10");
        }
        limit = parsed;
        index += 1;
        break;
      }
      default:
        queryParts.push(arg);
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("query is required");
  }
  return { query, limit, json };
}

async function importOpenClawRuntime() {
  const { runtimeRoot, stateDir } = resolveRuntimeContext();
  // State aliases are normalized before runtime import. Explicit config-path
  // overrides remain untouched because they are supported caller intent.
  if (stateDir) {
    process.env.OPENCLAW_STATE_DIR = stateDir;
  }
  const distEntry = path.join(runtimeRoot, "dist", "index.js");
  const sourceEntry = path.join(runtimeRoot, "src", "index.ts");
  const entry = fs.existsSync(distEntry) ? distEntry : sourceEntry;
  return await import(pathToFileURL(entry).href);
}

function placeDisplayName(place) {
  const record = place && typeof place === "object" ? place : {};
  const displayName =
    record.displayName && typeof record.displayName === "object" ? record.displayName : {};
  if (typeof displayName.text === "string" && displayName.text.trim()) {
    return displayName.text.trim();
  }
  return typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : "Unnamed place";
}

function placeAddress(place) {
  const record = place && typeof place === "object" ? place : {};
  return typeof record.formattedAddress === "string" && record.formattedAddress.trim()
    ? record.formattedAddress.trim()
    : "";
}

function printHuman(result) {
  if (result.places.length === 0) {
    console.log("No places found.");
    return;
  }
  for (const [index, place] of result.places.entries()) {
    const address = placeAddress(place);
    console.log(`${index + 1}. ${placeDisplayName(place)}${address ? ` - ${address}` : ""}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const openclaw = await importOpenClawRuntime();
  const cfg = openclaw.loadConfig();
  const result = await openclaw.runGooglePlacesSearch({
    cfg,
    query: flags.query,
    limit: flags.limit,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
