#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const PROFILE_FILENAME = "TONE_OF_VOICE.md";
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Parse only the tiny frontmatter surface required for state classification.
 * Profile prose deliberately never enters the observable result.
 */
function parseState(content) {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) {
    return { state: "unconfigured", schemaVersion: null, reason: "missing_frontmatter" };
  }

  const frontmatter = frontmatterMatch[1];
  const schemaMatch = frontmatter.match(/^schema_version:\s*(\d+)\s*$/m);
  const statusMatch = frontmatter.match(/^status:\s*([a-z_-]+)\s*$/m);
  const schemaVersion = schemaMatch ? Number(schemaMatch[1]) : null;

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { state: "unconfigured", schemaVersion, reason: "unsupported_schema" };
  }
  if (statusMatch?.[1] !== "configured") {
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
