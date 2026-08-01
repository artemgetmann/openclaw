import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "pr-lifecycle.mjs");

type LifecycleOutput = {
  action: string;
  authority?: string;
  candidate?: {
    headSha: string;
    diffFingerprint: string;
  };
  contractId: string;
  nativeTool?: { sequence: string[] };
  owner?: { threadId: string; hostId: string } | null;
  prompt?: string;
};

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pr-lifecycle-"));
  const gh = path.join(root, "fake-gh.mjs");
  const metadata = {
    number: 42,
    url: "https://github.com/artemgetmann/openclaw/pull/42",
    state: "OPEN",
    isDraft: false,
    headRefName: "codex/lifecycle-test",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    files: [{ path: "scripts/pr-lifecycle.mjs" }, { path: "AGENTS.md" }],
    body: "Observable claim + acceptance criteria: illegal worker routing fails closed",
  };

  // The fake preserves the exact `gh pr view`/`gh pr diff` boundary used in
  // production. Tests can mutate metadata without teaching the command a test-
  // only PR representation or bypassing its immutable-candidate checks.
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(process.env.TEST_PR_METADATA);
} else if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write(process.env.TEST_PR_PATCH);
} else {
  process.stderr.write("unexpected fake gh call: " + args.join(" "));
  process.exit(2);
}
`,
  );
  fs.chmodSync(gh, 0o755);

  return {
    root,
    gh,
    metadata,
    env: {
      ...process.env,
      OPENCLAW_PR_LIFECYCLE_GH: gh,
      OPENCLAW_PR_LIFECYCLE_STATE_DIR: path.join(root, "state"),
      TEST_PR_METADATA: JSON.stringify(metadata),
      TEST_PR_PATCH: "diff --git a/AGENTS.md b/AGENTS.md\n+policy\n",
    },
  };
}

function run(fixture: ReturnType<typeof makeFixture>, args: string[]) {
  const output = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: fixture.env,
    encoding: "utf8",
  });
  return JSON.parse(output) as LifecycleOutput;
}

function runFailure(fixture: ReturnType<typeof makeFixture>, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: fixture.env,
    encoding: "utf8",
  });
}

function beginLiveTester(fixture: ReturnType<typeof makeFixture>) {
  return run(fixture, [
    "handoff-test",
    "42",
    "--test-kind",
    "live-external",
    "--transport",
    "user-visible-task",
    "--owner-thread",
    "builder-thread",
    "--owner-host",
    "builder-host",
  ]);
}

describe("scripts/pr-lifecycle", () => {
  it("fails closed when live or external testing requests nested transport", () => {
    const fixture = makeFixture();
    const result = runFailure(fixture, [
      "handoff-test",
      "42",
      "--test-kind",
      "live-external",
      "--transport",
      "nested-read-only",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("live/external testing requires transport=user-visible-task");
    expect(fs.existsSync(path.join(fixture.root, "state", "pr-42.json"))).toBe(false);
  });

  it("reserves one tester handoff and refuses duplicate active ownership", () => {
    const fixture = makeFixture();
    const first = beginLiveTester(fixture);

    expect(first.action).toBe("create_thread");
    expect(first.nativeTool?.sequence).toEqual([
      "list_projects",
      "create_thread",
      "accept-test-owner",
    ]);
    expect(first.prompt).toContain(
      "Never route live/external testing or release through a nested sub-agent",
    );

    // The crash window between contract emission and native task acceptance is
    // deliberately one-shot. A compacted builder sees the pending claim and
    // must resolve that identity instead of quietly creating a second tester.
    const repeated = beginLiveTester(fixture);
    expect(repeated).toMatchObject({
      action: "do-not-create",
      contractId: first.contractId,
      owner: null,
    });

    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      first.contractId,
      "--thread-id",
      "tester-thread",
      "--host-id",
      "tester-host",
    ]);
    const duplicate = runFailure(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      first.contractId,
      "--thread-id",
      "different-thread",
      "--host-id",
      "tester-host",
    ]);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("a different tester owner is already active");
  });

  it("consumes the exact tester receipt before routing one user-visible release worker", () => {
    const fixture = makeFixture();
    const tester = beginLiveTester(fixture);
    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      tester.contractId,
      "--thread-id",
      "tester-thread",
      "--host-id",
      "tester-host",
    ]);

    const receiptPath = path.join(fixture.root, "tester-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        contractId: tester.contractId,
        status: "PASS",
        headSha: tester.candidate?.headSha,
        diffFingerprint: tester.candidate?.diffFingerprint,
        owner: { threadId: "tester-thread", hostId: "tester-host" },
        evidence: ["focused lifecycle tests passed"],
        cleanup: { status: "complete", evidence: "no runtime state created" },
        limitations: ["source-only proof"],
      }),
    );
    const recorded = run(fixture, ["record-test-receipt", "42", "--receipt", receiptPath]);
    expect(recorded.action).toBe("archive-exact-tester-thread");

    const prematureRelease = runFailure(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "user-visible-task",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(prematureRelease.stderr).toContain("transport's exact tester lifecycle closure");

    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      tester.contractId,
      "--thread-id",
      "tester-thread",
      "--host-id",
      "tester-host",
      "--closure",
      "archived",
    ]);

    const illegalRelease = runFailure(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "nested-read-only",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(illegalRelease.stderr).toContain("release workers require transport=user-visible-task");

    const release = run(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "user-visible-task",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(release.action).toBe("create_thread");
    expect(release.authority).toBe("normal-merge");
    expect(release.prompt).toContain("No bypass, admin override, deploy, restart");

    const repeated = run(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "user-visible-task",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(repeated).toMatchObject({ action: "do-not-create", contractId: release.contractId });
  });

  it("rejects a stale tester receipt after the PR head changes", () => {
    const fixture = makeFixture();
    const tester = beginLiveTester(fixture);
    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      tester.contractId,
      "--thread-id",
      "tester-thread",
      "--host-id",
      "tester-host",
    ]);

    fixture.metadata.headRefOid = "c".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    const receiptPath = path.join(fixture.root, "stale-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        contractId: tester.contractId,
        status: "PASS",
        headSha: tester.candidate?.headSha,
        diffFingerprint: tester.candidate?.diffFingerprint,
        owner: { threadId: "tester-thread", hostId: "tester-host" },
        evidence: ["old proof"],
        cleanup: { status: "complete" },
        limitations: [],
      }),
    );

    const stale = runFailure(fixture, ["record-test-receipt", "42", "--receipt", receiptPath]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("PR head/diff changed before the tester receipt was recorded");
  });

  it("accepts a terminal nested tester receipt before user-visible release", () => {
    const fixture = makeFixture();
    const tester = run(fixture, [
      "handoff-test",
      "42",
      "--test-kind",
      "read-only",
      "--transport",
      "nested-read-only",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(tester.action).toBe("spawn_nested_read_only");

    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      tester.contractId,
      "--thread-id",
      "nested-agent-id",
      "--host-id",
      "nested-agent",
    ]);
    const receiptPath = path.join(fixture.root, "nested-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        contractId: tester.contractId,
        status: "PASS",
        headSha: tester.candidate?.headSha,
        diffFingerprint: tester.candidate?.diffFingerprint,
        owner: { threadId: "nested-agent-id", hostId: "nested-agent" },
        evidence: ["deterministic source proof passed"],
        cleanup: { status: "not-required" },
        limitations: [],
      }),
    );
    run(fixture, ["record-test-receipt", "42", "--receipt", receiptPath]);
    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      tester.contractId,
      "--thread-id",
      "nested-agent-id",
      "--host-id",
      "nested-agent",
      "--closure",
      "terminal-receipt",
    ]);

    const release = run(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "user-visible-task",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(release.action).toBe("create_thread");
  });

  it("keeps one release owner across a repaired head and resumes it after fresh proof", () => {
    const fixture = makeFixture();
    const firstTester = beginLiveTester(fixture);
    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      firstTester.contractId,
      "--thread-id",
      "first-tester",
      "--host-id",
      "tester-host",
    ]);
    const firstReceiptPath = path.join(fixture.root, "first-receipt.json");
    fs.writeFileSync(
      firstReceiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        contractId: firstTester.contractId,
        status: "PASS",
        headSha: firstTester.candidate?.headSha,
        diffFingerprint: firstTester.candidate?.diffFingerprint,
        owner: { threadId: "first-tester", hostId: "tester-host" },
        evidence: ["first candidate passed"],
        cleanup: { status: "complete" },
        limitations: [],
      }),
    );
    run(fixture, ["record-test-receipt", "42", "--receipt", firstReceiptPath]);
    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      firstTester.contractId,
      "--thread-id",
      "first-tester",
      "--host-id",
      "tester-host",
      "--closure",
      "archived",
    ]);
    const release = run(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "user-visible-task",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    run(fixture, [
      "accept-release-owner",
      "42",
      "--contract-id",
      release.contractId,
      "--thread-id",
      "release-thread",
      "--host-id",
      "release-host",
    ]);

    fixture.metadata.headRefOid = "c".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    fixture.env.TEST_PR_PATCH = "diff --git a/AGENTS.md b/AGENTS.md\n+repaired policy\n";
    const blocked = runFailure(fixture, [
      "handoff-test",
      "42",
      "--test-kind",
      "read-only",
      "--transport",
      "user-visible-task",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(blocked.stderr).toContain("owner may still be active");

    const repairedTester = run(fixture, [
      "handoff-test",
      "42",
      "--test-kind",
      "read-only",
      "--transport",
      "user-visible-task",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
      "--returning-release-contract",
      release.contractId,
    ]);
    expect(repairedTester.action).toBe("create_thread");
    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      repairedTester.contractId,
      "--thread-id",
      "repaired-tester",
      "--host-id",
      "tester-host",
    ]);
    const repairedReceiptPath = path.join(fixture.root, "repaired-receipt.json");
    fs.writeFileSync(
      repairedReceiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        contractId: repairedTester.contractId,
        status: "PASS",
        headSha: repairedTester.candidate?.headSha,
        diffFingerprint: repairedTester.candidate?.diffFingerprint,
        owner: { threadId: "repaired-tester", hostId: "tester-host" },
        evidence: ["repaired candidate passed"],
        cleanup: { status: "complete" },
        limitations: [],
      }),
    );
    run(fixture, ["record-test-receipt", "42", "--receipt", repairedReceiptPath]);
    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      repairedTester.contractId,
      "--thread-id",
      "repaired-tester",
      "--host-id",
      "tester-host",
      "--closure",
      "archived",
    ]);

    const resumed = run(fixture, [
      "handoff-release",
      "42",
      "--transport",
      "user-visible-task",
      "--authority",
      "normal-merge",
      "--owner-thread",
      "builder-thread",
      "--owner-host",
      "builder-host",
    ]);
    expect(resumed).toMatchObject({
      action: "resume-thread",
      contractId: release.contractId,
      owner: { threadId: "release-thread", hostId: "release-host" },
    });
    expect(resumed.nativeTool?.sequence).toEqual(["send_message_to_thread"]);
  });
});
