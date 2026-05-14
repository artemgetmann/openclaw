#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATUS_PATH = path.join(ROOT, "docs", "consumer", "project-status.md");
const REQUIRED_FIELDS = [
  "current_stage",
  "users_total",
  "paying_users",
  "active_beta_users_7d",
  "updated_at",
  "stale_after_days",
  "source_of_truth",
  "decision_implication",
];

function fail(message) {
  console.error(`project-status: ${message}`);
  process.exitCode = 1;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    fail("missing YAML-style frontmatter block");
    return new Map();
  }

  const fields = new Map();
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      fail(`invalid frontmatter line: ${rawLine}`);
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields.set(key, value);
  }

  return fields;
}

function parseUtcDate(rawValue, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    fail(`${fieldName} must use YYYY-MM-DD`);
    return null;
  }

  const date = new Date(`${rawValue}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    fail(`${fieldName} is not a valid date`);
    return null;
  }

  return date;
}

function main() {
  const text = fs.readFileSync(STATUS_PATH, "utf8");
  const fields = parseFrontmatter(text);

  for (const field of REQUIRED_FIELDS) {
    const value = fields.get(field);
    if (!value) {
      fail(`missing required field: ${field}`);
    }
  }

  const updatedAt = parseUtcDate(fields.get("updated_at") ?? "", "updated_at");
  const staleAfterDays = Number(fields.get("stale_after_days"));
  if (!Number.isInteger(staleAfterDays) || staleAfterDays <= 0) {
    fail("stale_after_days must be a positive integer");
  }

  // The status doc deliberately contains founder-reported numbers. This check
  // keeps those numbers from silently aging into fake precision.
  if (updatedAt && Number.isInteger(staleAfterDays) && staleAfterDays > 0) {
    const expiresAt = new Date(updatedAt.getTime() + staleAfterDays * 24 * 60 * 60 * 1000);
    const now = new Date(process.env.PROJECT_STATUS_NOW ?? Date.now());
    if (Number.isNaN(now.getTime())) {
      fail("PROJECT_STATUS_NOW must be a valid date when provided");
      return;
    }
    if (now >= expiresAt) {
      fail(
        `expired on ${expiresAt.toISOString().slice(0, 10)}; refresh updated_at, numbers, and source_of_truth`,
      );
    }
  }

  if (!/not decision-grade/i.test(text)) {
    fail('status doc must say stale numbers are "not decision-grade"');
  }
}

main();
