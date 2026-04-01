#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readSeededEnvValue(envKey, env = process.env) {
  const rawValue = env[envKey];
  if (typeof rawValue !== "string") {
    return undefined;
  }
  const value = rawValue.trim();
  return value ? value : undefined;
}

function readNestedString(root, keyPaths) {
  for (const keyPath of keyPaths) {
    let value = root;
    for (const key of keyPath) {
      if (!value || typeof value !== "object" || !(key in value)) {
        value = undefined;
        break;
      }
      value = value[key];
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

async function readJsonIfPresent(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setNestedValue(target, pathParts, value) {
  let cursor = target;
  for (const part of pathParts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

export function buildConsumerSeededDefaults({ env = process.env, founderConfig = {} } = {}) {
  const seeded = {};

  // Keep bundled defaults intentionally small. Packaging should only embed the
  // keys and config surfaces the consumer bootstrap already tests and relies on.
  const openAiApiKey =
    readSeededEnvValue("OPENAI_API_KEY", env) ??
    readNestedString(founderConfig, [
      ["env", "vars", "OPENAI_API_KEY"],
      ["env", "OPENAI_API_KEY"],
      ["models", "providers", "openai", "apiKey"],
    ]);
  if (openAiApiKey) {
    // Consumer launchd runtimes do not automatically inherit a regular OpenAI
    // API key, so seed it explicitly when available. Media/STT resolves the
    // plain `openai` provider first, and memory-lancedb expects an embeddings
    // key even when the slot is enabled later by product/runtime config.
    setNestedValue(seeded, ["env", "vars", "OPENAI_API_KEY"], openAiApiKey);
    setNestedValue(
      seeded,
      ["plugins", "entries", "memory-lancedb", "config", "embedding", "apiKey"],
      "${OPENAI_API_KEY}",
    );
    setNestedValue(
      seeded,
      ["plugins", "entries", "memory-lancedb", "config", "embedding", "model"],
      "text-embedding-3-small",
    );
  }

  const googlePlacesApiKey =
    readSeededEnvValue("GOOGLE_PLACES_API_KEY", env) ??
    readNestedString(founderConfig, [
      ["env", "vars", "GOOGLE_PLACES_API_KEY"],
      ["skills", "entries", "goplaces", "apiKey"],
    ]);
  if (googlePlacesApiKey) {
    setNestedValue(seeded, ["env", "vars", "GOOGLE_PLACES_API_KEY"], googlePlacesApiKey);
    // Mirror the primary env into the skill config so host-side skill launches
    // and UI status stay aligned even before a user edits the config manually.
    setNestedValue(seeded, ["skills", "entries", "goplaces", "apiKey"], googlePlacesApiKey);
  }

  const firecrawlApiKey =
    readSeededEnvValue("FIRECRAWL_API_KEY", env) ??
    readNestedString(founderConfig, [
      ["env", "vars", "FIRECRAWL_API_KEY"],
      ["env", "FIRECRAWL_API_KEY"],
      ["tools", "web", "fetch", "firecrawl", "apiKey"],
      ["tools", "web", "search", "firecrawl", "apiKey"],
    ]);
  if (firecrawlApiKey) {
    setNestedValue(seeded, ["env", "vars", "FIRECRAWL_API_KEY"], firecrawlApiKey);
    // `web_fetch` works without Firecrawl, but when a key is available we want
    // the consumer bundle to advertise the richer fallback path immediately.
    // Consumer setup is simpler when the same provider handles both search and
    // fetch, so prefer Firecrawl for search whenever we seed its key.
    setNestedValue(seeded, ["tools", "web", "fetch", "enabled"], true);
    setNestedValue(seeded, ["tools", "web", "fetch", "firecrawl", "enabled"], true);
    setNestedValue(seeded, ["tools", "web", "search", "enabled"], true);
    setNestedValue(seeded, ["tools", "web", "search", "provider"], "firecrawl");
    setNestedValue(seeded, ["tools", "web", "search", "firecrawl", "apiKey"], firecrawlApiKey);
  }

  const braveApiKey =
    readSeededEnvValue("BRAVE_API_KEY", env) ??
    readNestedString(founderConfig, [
      ["env", "vars", "BRAVE_API_KEY"],
      ["env", "BRAVE_API_KEY"],
      ["tools", "web", "search", "apiKey"],
    ]);
  if (braveApiKey) {
    // Keep the Brave key available for manual/provider-level overrides, but do
    // not let it steal the default search path away from Firecrawl when both
    // keys are seeded into the consumer bundle.
    setNestedValue(seeded, ["env", "vars", "BRAVE_API_KEY"], braveApiKey);
    if (!firecrawlApiKey) {
      setNestedValue(seeded, ["tools", "web", "search", "enabled"], true);
      setNestedValue(seeded, ["tools", "web", "search", "provider"], "brave");
    }
    setNestedValue(seeded, ["tools", "web", "search", "brave", "apiKey"], braveApiKey);
  }

  return seeded;
}

export async function writeConsumerSeededDefaults(outputPath, env = process.env) {
  const founderConfigPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const founderConfig = (await readJsonIfPresent(founderConfigPath)) ?? {};
  const resolvedOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(
    resolvedOutputPath,
    `${JSON.stringify(buildConsumerSeededDefaults({ env, founderConfig }), null, 2)}\n`,
    "utf8",
  );
}

async function main(argv = process.argv.slice(2)) {
  const [outputPath, ...rest] = argv;
  if (!outputPath || rest.length > 0) {
    console.error("Usage: node scripts/generate-consumer-seeded-defaults.mjs <output-path>");
    process.exitCode = 1;
    return;
  }
  await writeConsumerSeededDefaults(outputPath);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  await main();
}
