#!/usr/bin/env node

import process from "node:process";
import {
  connectorMergeRequest,
  loadConnectorEvidence,
  verifyConnectorEvidenceForWorkflow,
} from "./lib/github-connector-evidence.mjs";

function fail(message, code = 1) {
  process.stderr.write(`[github-connector-transport] ${message}\n`);
  process.exit(code);
}

const [command, file, ...rest] = process.argv.slice(2);
if (command === "schema") {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        transport: "connector",
        observedAt: "<ISO-8601 timestamp from this connector read>",
        source: { connector: "github", tools: ["github_fetch_pr", "github_fetch_pr_patch"] },
        repository: "<owner/repo>",
        capabilities: ["read-candidate"],
        candidate: {
          number: "<PR number>",
          url: "<PR URL>",
          title: "<PR title>",
          state: "OPEN",
          isDraft: true,
          headRefName: "<head branch>",
          headSha: "<40-hex head SHA>",
          baseRefName: "<base branch>",
          baseSha: "<40-hex base SHA>",
          changedPaths: ["<unique sorted path>"],
          patch: "<exact github_fetch_pr_patch bytes>",
          patchSha256: "sha256:<digest of exact patch bytes>",
          body: "<PR body>",
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}
const repository = process.env.OPENCLAW_GITHUB_REPOSITORY;
const pr = Number(process.env.OPENCLAW_GITHUB_PR);
if (!command || !file || !repository || !Number.isInteger(pr)) {
  fail(
    "usage: scripts/github-connector-transport.mjs schema | OPENCLAW_GITHUB_REPOSITORY=owner/repo OPENCLAW_GITHUB_PR=N scripts/github-connector-transport.mjs <verify|merge-request> <evidence.json> [expected-head]",
    2,
  );
}

try {
  const capability = command === "merge-request" ? "read-candidate" : undefined;
  const evidence = loadConnectorEvidence(file, { repository, pr, capability });
  verifyConnectorEvidenceForWorkflow(evidence);
  const output =
    command === "verify"
      ? {
          status: "ready",
          transport: "connector",
          repository,
          pr,
          headSha: evidence.candidate.headSha,
          capabilities: evidence.capabilities,
        }
      : command === "merge-request"
        ? connectorMergeRequest(evidence, rest[0])
        : null;
  if (!output) {
    fail(`unknown command: ${command}`, 2);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  fail(
    error instanceof Error ? error.message : String(error),
    error?.code === "expected-head-mismatch" ? 3 : 75,
  );
}
