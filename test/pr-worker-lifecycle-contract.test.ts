import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

const agents = readRepoFile("AGENTS.md");
const workflow = readRepoFile("docs/agent-guides/workflow.md");
const ci = readRepoFile("docs/ci.md");
const forkGuide = readRepoFile("FORK_CONTRIBUTING.md");
const prTemplate = readRepoFile(".github/pull_request_template.md");
const normalizedWorkflow = workflow.replace(/\s+/g, " ");

describe("canonical PR worker lifecycle policy", () => {
  it("keeps one authoritative lifecycle discoverable from agent instructions", () => {
    // AGENTS routes every implementation owner to the one policy source. The
    // former opt-in pilot and tester-skip language must not quietly return.
    expect(agents).toContain("For every implementation PR");
    expect(agents).toContain("docs/agent-guides/workflow.md");
    expect(workflow).toContain("## Canonical PR worker lifecycle");
    expect(workflow).not.toContain("Provisional tester-first PR pilot");
    expect(forkGuide).not.toMatch(/tester.{0,80}skip/is);
  });

  it("separates builder, tester, and release ownership without self-merge", () => {
    // The release role exists to keep default-branch writes and approvals out
    // of builder or tester transcripts and to prevent duplicate merge owners.
    expect(workflow).toContain("`builder -> independent tester -> release worker`");
    expect(workflow).toContain("builder is always a user-visible, project-scoped Codex task");
    expect(workflow).toContain("It never merges its own PR and never deploys");
    expect(normalizedWorkflow).toContain(
      "exactly one fresh user-visible project-scoped release worker",
    );
    expect(normalizedWorkflow).toContain("never a nested sub-agent");
    expect(normalizedWorkflow).toContain("normal non-admin merge");
    expect(normalizedWorkflow).toContain(
      "must not create a duplicate builder, tester, or release owner",
    );
  });

  it("forces user-visible transport for live or protected testing", () => {
    // Nested testers are intentionally limited to cheap read-only proof. Any
    // action needing durable ownership or user-visible approval must be a task.
    expect(normalizedWorkflow).toContain("short-lived and deterministic");
    expect(normalizedWorkflow).toContain("no protected resource, external side effect");
    expect(normalizedWorkflow).toContain("end-to-end or live acceptance");
    expect(normalizedWorkflow).toContain("Telegram sends");
    expect(normalizedWorkflow).toContain("GUI or Computer Use");
    expect(normalizedWorkflow).toContain("durable independently addressable transcript");
    expect(normalizedWorkflow).toContain("does not retry after ambiguity, failure, refusal");
  });

  it("invalidates stale-head proof and fails lifecycle operations closed", () => {
    // A changed head is a new candidate. Exact identity checks ensure archival
    // or repair steering cannot hit an adjacent user-visible task.
    expect(normalizedWorkflow).toContain("head change makes prior tester proof stale");
    expect(normalizedWorkflow).toContain("fresh tester for the new immutable head");
    expect(normalizedWorkflow).toContain("archive nothing adjacent");
    expect(normalizedWorkflow).toContain("preserve the one known owner");
    expect(normalizedWorkflow).toContain("unarchive and steer only the exact builder thread");
  });

  it("keeps CI guidance and PR receipts aligned with the canonical roles", () => {
    // Mechanics stay in docs/ci.md while ownership stays in workflow.md. The PR
    // body captures the immutable packet needed to cross that boundary safely.
    expect(ci).toContain("canonical contract");
    expect(ci).toContain("the builder investigates");
    expect(ci).toContain("one fresh user-visible release worker");
    expect(forkGuide).toContain("lifecycle ownership");
    expect(prTemplate).toContain("Base branch + exact SHA");
    expect(prTemplate).toContain("Diff fingerprint + changed paths");
    expect(prTemplate).toContain("Tester transport");
    expect(prTemplate).toContain("exact worker identity/head/diff");
    expect(prTemplate).not.toContain("exact thread/head/diff");
    expect(prTemplate).toContain("Tester lifecycle closure");
    expect(prTemplate).toContain("fresh user-visible project task ID");
  });
});
