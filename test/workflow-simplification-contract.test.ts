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

  it("allows isolated development work to run concurrently", () => {
    const agents = read("AGENTS.md");
    const fleet = read("docs/agent-guides/fleet-resource-control.md");
    const adoption = read("scripts/adopt-codex-worktree.sh");

    expect(agents).toContain("Ordinary isolated tests, typechecks, builds");
    expect(fleet).toContain("Default: no machine-wide slot");
    expect(fleet).toContain("package, sign, notarize, publish, or install");
    expect(adoption).not.toContain("with-heavy-local-slot.sh");
    expect(adoption).not.toContain("capacity-wait-seconds");
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
