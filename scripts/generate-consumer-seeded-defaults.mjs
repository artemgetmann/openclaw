#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONSUMER_OPENAI_ENV_KEY = "OPENCLAW_CONSUMER_OPENAI_API_KEY";
const CONSUMER_GEMINI_ENV_KEY = "OPENCLAW_CONSUMER_GEMINI_API_KEY";

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
    readSeededEnvValue(CONSUMER_OPENAI_ENV_KEY, env) ??
    readNestedString(founderConfig, [
      ["env", "vars", CONSUMER_OPENAI_ENV_KEY],
      ["env", CONSUMER_OPENAI_ENV_KEY],
    ]);
  if (openAiApiKey) {
    // Consumer bundles ship only the explicitly-designated speech utility key.
    // Do not silently reuse generic founder OpenAI keys here: a personal chat
    // key can be missing transcription access, revoked, or outside product
    // policy, which makes fresh consumer packages look voice-ready while they
    // still fail on the first inbound voice note.
    setNestedValue(seeded, ["env", "vars", CONSUMER_OPENAI_ENV_KEY], openAiApiKey);
    // Temporary early-consumer policy: the bundled OpenAI utility key also
    // enables native image generation until this moves behind subscription/proxy
    // auth. Seed only the model selector; runtime auth resolves the env key.
    setNestedValue(
      seeded,
      ["agents", "defaults", "imageGenerationModel", "primary"],
      "openai/gpt-image-2",
    );
    setNestedValue(
      seeded,
      ["tools", "media", "audio", "models"],
      [
        {
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
          apiKey: `\${${CONSUMER_OPENAI_ENV_KEY}}`,
        },
      ],
    );
  }

  const geminiApiKey =
    readSeededEnvValue(CONSUMER_GEMINI_ENV_KEY, env) ??
    readNestedString(founderConfig, [
      ["env", "vars", CONSUMER_GEMINI_ENV_KEY],
      ["env", CONSUMER_GEMINI_ENV_KEY],
      ["env", "vars", "GEMINI_API_KEY"],
      ["env", "GEMINI_API_KEY"],
      ["skills", "entries", "nano-banana-pro", "apiKey"],
    ]);
  if (geminiApiKey) {
    // Default-enabling nano-banana-pro only makes sense when consumer bundles
    // ship a dedicated Gemini credential. Seed both the consumer-owned env var
    // and the runtime-facing GEMINI_API_KEY so the packaged launchd runtime and
    // the skill status UI resolve the same secret source.
    setNestedValue(seeded, ["env", "vars", CONSUMER_GEMINI_ENV_KEY], geminiApiKey);
    setNestedValue(seeded, ["env", "vars", "GEMINI_API_KEY"], geminiApiKey);
    setNestedValue(seeded, ["skills", "entries", "nano-banana-pro", "apiKey"], geminiApiKey);
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
    // Keep Firecrawl ready for richer fetch fallback, but do not override the
    // default search provider away from Brave when both keys are present.
    setNestedValue(seeded, ["tools", "web", "fetch", "enabled"], true);
    setNestedValue(seeded, ["tools", "web", "fetch", "firecrawl", "enabled"], true);
    setNestedValue(seeded, ["tools", "web", "search", "firecrawl", "apiKey"], firecrawlApiKey);
  }

  const braveApiKey =
    readSeededEnvValue("BRAVE_API_KEY", env) ??
    readNestedString(founderConfig, [
      ["env", "vars", "BRAVE_API_KEY"],
      ["env", "BRAVE_API_KEY"],
      ["tools", "web", "search", "apiKey"],
      ["tools", "web", "search", "brave", "apiKey"],
    ]);
  if (braveApiKey) {
    // Brave remains the default search path for consumer. Firecrawl stays
    // available as an optional fetch/search provider when explicitly selected.
    setNestedValue(seeded, ["env", "vars", "BRAVE_API_KEY"], braveApiKey);
    setNestedValue(seeded, ["tools", "web", "search", "enabled"], true);
    setNestedValue(seeded, ["tools", "web", "search", "provider"], "brave");
    // Brave keys now live at the shared search-level path. Seeding the old
    // provider-nested location breaks config validation during consumer setup.
    setNestedValue(seeded, ["tools", "web", "search", "apiKey"], braveApiKey);
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
