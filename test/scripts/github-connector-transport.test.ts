import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectorMergeRequest,
  loadConnectorEvidence,
  reconcileConnectorMerge,
  verifyConnectorEvidenceWithGit,
  verifyConnectorEvidenceWithPublicApi,
} from "../../scripts/lib/github-connector-evidence.mjs";

const roots: string[] = [];
const sha = (char: string) => char.repeat(40);

function fixture(overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-github-connector-"));
  roots.push(root);
  const patch = "diff --git a/a b/a\n";
  const evidence = {
    schemaVersion: 1,
    transport: "connector",
    observedAt: new Date().toISOString(),
    source: { connector: "github", tools: ["github_fetch_pr", "github_fetch_pr_patch"] },
    repository: "artemgetmann/openclaw",
    capabilities: ["read-candidate", "compare-immutable-head", "normal-merge-expected-head"],
    candidate: {
      number: 42,
      url: "https://github.com/artemgetmann/openclaw/pull/42",
      title: "fix(workflow): connector fixture",
      state: "OPEN",
      isDraft: true,
      headRefName: "fix/example",
      headSha: sha("a"),
      baseRefName: "main",
      baseSha: sha("b"),
      changedPaths: ["a"],
      patch,
      patchSha256: `sha256:${createHash("sha256").update(patch).digest("hex")}`,
      body: "Observable claim + acceptance criteria: connector fallback is exact-head safe",
    },
    ...overrides,
  };
  const file = path.join(root, "evidence.json");
  const git = path.join(root, "git");
  const http = path.join(root, "curl");
  const gh = path.join(root, "gh");
  fs.writeFileSync(file, JSON.stringify(evidence));
  fs.writeFileSync(
    git,
    `#!/bin/sh
case "$*" in
  "ls-remote https://github.com/artemgetmann/openclaw.git refs/pull/42/head refs/heads/main")
    printf '%s\\t%s\\n' '${sha("a")}' 'refs/pull/42/head'
    printf '%s\\t%s\\n' '${sha("b")}' 'refs/heads/main' ;;
  "init --bare "*) exit 0 ;;
  *" fetch --no-tags https://github.com/artemgetmann/openclaw.git "*) exit 0 ;;
  *"--name-only -z"*) printf 'a\\0' ;;
  *) exit 2 ;;
esac
`,
  );
  fs.chmodSync(git, 0o755);
  fs.writeFileSync(
    http,
    `#!/bin/sh
case "$*" in
  *"/pull/42.diff") printf 'diff --git a/a b/a\\n' ;;
  *) printf '%s' '${JSON.stringify({
    number: 42,
    html_url: "https://github.com/artemgetmann/openclaw/pull/42",
    title: "fix(workflow): connector fixture",
    state: "open",
    draft: true,
    body: "Observable claim + acceptance criteria: connector fallback is exact-head safe",
    head: { ref: "fix/example", sha: sha("a") },
    base: { ref: "main", sha: sha("b"), repo: { full_name: "artemgetmann/openclaw" } },
  })}' ;;
esac
`,
  );
  fs.chmodSync(http, 0o755);
  fs.writeFileSync(
    gh,
    `#!/bin/sh
case "$*" in
  "api user --jq .login") printf '%s\\n' 'fixture-user' ;;
  "api repos/{owner}/{repo}/git/ref/heads/main")
    printf '%s' '${JSON.stringify({ object: { type: "commit", sha: sha("b") } })}' ;;
  "pr view 42 --json number,url,state,isDraft,title,headRefName,headRefOid,baseRefName,baseRefOid,files,body")
    printf '%s' '${JSON.stringify({
      number: 42,
      url: "https://github.com/artemgetmann/openclaw/pull/42",
      state: "OPEN",
      isDraft: true,
      title: "fix(workflow): connector fixture",
      headRefName: "fix/example",
      headRefOid: sha("a"),
      baseRefName: "main",
      baseRefOid: sha("b"),
      files: [{ path: "a" }],
      body: "Observable claim + acceptance criteria: connector fallback is exact-head safe",
    })}' ;;
  "pr diff 42 --patch") printf 'diff --git a/a b/a\\n' ;;
  *) exit 2 ;;
esac
`,
  );
  fs.chmodSync(gh, 0o755);
  return { file, evidence, git, http, gh };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("GitHub connector transport evidence", () => {
  it("does not expose caller-substitutable witness executables", () => {
    const transport = fs.readFileSync("scripts/github-connector-transport.mjs", "utf8");
    expect(transport).not.toContain("OPENCLAW_GITHUB_HTTP_BIN");
    expect(transport).not.toContain("OPENCLAW_GITHUB_GIT_BIN");
    expect(transport).toContain("verifyConnectorEvidenceForWorkflow");
    const verifier = fs.readFileSync("scripts/lib/github-connector-evidence.mjs", "utf8");
    expect(verifier).toContain('GIT_NO_REPLACE_OBJECTS: "1"');
  });

  it("keeps connector proof on the canonical one-owner command path", () => {
    const transport = fs.readFileSync("scripts/github-connector-transport.mjs", "utf8");
    const preflight = fs.readFileSync("scripts/lib/github-auth-preflight.sh", "utf8");
    const workflow = fs.readFileSync("docs/agent-guides/workflow.md", "utf8");
    expect(preflight).toContain('scripts/github-connector-transport.mjs" verify');
    expect(workflow).toContain("scripts/github-connector-transport.mjs verify");
    expect(workflow).toContain("scripts/github-connector-transport.mjs merge-request");
    expect(transport).toContain("connectorMergeRequest");
    expect(fs.existsSync("scripts/pr-lifecycle")).toBe(false);
    expect(fs.existsSync("scripts/pr-lifecycle.mjs")).toBe(false);
  });

  it("reports an exact evidence blocker when both transports are unavailable", () => {
    const result = spawnSync(
      "bash",
      ["scripts/github-auth-preflight.sh", "--context", "host", "--transport", "connector"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GITHUB_CONNECTOR_EVIDENCE: "",
          OPENCLAW_GITHUB_REPOSITORY: "artemgetmann/openclaw",
          OPENCLAW_GITHUB_PR: "42",
        },
      },
    );
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("reason=evidence-context-missing");
    expect(result.stderr).toContain("next=collect_connector_candidate_evidence");
  });

  it("accepts a capable connector candidate and emits an expected-head normal merge", () => {
    const { file } = fixture();
    const evidence = loadConnectorEvidence(file, {
      repository: "artemgetmann/openclaw",
      pr: 42,
      capability: "read-candidate",
    });
    const request = connectorMergeRequest(evidence, sha("a"));
    expect(request.arguments.expected_head_sha).toBe(sha("a"));
    expect(request.reconciliation.retryOnAmbiguity).toBe(false);
  });

  it("reports a capability-specific blocker for a read-only connector", () => {
    const { file } = fixture({ capabilities: ["read-candidate"] });
    const evidence = loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 });
    expect(() => connectorMergeRequest(evidence, sha("a"))).toThrow(
      "connector-missing-normal-merge-expected-head",
    );
  });

  it.each([
    ["conflicting candidate", { repository: "other/repo" }, "conflicting-candidate-identity"],
    ["partial evidence", { candidate: { number: 42 } }, "malformed-connector-evidence"],
    ["stale evidence", { observedAt: "2020-01-01T00:00:00Z" }, "stale-connector-evidence"],
  ])("fails closed for %s", (_name, overrides, code) => {
    const { file } = fixture(overrides);
    expect(() =>
      loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 }),
    ).toThrow(code);
  });

  it("rejects head drift before mutation", () => {
    const { file } = fixture();
    const evidence = loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 });
    expect(() => connectorMergeRequest(evidence, sha("c"))).toThrow("expected-head-mismatch");
  });

  it("binds self-asserted metadata to independent Git refs", () => {
    const { file, git } = fixture();
    const evidence = loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 });
    expect(verifyConnectorEvidenceWithGit(evidence, { gitBin: git })).toBe(evidence);
    evidence.candidate.headSha = sha("c");
    expect(() => verifyConnectorEvidenceWithGit(evidence, { gitBin: git })).toThrow(
      "connector-candidate-ref-drift",
    );
  });

  it("binds live PR state and contract fields to GitHub public metadata", () => {
    const { file, http } = fixture();
    const evidence = loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 });
    expect(verifyConnectorEvidenceWithPublicApi(evidence, { httpBin: http })).toBe(evidence);
    evidence.candidate.body = "invented acceptance contract";
    expect(() => verifyConnectorEvidenceWithPublicApi(evidence, { httpBin: http })).toThrow(
      "connector-live-metadata-conflict",
    );
    const titleEvidence = loadConnectorEvidence(file, {
      repository: "artemgetmann/openclaw",
      pr: 42,
    });
    titleEvidence.candidate.title = "Jarvis contract bypass";
    expect(() => verifyConnectorEvidenceWithPublicApi(titleEvidence, { httpBin: http })).toThrow(
      "connector-live-metadata-conflict",
    );
  });

  it("derives changed paths from the authenticated commit range", () => {
    const { file, git } = fixture();
    const evidence = loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 });
    evidence.candidate.changedPaths = ["hidden-security-file"];
    expect(() => verifyConnectorEvidenceWithGit(evidence, { gitBin: git })).toThrow(
      "connector-candidate-path-conflict",
    );
  });

  it("reconciles a completed ambiguous merge without authorizing a retry", () => {
    expect(
      reconcileConnectorMerge({
        expectedHead: sha("a"),
        mutationResult: null,
        candidateAfter: { headSha: sha("a"), merged: true, mergeCommitSha: sha("d") },
      }),
    ).toMatchObject({ status: "accepted", mergeCommitSha: sha("d") });
    expect(() =>
      reconcileConnectorMerge({
        expectedHead: sha("a"),
        mutationResult: null,
        candidateAfter: { headSha: sha("a"), merged: false },
      }),
    ).toThrow("read_pr_once_then_stop_without_retry");
  });

  it("rejects credential-shaped evidence without logging its value", () => {
    const { file } = fixture({
      source: {
        connector: "github",
        tools: ["github_fetch_pr", "github_fetch_pr_patch"],
        nested: { authorizationToken: "secret-value" },
      },
    });
    let message = "";
    try {
      loadConnectorEvidence(file, { repository: "artemgetmann/openclaw", pr: 42 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("secret-shaped-connector-evidence");
    expect(message).not.toContain("secret-value");
  });
});
