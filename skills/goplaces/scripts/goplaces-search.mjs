#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

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
  const distEntry = path.join(repoRoot, "dist", "index.js");
  const sourceEntry = path.join(repoRoot, "src", "index.ts");
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
