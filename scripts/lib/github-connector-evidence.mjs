import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONNECTOR_EVIDENCE_SCHEMA = 1;

// Workflow callers may control their environment, so production verification
// never resolves witness executables through PATH or caller-provided variables.
// The exported lower-level functions remain injectable only for isolated unit
// tests; command entrypoints below use these fixed system binaries.
const TRUSTED_GIT_BIN = "/usr/bin/git";
const TRUSTED_HTTP_BIN = "/usr/bin/curl";

export const CONNECTOR_CAPABILITIES = Object.freeze([
  "read-candidate",
  "compare-immutable-head",
  "open-pr",
  "update-pr",
  "read-reviews",
  "normal-merge-expected-head",
]);

export class ConnectorEvidenceError extends Error {
  constructor(code, nextAction, detail) {
    super(
      `connector capability blocker: ${code}; next=${nextAction}${detail ? `; ${detail}` : ""}`,
    );
    this.code = code;
    this.nextAction = nextAction;
  }
}

function blocker(code, nextAction, detail = "") {
  throw new ConnectorEvidenceError(code, nextAction, detail);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    blocker("malformed-connector-evidence", "refresh_connector_evidence", `missing ${field}`);
  }
  return value;
}

function requireSha(value, field) {
  const sha = requireString(value, field);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    blocker("malformed-connector-evidence", "refresh_connector_evidence", `invalid ${field}`);
  }
  return sha.toLowerCase();
}

function findForbiddenKey(value, path = "evidence") {
  if (!value || typeof value !== "object") {
    return null;
  }
  const forbidden = ["token", "authorization", "credential", "password", "secret"];
  for (const [key, nested] of Object.entries(value)) {
    const currentPath = `${path}.${key}`;
    if (forbidden.some((word) => key.toLowerCase().includes(word))) {
      return currentPath;
    }
    const found = findForbiddenKey(nested, currentPath);
    if (found) {
      return found;
    }
  }
  return null;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadConnectorEvidence(file, { repository, pr, capability } = {}) {
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    blocker("malformed-connector-evidence", "refresh_connector_evidence", "unreadable JSON");
  }
  if (
    evidence?.schemaVersion !== CONNECTOR_EVIDENCE_SCHEMA ||
    evidence?.transport !== "connector"
  ) {
    blocker(
      "malformed-connector-evidence",
      "refresh_connector_evidence",
      "wrong schema or transport",
    );
  }
  if (findForbiddenKey(evidence)) {
    blocker("secret-shaped-connector-evidence", "remove_secret_fields_and_refresh_evidence");
  }
  if (
    evidence.source?.connector !== "github" ||
    !Array.isArray(evidence.source?.tools) ||
    !evidence.source.tools.includes("github_fetch_pr") ||
    !evidence.source.tools.includes("github_fetch_pr_patch")
  ) {
    blocker(
      "malformed-connector-evidence",
      "refresh_connector_evidence",
      "missing connector source tools",
    );
  }
  const observedAt = Date.parse(evidence.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > Date.now() + 30_000 ||
    Date.now() - observedAt > 300_000
  ) {
    blocker(
      "stale-connector-evidence",
      "refresh_connector_evidence",
      "observation must be within five minutes",
    );
  }
  if (repository && evidence.repository !== repository) {
    blocker("conflicting-candidate-identity", "refresh_connector_evidence", "repository mismatch");
  }
  if (
    !Array.isArray(evidence.capabilities) ||
    evidence.capabilities.some((item) => !CONNECTOR_CAPABILITIES.includes(item))
  ) {
    blocker("malformed-connector-evidence", "refresh_connector_evidence", "invalid capabilities");
  }
  if (capability && !evidence.capabilities.includes(capability)) {
    blocker(`connector-missing-${capability}`, "use_host_gh_or_install_connector_capability");
  }

  const candidate = evidence.candidate;
  if (!candidate || !Number.isInteger(candidate.number) || typeof candidate.state !== "string") {
    blocker(
      "malformed-connector-evidence",
      "refresh_connector_evidence",
      "missing PR number or state",
    );
  }
  if (candidate.number !== pr || candidate.state !== "OPEN") {
    blocker(
      "conflicting-candidate-identity",
      "refresh_connector_evidence",
      "PR number or state mismatch",
    );
  }
  candidate.url = requireString(candidate.url, "candidate.url");
  candidate.title = requireString(candidate.title, "candidate.title");
  candidate.headRefName = requireString(candidate.headRefName, "candidate.headRefName");
  candidate.headSha = requireSha(candidate.headSha, "candidate.headSha");
  candidate.baseRefName = requireString(candidate.baseRefName, "candidate.baseRefName");
  candidate.baseSha = requireSha(candidate.baseSha, "candidate.baseSha");
  candidate.patch = requireString(candidate.patch, "candidate.patch");
  candidate.body = typeof candidate.body === "string" ? candidate.body : "";
  if (
    !Array.isArray(candidate.changedPaths) ||
    candidate.changedPaths.length === 0 ||
    candidate.changedPaths.some((item) => typeof item !== "string" || item === "")
  ) {
    blocker("malformed-connector-evidence", "refresh_connector_evidence", "invalid changedPaths");
  }
  const sorted = [...new Set(candidate.changedPaths)].toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(sorted) !== JSON.stringify(candidate.changedPaths)) {
    blocker(
      "malformed-connector-evidence",
      "refresh_connector_evidence",
      "changedPaths must be unique and sorted",
    );
  }
  if (candidate.patchSha256 !== `sha256:${sha256(candidate.patch)}`) {
    blocker("malformed-connector-evidence", "refresh_connector_evidence", "patch digest mismatch");
  }
  return evidence;
}

function runGit(gitBin, args, { cwd } = {}) {
  try {
    return execFileSync(gitBin, args, {
      cwd,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    blocker("connector-candidate-git-proof-unavailable", "restore_read_only_git_remote_access");
  }
}

function runPublicGitHubRead(httpBin, url) {
  try {
    return execFileSync(
      httpBin,
      ["--disable", "--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", url],
      {
        encoding: "utf8",
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch {
    blocker(
      "connector-live-metadata-proof-unavailable",
      "use_host_gh_or_enable_public_github_metadata_read",
    );
  }
}

export function verifyConnectorEvidenceWithPublicApi(evidence, { httpBin = "curl" } = {}) {
  // MCP connector responses are trusted by the agent host but do not carry a
  // signature that a repository script can verify. For public repositories,
  // GitHub's TLS-authenticated REST response is an independent secret-free
  // witness for every mutable PR field used by lifecycle policy.
  const url = `https://api.github.com/repos/${evidence.repository}/pulls/${evidence.candidate.number}`;
  let live;
  try {
    live = JSON.parse(runPublicGitHubRead(httpBin, url));
  } catch (error) {
    if (error instanceof ConnectorEvidenceError) {
      throw error;
    }
    blocker("connector-live-metadata-malformed", "retry_public_github_metadata_read_once");
  }
  const expected = evidence.candidate;
  const liveState = typeof live?.state === "string" ? live.state.toUpperCase() : "";
  const liveBody = typeof live?.body === "string" ? live.body : "";
  if (
    live?.number !== expected.number ||
    live?.base?.repo?.full_name !== evidence.repository ||
    live?.html_url !== expected.url ||
    live?.title !== expected.title ||
    liveState !== expected.state ||
    live?.draft !== expected.isDraft ||
    liveBody !== expected.body ||
    live?.head?.ref !== expected.headRefName ||
    live?.head?.sha?.toLowerCase() !== expected.headSha ||
    live?.base?.ref !== expected.baseRefName ||
    live?.base?.sha?.toLowerCase() !== expected.baseSha
  ) {
    blocker("connector-live-metadata-conflict", "refresh_connector_evidence_and_repeat_gates");
  }
  // Compare the connector patch with GitHub's own unified-diff representation.
  // A local `git diff` is not byte-compatible with every GitHub patch surface,
  // even when both describe the same commits.
  const livePatch = runPublicGitHubRead(
    httpBin,
    `https://github.com/${evidence.repository}/pull/${expected.number}.diff`,
  );
  if (livePatch !== expected.patch || expected.patchSha256 !== `sha256:${sha256(livePatch)}`) {
    blocker("connector-candidate-patch-conflict", "refresh_connector_evidence_from_exact_refs");
  }
  return evidence;
}

export function verifyConnectorEvidenceWithGit(evidence, { gitBin = "git" } = {}) {
  // Connector results have no repository-verifiable signature. Bind their
  // candidate identity to GitHub's independently authenticated Git refs, then
  // derive both review surfaces from those exact commits. The evidence file is
  // metadata transport only; it cannot choose the head, base, patch, or paths.
  // Address GitHub directly. A local remote alias or Git URL rewrite could
  // otherwise redirect the supposedly independent ref witness.
  const remoteUrl = `https://github.com/${evidence.repository}.git`;
  const pullRef = `refs/pull/${evidence.candidate.number}/head`;
  const baseRef = `refs/heads/${evidence.candidate.baseRefName}`;
  const refs = runGit(gitBin, ["ls-remote", remoteUrl, pullRef, baseRef], { cwd: os.tmpdir() })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const byRef = new Map(refs.map(([commit, ref]) => [ref, commit?.toLowerCase()]));
  if (
    byRef.get(pullRef) !== evidence.candidate.headSha ||
    byRef.get(baseRef) !== evidence.candidate.baseSha
  ) {
    blocker("connector-candidate-ref-drift", "refresh_connector_evidence_and_repeat_gates");
  }
  // Never depend on, or trust, objects and replacement refs in the caller's
  // checkout. Fetch the two authenticated refs into disposable storage, then
  // derive the changed paths from those exact objects.
  const witnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-github-witness-"));
  const witnessGit = path.join(witnessRoot, "repo.git");
  let changedPaths;
  try {
    runGit(gitBin, ["init", "--bare", witnessGit], { cwd: witnessRoot });
    runGit(gitBin, [
      "--git-dir",
      witnessGit,
      "fetch",
      "--no-tags",
      remoteUrl,
      `+${pullRef}:refs/connector/head`,
      `+${baseRef}:refs/connector/base`,
    ]);
    const range = `${evidence.candidate.baseSha}...${evidence.candidate.headSha}`;
    changedPaths = runGit(gitBin, [
      "--git-dir",
      witnessGit,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
      range,
    ])
      .split("\0")
      .filter(Boolean)
      .toSorted((left, right) => left.localeCompare(right));
  } finally {
    fs.rmSync(witnessRoot, { recursive: true, force: true });
  }
  if (JSON.stringify(changedPaths) !== JSON.stringify(evidence.candidate.changedPaths)) {
    blocker("connector-candidate-path-conflict", "refresh_connector_evidence_from_exact_refs");
  }
  return evidence;
}

export function verifyConnectorEvidenceForWorkflow(evidence) {
  if (!fs.existsSync(TRUSTED_HTTP_BIN) || !fs.existsSync(TRUSTED_GIT_BIN)) {
    blocker(
      "connector-trusted-witness-binary-unavailable",
      "use_host_gh_or_install_system_git_and_curl",
    );
  }
  verifyConnectorEvidenceWithPublicApi(evidence, { httpBin: TRUSTED_HTTP_BIN });
  verifyConnectorEvidenceWithGit(evidence, { gitBin: TRUSTED_GIT_BIN });
  return evidence;
}

export function connectorMergeRequest(evidence, expectedHead) {
  if (!evidence.capabilities.includes("normal-merge-expected-head")) {
    blocker("connector-missing-normal-merge-expected-head", "use_host_gh_or_stop_release");
  }
  const normalizedExpectedHead = requireSha(expectedHead, "expectedHead");
  if (evidence.candidate.headSha !== normalizedExpectedHead) {
    blocker("expected-head-mismatch", "refresh_candidate_and_repeat_review_test_release");
  }
  return {
    tool: "github_merge_pull_request",
    arguments: {
      repository_full_name: evidence.repository,
      pr_number: evidence.candidate.number,
      expected_head_sha: normalizedExpectedHead,
      merge_method: "squash",
    },
    reconciliation: {
      readCapability: "read-candidate",
      acceptedOnlyWhen: `merged=true and merge result binds expected head ${normalizedExpectedHead}`,
      retryOnAmbiguity: false,
    },
  };
}

export function reconcileConnectorMerge({ expectedHead, mutationResult, candidateAfter }) {
  const head = requireSha(expectedHead, "expectedHead");
  if (candidateAfter?.headSha !== head) {
    blocker("expected-head-mismatch", "refresh_candidate_and_repeat_review_test_release");
  }
  if (candidateAfter?.merged === true && typeof candidateAfter.mergeCommitSha === "string") {
    return {
      status: "accepted",
      transport: "connector",
      headSha: head,
      mergeCommitSha: requireSha(candidateAfter.mergeCommitSha, "mergeCommitSha"),
    };
  }
  if (mutationResult?.merged === false) {
    blocker("normal-merge-rejected", "inspect_checks_reviews_and_branch_policy");
  }
  blocker("connector-merge-ambiguous", "read_pr_once_then_stop_without_retry");
}
