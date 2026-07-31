import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

const fastPath = readRepoFile("scripts/pr-merge-fastpath.sh");
const canonicalPr = readRepoFile("scripts/pr");

describe("GitHub PR transport contract", () => {
  it("stops for builder refresh instead of mutating a stale branch", () => {
    expect(fastPath).toContain('"${merge_state}" == "BEHIND" || "${merge_state}" == "DIRTY"');
    expect(fastPath).toContain("result=blocked-builder-refresh-required");
    expect(fastPath).not.toContain('gh pr update-branch "${PR_NUMBER}"');
  });

  it("binds merge mutations to the immutable head and preserves read failures", () => {
    // Both dry-run receipts and executable paths show the expected-head flag;
    // the sourceable wrapper independently checks the head before mutation.
    expect(fastPath).toContain("openclaw_github_pr_mutation_once");
    expect(fastPath.match(/--match-head-commit/g)).toHaveLength(4);
    expect(canonicalPr).toContain("openclaw_github_pr_mutation_once");
    expect(canonicalPr).toContain('--match-head-commit "$PREP_HEAD_SHA"');
    expect(fastPath).toContain("result=indeterminate-required-check-read-failed");
    expect(fastPath).not.toContain("|| printf '[]'");
  });

  it("does not retry ambiguous merge or completion-comment mutations", () => {
    expect(canonicalPr).toContain("inspect PR state read-only and do not retry");
    expect(canonicalPr).toContain("inspect comments read-only and do not retry");
    expect(canonicalPr).not.toContain("Retrying merge once with fallback author email");
    expect(canonicalPr).not.toContain("for attempt in 1 2 3");
  });
});
