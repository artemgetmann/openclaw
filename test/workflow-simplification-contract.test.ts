import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("single-owner workflow contract", () => {
  it("keeps one primary owner and independent review without chat choreography", () => {
    const agents = read("AGENTS.md");
    const workflow = read("docs/agent-guides/workflow.md");
    const contributing = read("FORK_CONTRIBUTING.md");

    expect(agents).toContain("One primary chat owns the issue");
    expect(workflow).toContain("scripts/codex-review.mjs --base origin/main");
    expect(workflow).toContain("does not create a tester chat, release chat");
    expect(workflow).toContain("normal non-admin merge");
    expect(contributing).toContain("Codex review");

    for (const text of [agents, workflow, contributing]) {
      expect(text).not.toContain("scripts/pr-lifecycle");
      expect(text).not.toContain("handoff-test");
      expect(text).not.toContain("handoff-release");
    }
  });

  it("keeps Codex Review focused on the smallest complete change", () => {
    const agents = read("AGENTS.md");
    const contributing = read("FORK_CONTRIBUTING.md");

    expect(agents).toContain("Does the PR solve one clear, observable problem?");
    expect(agents).toContain("Is every production change necessary for that problem?");
    expect(agents).toContain("description-based triggering failed");
    expect(agents).toContain("system prompt does not duplicate guidance");
    expect(contributing).toContain("Does the PR solve one clear, observable problem?");
    expect(contributing).toContain("Is every production change necessary for that problem?");
    expect(contributing).toContain("description-based triggering failed");
    expect(contributing).toContain("system prompt does not duplicate guidance");
  });

  it("allows isolated development work to run concurrently", () => {
    const agents = read("AGENTS.md");
    const fleet = read("docs/agent-guides/fleet-resource-control.md");
    const adoption = read("scripts/adopt-codex-worktree.sh");

    expect(agents).toContain("Ordinary isolated tests, typechecks, builds");
    expect(fleet).toContain("Ordinary work has no machine lock");
    expect(fleet).toContain("Lock only the resource being changed");
    expect(fleet).toContain("ChatGPT or provider authentication");
    expect(adoption).not.toContain("with-heavy-local-slot.sh");
    expect(adoption).not.toContain("capacity-wait-seconds");
  });

  it("keeps routine base drift and exclusive-slot waiting autonomous", () => {
    const workflow = read("docs/agent-guides/workflow.md");
    const fleet = read("docs/agent-guides/fleet-resource-control.md");
    const template = read(".github/pull_request_template.md");
    const prScript = read("scripts/pr");

    expect(workflow).toContain("Do not ask the user to schedule routine merge order");
    expect(workflow).toContain("retain the existing");
    expect(workflow).toContain("local review and focused proof");
    expect(fleet).toContain("Different resources run concurrently");
    expect(fleet).toContain("Native Codex thread delivery, wakeups, and chat cleanup");
    expect(template).toContain("unchanged/disjoint + retained local proof");
    expect(template).not.toContain("effective-patch reconciliation + repeated proof");
    expect(prScript).toContain('git merge-base "$prep_head_sha" origin/main');
    expect(prScript).toContain('git diff --name-only "${prepared_base_sha}..origin/main"');
    expect(prScript).not.toContain('git diff --name-only "${prep_head_sha}..origin/main"');
    expect(prScript).toContain("Cross-file source dependencies cannot be inferred safely");
    expect(prScript).toContain("CHANGELOG.md|docs/channels/*");
  });

  it("removes the obsolete lifecycle and universal-wait entrypoints", () => {
    for (const relativePath of [
      "scripts/pr-lifecycle",
      "scripts/pr-lifecycle.mjs",
      "scripts/pr-release-queue",
      "scripts/pr-release-queue.mjs",
      "scripts/with-dedicated-agent-slot.sh",
      "scripts/run-focused-vitest-pair.sh",
    ]) {
      expect(existsSync(path.join(root, relativePath))).toBe(false);
    }
  });

  it("delegates routine cleanup to the hourly worktree GC", () => {
    const workflow = read("docs/agent-guides/workflow.md");
    expect(workflow).toContain("ai.openclaw.worktree-gc");
    expect(workflow).toContain("--interval-secs 3600");
  });
});
