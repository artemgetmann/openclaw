#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const PROFILE_FILENAME = "TONE_OF_VOICE.md";
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * The shipped schema uses flat scalar frontmatter. Reject every construct
 * outside that small grammar so malformed YAML, duplicate keys, and ambiguous
 * parser behavior always fail closed.
 */
function parseFlatFrontmatter(block) {
  const values = new Map();
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(\S(?:.*\S)?)?$/.exec(line);
    if (!match || match[2] === undefined || values.has(match[1])) {
      return null;
    }
    values.set(match[1], match[2]);
  }
  return values;
}

/**
 * Parse only the tiny frontmatter surface required for state classification.
 * Profile prose deliberately never enters the observable result.
 */
function parseState(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    return { state: "unconfigured", schemaVersion: null, reason: "missing_frontmatter" };
  }

  const frontmatter = parseFlatFrontmatter(frontmatterMatch[1]);
  if (!frontmatter) {
    return { state: "unconfigured", schemaVersion: null, reason: "malformed_frontmatter" };
  }
  const schemaRaw = frontmatter.get("schema_version");
  const schemaVersion = /^\d+$/.test(schemaRaw ?? "") ? Number(schemaRaw) : null;

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { state: "unconfigured", schemaVersion, reason: "unsupported_schema" };
  }
  if (frontmatter.get("status") !== "configured") {
    return { state: "unconfigured", schemaVersion, reason: "status_not_configured" };
  }

  // A marker flip without filling the neutral template is not configuration.
  if (content.includes("{{") || content.includes("}}")) {
    return { state: "unconfigured", schemaVersion, reason: "placeholders_remaining" };
  }

  return { state: "configured", schemaVersion, reason: "configured" };
}

function resolveWorkspaceArg(argv) {
  const index = argv.indexOf("--workspace");
  if (index === -1) {
    return process.cwd();
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--workspace requires a path");
  }
  return path.resolve(value);
}

function main() {
  let workspace;
  try {
    workspace = resolveWorkspaceArg(process.argv.slice(2));
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        event: "personal_tone_profile_status",
        state: "unconfigured",
        schemaVersion: null,
        reason: "invalid_workspace_argument",
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const profilePath = path.join(workspace, PROFILE_FILENAME);
  let result;
  try {
    if (!fs.existsSync(profilePath)) {
      result = { state: "absent", schemaVersion: null, reason: "missing" };
    } else {
      result = parseState(fs.readFileSync(profilePath, "utf8"));
    }
  } catch {
    result = { state: "unconfigured", schemaVersion: null, reason: "unreadable" };
  }

  // Keep diagnostics content-free: no raw path, profile text, or user identity.
  process.stdout.write(`${JSON.stringify({ event: "personal_tone_profile_status", ...result })}\n`);
}

main();
