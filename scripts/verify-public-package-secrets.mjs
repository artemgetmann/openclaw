#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_ENV_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_TOKEN",
  "BRAVE_API_KEY",
  "CEREBRAS_API_KEY",
  "CHUTES_API_KEY",
  "CHUTES_OAUTH_TOKEN",
  "DEEPGRAM_API_KEY",
  "FIRECRAWL_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "GROQ_API_KEY",
  "LITELLM_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "OPENAI_API_KEY",
  "OPENCLAW_CONSUMER_GEMINI_API_KEY",
  "OPENCLAW_CONSUMER_OPENAI_API_KEY",
  "VOYAGE_API_KEY",
]);

const JSON_SECRET_FIELD_NAMES = new Set([
  "accessToken",
  "apiKey",
  "appSecret",
  "botToken",
  "clientSecret",
  "encryptKey",
  "password",
  "signingSecret",
  "token",
  "verificationToken",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".env",
  ".js",
  ".json",
  ".mjs",
  ".plist",
  ".ts",
  ".yaml",
  ".yml",
]);

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

function isAllowedSecretPath(pathParts) {
  // Public Jarvis packages need a backend bearer so activation/email onboarding
  // can call the product backend. This is not a provider key; provider API keys
  // stay blocked by PROVIDER_ENV_VARS and the generic secret-field scanner.
  return pathParts.join(".") === "jarvis.backend.accessToken";
}

function usage() {
  console.error("Usage: node scripts/verify-public-package-secrets.mjs <app-bundle-or-dir>");
}

function isAllowedReferenceValue(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
    return true;
  }
  if (trimmed.startsWith("secretref-")) {
    return true;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) {
    return true;
  }
  if (/^<[^>]+>$/.test(trimmed)) {
    return true;
  }
  return false;
}

function pathLooksSecretBearing(pathParts) {
  const leaf = pathParts.at(-1);
  if (typeof leaf !== "string") {
    return false;
  }
  if (JSON_SECRET_FIELD_NAMES.has(leaf)) {
    return true;
  }
  if (PROVIDER_ENV_VARS.has(leaf) && pathParts.includes("env")) {
    return true;
  }
  return false;
}

function walkJson(value, pathParts, reportFinding) {
  if (typeof value === "string") {
    if (
      pathLooksSecretBearing(pathParts) &&
      !isAllowedSecretPath(pathParts) &&
      !isAllowedReferenceValue(value)
    ) {
      reportFinding(pathParts.join("."), "raw secret-bearing JSON value");
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkJson(entry, [...pathParts, String(index)], reportFinding));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    walkJson(entry, [...pathParts, key], reportFinding);
  }
}

function detectEnvAssignments(text, reportFinding) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=\s*(['"]?)(.*?)\2\s*$/);
    if (!match) {
      return;
    }
    const key = match[1] ?? "";
    const value = match[3] ?? "";
    if (!PROVIDER_ENV_VARS.has(key) || isAllowedReferenceValue(value)) {
      return;
    }
    reportFinding(`line ${index + 1}`, `raw provider env assignment (${key})`);
  });
}

function shouldSkipPath(filePath) {
  const parts = filePath.split(path.sep);
  return parts.includes("node_modules") || parts.includes(".git") || parts.includes("__pycache__");
}

function isMissingPathError(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function* walkFiles(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    // App rebuilds replace runtime subtrees in-place. A secret audit should
    // ignore vanished paths, while still surfacing permission and IO failures.
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (shouldSkipPath(entryPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
      continue;
    }
    if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function scanTextFile(filePath, rootDir, findings) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    // The package verifier can race with warm rebuild cleanup. Missing files
    // are not secret findings; readable files are still scanned normally.
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    return;
  }
  const extension = path.extname(filePath);
  const basename = path.basename(filePath);
  if (!TEXT_EXTENSIONS.has(extension) && !basename.startsWith(".env")) {
    return;
  }

  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  const relative = path.relative(rootDir, filePath) || path.basename(filePath);
  const reportFinding = (location, message) => {
    findings.push({ file: relative, location, message });
  };

  detectEnvAssignments(text, reportFinding);

  if (extension !== ".json") {
    return;
  }
  try {
    walkJson(JSON.parse(text), [], reportFinding);
  } catch {
    // The package verifier is a secret guard, not a JSON linter. Other package
    // checks own malformed app metadata; this scanner skips unparsable JSON.
  }
}

export async function findPublicPackageSecretFindings(rootDir) {
  const findings = [];
  for await (const filePath of walkFiles(rootDir)) {
    await scanTextFile(filePath, rootDir, findings);
  }
  return findings;
}

async function main(argv = process.argv.slice(2)) {
  const [rootDir, ...rest] = argv;
  if (!rootDir || rest.length > 0) {
    usage();
    process.exitCode = 2;
    return;
  }

  const findings = await findPublicPackageSecretFindings(path.resolve(rootDir));
  if (findings.length === 0) {
    console.log("Public package secret audit passed.");
    return;
  }

  console.error("ERROR: public package secret audit failed.");
  console.error(
    "Public consumer/Jarvis packages must not bundle founder/provider keys. Use BYOK locally or route managed access through Jarvis backend.",
  );
  for (const finding of findings.slice(0, 20)) {
    console.error(`  - ${finding.file}:${finding.location} ${finding.message}`);
  }
  if (findings.length > 20) {
    console.error(`  ... ${findings.length - 20} more finding(s).`);
  }
  process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  await main();
}
