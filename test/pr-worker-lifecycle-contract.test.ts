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
const lifecycleCommand = readRepoFile("scripts/pr-lifecycle");
const threadRecoverySkill = readRepoFile(".agents/skills/codex-thread-control-recovery/SKILL.md");
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
    expect(workflow).toContain(
      "`builder -> code reviewer -> independent tester -> release operator`",
    );
    expect(workflow).toContain("builder is always a user-visible, project-scoped Codex task");
    expect(workflow).toContain("It never merges its own PR and never deploys");
    expect(workflow).toContain("Repo-backed release ownership is one distinct fenced queue lease");
    expect(normalizedWorkflow).toContain("exact builder identity cannot claim it");
    expect(workflow).toContain("Native Codex tasks are optional coordination");
    expect(normalizedWorkflow).toContain("never a nested sub-agent");
    expect(normalizedWorkflow).toContain("normal non-admin merge");
    expect(normalizedWorkflow).toContain(
      "Neither path may create a duplicate builder, tester, or release owner",
    );
    expect(normalizedWorkflow).toContain("Native archival is best-effort roster UX");
    expect(normalizedWorkflow).toContain(
      "records the exact finding and identities with `return-source`",
    );
    expect(normalizedWorkflow).toContain(
      "repeats this cycle with that exact release contract and a fresh tester",
    );
    expect(normalizedWorkflow).toContain("`pr-release-queue route-base-drift`");
    expect(normalizedWorkflow).toContain("`pr-lifecycle accept-queue-source-return`");
    expect(normalizedWorkflow).toContain("callback may wake the builder but is not required");
    expect(normalizedWorkflow).toContain(
      "any substantive overlap or conflict immediately terminates",
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

  it("requires exact-head review before independent testing and release", () => {
    expect(normalizedWorkflow).toContain("distinct reviewer records the exact commit");
    expect(normalizedWorkflow).toContain("unresolved finding severities before testing");
    expect(normalizedWorkflow).toContain(
      "source-head change invalidates both review and tester receipts",
    );
    expect(normalizedWorkflow).toContain("fresh review PASS with no serious finding left open");
    expect(normalizedWorkflow).toContain("`routine-release` capability tier");
    expect(normalizedWorkflow).toContain("`reasoning-escalation`");
    expect(normalizedWorkflow).toContain("not hard-coded model names");
  });

  it("invalidates stale-head proof and fails lifecycle operations closed", () => {
    // A changed head is a new candidate. Exact identity checks ensure archival
    // or repair steering cannot hit an adjacent user-visible task.
    expect(normalizedWorkflow).toContain("head change makes prior tester proof stale");
    expect(normalizedWorkflow).toContain("fresh tester for the new immutable head");
    expect(normalizedWorkflow).toContain("typed capacity-owner recovery receipt");
    expect(normalizedWorkflow).toContain("atomically reserves exactly one fresh tester");
    expect(normalizedWorkflow).toContain("record `workloadStarted=false`");
    expect(normalizedWorkflow).toContain("archive nothing adjacent");
    expect(normalizedWorkflow).toContain("preserve the one known owner");
    expect(normalizedWorkflow).toContain("unarchive and steer only the exact builder thread");
  });

  it("keeps CI guidance and PR receipts aligned with the canonical roles", () => {
    // Mechanics stay in docs/ci.md while ownership stays in workflow.md. The PR
    // body captures the immutable packet needed to cross that boundary safely.
    expect(ci).toContain("canonical contract");
    expect(ci).toContain("the builder investigates");
    expect(ci).toContain("one distinct fenced queue lease");
    expect(forkGuide).toContain("lifecycle ownership");
    expect(prTemplate).toContain("Base branch + exact SHA");
    expect(prTemplate).toContain("Diff fingerprint + changed paths");
    expect(prTemplate).toContain("Tester transport");
    expect(prTemplate).toContain("exact worker identity/head/diff");
    expect(prTemplate).not.toContain("exact thread/head/diff");
    expect(prTemplate).toContain("Tester lifecycle closure");
    expect(prTemplate).toContain("repo-backed lease ID + fence + distinct owner");
    expect(prTemplate).toContain("queue `builderSuspended=true` ownership receipt");
    expect(prTemplate).toContain("same-builder `archived=false` receipt");
    expect(prTemplate).toContain("typed attempt ID + old/new base + classification");
  });

  it("preserves direct user authority without weakening protected gates", () => {
    // Routine continuation should not repeatedly ask for authority already
    // granted by the user, while sensitive or broader actions remain excluded.
    expect(normalizedWorkflow).toContain("preserves it in the typed release packet");
    expect(normalizedWorkflow).toContain("do not ask the user to repeat that authority");
    expect(normalizedWorkflow).toContain("only `normal-merge` and an explicitly granted `deploy`");
    expect(normalizedWorkflow).toContain("credentials, OTP, admin/bypass");
  });

  it("treats restricted host-state failures and ambiguous mutations safely", () => {
    // A restricted credential or network result cannot establish host truth.
    // The one-transport rule prevents a failed shell mutation from falling
    // through to a connector and duplicating an external side effect.
    expect(agents).toContain("A sandbox-only failure is indeterminate");
    expect(normalizedWorkflow).toContain("smallest decisive read-only diagnostic");
    expect(normalizedWorkflow).toContain("gh auth status` is not decisive");
    expect(normalizedWorkflow).toContain("Choose exactly one mutation transport");
    expect(normalizedWorkflow).toContain("Never use both transports for one mutation");
    expect(normalizedWorkflow).toContain("never blindly retry it");
    expect(prTemplate).toContain("authenticated connector + expected head; exactly one");
    expect(lifecycleCommand).toContain('source "$script_dir/lib/github-auth-preflight.sh"');
    expect(lifecycleCommand).toContain("openclaw_github_preflight");
  });

  it("makes native thread recovery a verified bounded transaction", () => {
    // Native control receipts prove API acceptance, not delivery, progress, or
    // completion. The repo-local skill keeps those claims mechanically distinct.
    expect(agents).toContain(".agents/skills/codex-thread-control-recovery/SKILL.md");
    expect(normalizedWorkflow).toContain("successful send receipt is not delivery proof");
    expect(normalizedWorkflow).toContain("delivered turn is not completion proof");
    expect(normalizedWorkflow).toContain("Never retry an ambiguously accepted send");
    expect(normalizedWorkflow).toContain("`notLoaded` alone is not archive proof");
    expect(normalizedWorkflow).toContain("do not vary starting-state forms as retries");
    expect(normalizedWorkflow).toContain("allow at most one identical retry");
    expect(normalizedWorkflow).toContain("Do not keep the caller alive with shell sleep loops");
    expect(threadRecoverySkill).toContain("Do not cycle");
    expect(threadRecoverySkill).toContain("most one identical create retry");
    expect(threadRecoverySkill).toContain("preserve the pending lifecycle reservation");
    expect(threadRecoverySkill).toContain("set only that");
    expect(threadRecoverySkill).toContain("target to `archived:false`");
    expect(threadRecoverySkill).toContain("A successful send receipt alone is insufficient");
    expect(threadRecoverySkill).toContain("Never repeat an ambiguously accepted send");
    expect(threadRecoverySkill).toContain("`notLoaded` does not prove archival");
    expect(threadRecoverySkill).toContain("unchanged archive state proves");
    expect(threadRecoverySkill).toContain("require either a new running tool/action");
    expect(threadRecoverySkill).toContain("After two bounded read-only reconciliation attempts");
    expect(threadRecoverySkill).toContain("Do not fall back to the CLI");
  });
});
