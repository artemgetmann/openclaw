#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { buildSnapshot, isActivePullRequest, monitorResult } from "./lib/pr-freshness-monitor.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requiredChecks(repository, number) {
  // `gh pr checks` exits non-zero for a legitimate failing/pending check set.
  // JSON stdout is authoritative; absence of parseable JSON is a transport failure.
  const result = spawnSync(
    "gh",
    [
      "pr",
      "checks",
      String(number),
      "--repo",
      repository,
      "--required",
      "--json",
      "name,bucket,state,workflow",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!result.stdout?.trim()) {
    throw new Error(result.stderr?.trim() || `unable to read required checks for PR #${number}`);
  }
  return JSON.parse(result.stdout);
}

function fetchPullRequests(repository, trackedNumbers) {
  // Open PRs are queried separately so recently closed history cannot crowd
  // them out of GitHub's result limit. Only tracked missing PRs get a bounded
  // follow-up read, solely to detect their successful merge transition.
  const fields =
    "number,title,url,state,isDraft,updatedAt,labels,autoMergeRequest,mergeStateStatus,headRefOid,baseRefOid";
  const raw = runGh([
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    fields,
  ]);
  const open = JSON.parse(raw)
    .filter((pr) => isActivePullRequest(pr))
    .toSorted((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
    .slice(0, 20)
    .map((pr) => ({
      ...pr,
      requiredChecks:
        pr.state === "OPEN" && pr.isDraft !== true ? requiredChecks(repository, pr.number) : [],
    }));
  const openNumbers = new Set(open.map((pr) => Number(pr.number)));
  const merged = trackedNumbers
    .filter((number) => !openNumbers.has(Number(number)))
    .slice(0, 20)
    .map((number) => {
      const value = runGh(["pr", "view", String(number), "--repo", repository, "--json", fields]);
      return { ...JSON.parse(value), requiredChecks: [] };
    })
    .filter((pr) => pr.state === "MERGED");
  return [...open, ...merged];
}

function atomicWrite(file, value) {
  // Rename-on-success preserves the last good baseline across transport,
  // parsing, or process failures. The file is private to the local operator.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const repository = option("--repo") ?? "artemgetmann/openclaw";
const fixture = option("--fixture");
const stateFile =
  option("--state-file") ??
  path.join(
    process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"),
    "cron",
    "pr-freshness-state.json",
  );

try {
  const previous = fs.existsSync(stateFile) ? readJson(stateFile) : null;
  const trackedNumbers = (previous?.pullRequests ?? []).map((pr) => pr.number);
  const raw = fixture ? readJson(fixture) : fetchPullRequests(repository, trackedNumbers);
  const current = buildSnapshot(raw, { trackedNumbers });
  const result = monitorResult(previous, current);
  atomicWrite(stateFile, current);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, changed: false, error: "github-check-failed", detail: String(error?.message ?? error).slice(0, 240) })}\n`,
  );
  process.exitCode = 1;
}
