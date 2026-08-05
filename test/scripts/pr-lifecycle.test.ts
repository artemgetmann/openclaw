import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "pr-lifecycle.mjs");

type LifecycleOutput = {
  action: string;
  authority?: string;
  stateDirectory: string;
  taskAuthority?: { allowedActions: string[]; source: string };
  candidate?: {
    headSha: string;
    diffFingerprint: string;
  };
  contractId: string;
  nativeTool?: {
    sequence: string[];
    createThread?: { model: string; thinking: string };
  };
  owner?: { threadId: string; hostId: string } | null;
  prompt?: string;
  retryOfContractId?: string | null;
  routing?: {
    dispatcher: { role: string; threadId: string; hostId: string };
    decision: string;
    rationale: string[];
  };
  releasePacket?: {
    candidate: { pr: number; headSha: string; diffFingerprint: string; changedPaths: string[] };
    builder: { threadId: string; hostId: string; wakeRoute: { threadId: string; hostId: string } };
    testerReceipt: { status: string; closure: string };
    authority: { allowedActions: string[] };
    declaredDependencies: Array<{ pr: number; relation: string; reason: string }>;
    lifecycle: { contractId: string; stateDirectory: string };
  };
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

function runFromFreshWorktree(
  fixture: ReturnType<typeof makeFixture>,
  cwd: string,
  args: string[],
) {
  const output = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: fixture.env,
    encoding: "utf8",
  });
  return JSON.parse(output) as LifecycleOutput;
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

function completeCapacityOnlyFailure(fixture: ReturnType<typeof makeFixture>) {
  const tester = run(fixture, [
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
  run(fixture, [
    "accept-test-owner",
    "42",
    "--contract-id",
    tester.contractId,
    "--thread-id",
    "capacity-blocked-tester",
    "--host-id",
    "tester-host",
  ]);
  const receiptPath = path.join(fixture.root, "capacity-fail.json");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      role: "tester",
      routing: tester.routing,
      contractId: tester.contractId,
      status: "FAIL",
      headSha: tester.candidate?.headSha,
      diffFingerprint: tester.candidate?.diffFingerprint,
      owner: { threadId: "capacity-blocked-tester", hostId: "tester-host" },
      evidence: ["heavy guard refused disk pressure before workload start"],
      cleanup: { status: "not-required", evidence: "workload never started" },
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
    "capacity-blocked-tester",
    "--host-id",
    "tester-host",
    "--closure",
    "archived",
  ]);
  return tester;
}

function writeCapacityRecovery(
  fixture: ReturnType<typeof makeFixture>,
  priorTesterContractId: string,
  overrides: Record<string, unknown> = {},
) {
  const receiptPath = path.join(fixture.root, `capacity-recovery-${randomUUID()}.json`);
  const receipt = {
    schemaVersion: 1,
    role: "capacity-recovery",
    source: "authorized-capacity-owner-receipt",
    priorTesterContractId,
    cause: { class: "host_unhealthy", code: "disk_pressure", workloadStarted: false },
    capacity: {
      availableKiB: 36_756_724,
      requiredKiB: 36_700_160,
      heavyLockDirectoriesEmpty: true,
      releaseLockDirectoriesEmpty: true,
    },
    evidence: ["material disk floor restored and lock directories are empty"],
    ...overrides,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  return receiptPath;
}

function capacityRetryArgs(priorTesterContractId: string, recoveryPath: string) {
  return [
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
    "--capacity-retry-contract",
    priorTesterContractId,
    "--capacity-recovery-receipt",
    recoveryPath,
  ];
}

function acceptReleaseHandoff(fixture: ReturnType<typeof makeFixture>, contractId: string) {
  return run(fixture, [
    "accept-release-handoff",
    "42",
    "--contract-id",
    contractId,
    "--thread-id",
    "release-thread",
    "--host-id",
    "release-host",
    "--builder-thread",
    "builder-thread",
    "--builder-host",
    "builder-host",
    "--builder-archived",
    "true",
  ]);
}

function returnSourceArgs(contractId: string, finding: string, builderThread = "builder-thread") {
  return [
    "return-source",
    "42",
    "--contract-id",
    contractId,
    "--thread-id",
    "release-thread",
    "--host-id",
    "release-host",
    "--builder-thread",
    builderThread,
    "--builder-host",
    "builder-host",
    "--builder-unarchived",
    "true",
    "--finding",
    finding,
  ];
}

function returnSource(fixture: ReturnType<typeof makeFixture>, contractId: string) {
  return run(fixture, returnSourceArgs(contractId, "archive receipt must gate review"));
}

function completeTesterPass(fixture: ReturnType<typeof makeFixture>) {
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
  const receiptPath = path.join(fixture.root, "tester-pass.json");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      role: "tester",
      routing: tester.routing,
      contractId: tester.contractId,
      status: "PASS",
      headSha: tester.candidate?.headSha,
      diffFingerprint: tester.candidate?.diffFingerprint,
      owner: { threadId: "tester-thread", hostId: "tester-host" },
      evidence: ["exact-head lifecycle proof passed"],
      cleanup: { status: "complete" },
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
    "tester-thread",
    "--host-id",
    "tester-host",
    "--closure",
    "archived",
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

  it("refreshes the PR receipt before recreating a cancelled tester handoff", () => {
    const fixture = makeFixture();
    const first = beginLiveTester(fixture);
    run(fixture, [
      "cancel-pending",
      "42",
      "--role",
      "tester",
      "--contract-id",
      first.contractId,
      "--confirm-no-thread-created",
    ]);
    fixture.metadata.body = "Observable claim + acceptance criteria: current tester receipt text";
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);

    const replacement = beginLiveTester(fixture);
    expect(replacement.action).toBe("create_thread");
    expect(replacement.prompt).toContain("current tester receipt text");
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
    expect(first.prompt).toContain("gh pr diff 42 --patch");

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

  it("atomically reserves one fresh tester after typed capacity recovery", () => {
    const fixture = makeFixture();
    const priorTester = completeCapacityOnlyFailure(fixture);
    const recoveryPath = writeCapacityRecovery(fixture, priorTester.contractId);
    const retryArgs = capacityRetryArgs(priorTester.contractId, recoveryPath);
    const retry = run(fixture, retryArgs);
    expect(retry.action).toBe("create_thread");
    expect(retry.contractId).not.toBe(priorTester.contractId);
    expect(retry.retryOfContractId).toBe(priorTester.contractId);

    // Retrying the same command is safe: the new pending reservation wins and
    // the caller cannot create a second tester from the same recovery receipt.
    const repeated = run(fixture, retryArgs);
    expect(repeated).toMatchObject({ action: "do-not-create", contractId: retry.contractId });

    const state = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "state", "pr-42.json"), "utf8"),
    );
    expect(state.testerHistory).toHaveLength(1);
    expect(state.testerHistory[0].tester.contractId).toBe(priorTester.contractId);
    expect(state.tester.retryOfContractId).toBe(priorTester.contractId);
  });

  it("refuses a recursive capacity retry after the one replacement also fails", () => {
    const fixture = makeFixture();
    const originalTester = completeCapacityOnlyFailure(fixture);
    const originalRecovery = writeCapacityRecovery(fixture, originalTester.contractId);
    const replacement = run(
      fixture,
      capacityRetryArgs(originalTester.contractId, originalRecovery),
    );

    // Close the authorized replacement with the same pre-work capacity-only
    // failure. This must not mint a fresh retry budget from its new identity.
    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      replacement.contractId,
      "--thread-id",
      "replacement-tester",
      "--host-id",
      "tester-host",
    ]);
    const replacementReceiptPath = path.join(fixture.root, "replacement-capacity-fail.json");
    fs.writeFileSync(
      replacementReceiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        routing: replacement.routing,
        contractId: replacement.contractId,
        status: "FAIL",
        headSha: replacement.candidate?.headSha,
        diffFingerprint: replacement.candidate?.diffFingerprint,
        owner: { threadId: "replacement-tester", hostId: "tester-host" },
        evidence: ["heavy guard again refused disk pressure before workload start"],
        cleanup: { status: "not-required", evidence: "workload never started" },
        limitations: [],
      }),
    );
    run(fixture, ["record-test-receipt", "42", "--receipt", replacementReceiptPath]);
    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      replacement.contractId,
      "--thread-id",
      "replacement-tester",
      "--host-id",
      "tester-host",
      "--closure",
      "archived",
    ]);

    const secondRecovery = writeCapacityRecovery(fixture, replacement.contractId);
    const recursiveRetry = runFailure(
      fixture,
      capacityRetryArgs(replacement.contractId, secondRecovery),
    );
    expect(recursiveRetry.status).toBe(1);
    expect(recursiveRetry.stderr).toContain(
      "capacity retry was already consumed for this immutable candidate",
    );

    const state = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "state", "pr-42.json"), "utf8"),
    );
    expect(state.tester.contractId).toBe(replacement.contractId);
    expect(state.tester.phase).toBe("closed");
    expect(state.testerHistory).toHaveLength(1);
  });

  it("rejects capacity retry without exact no-work and recovered-capacity proof", () => {
    const fixture = makeFixture();
    const priorTester = completeCapacityOnlyFailure(fixture);
    const recoveryPath = writeCapacityRecovery(fixture, priorTester.contractId, {
      cause: { class: "host_unhealthy", code: "disk_pressure", workloadStarted: true },
    });

    const result = runFailure(fixture, capacityRetryArgs(priorTester.contractId, recoveryPath));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prove disk-pressure refusal before workload start");
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
        routing: tester.routing,
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

    fixture.metadata.body =
      "Observable claim + acceptance criteria: refreshed exact-head release receipt";
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);

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
    expect(release.stateDirectory).toBe(fixture.env.OPENCLAW_PR_LIFECYCLE_STATE_DIR);
    expect(release.authority).toBe("normal-merge");
    expect(release.taskAuthority?.allowedActions).toEqual(["normal-merge"]);
    expect(release.nativeTool?.sequence).toEqual([
      "list_projects",
      "create_thread",
      "accept-release-owner",
      "set_thread_archived",
      "accept-release-handoff",
    ]);
    expect(release.nativeTool?.createThread).toEqual({
      model: "gpt-5.6-luna",
      thinking: "max",
    });
    expect(release.prompt).toContain("archive the exact builder thread");
    expect(release.prompt).toContain(
      `OPENCLAW_PR_LIFECYCLE_STATE_DIR=${JSON.stringify(fixture.env.OPENCLAW_PR_LIFECYCLE_STATE_DIR)}`,
    );
    expect(release.prompt).toContain("Builder archival belongs to acceptance");
    expect(release.prompt).toContain("refreshed exact-head release receipt");

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
    expect(repeated.stateDirectory).toBe(release.stateDirectory);
  });

  it("accepts a release handoff from a fresh worktree using emitted state provenance", () => {
    const fixture = makeFixture();
    completeTesterPass(fixture);
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

    // Reproduce the native project-task topology: release work starts in a
    // different checkout, but consumes the exact state directory emitted by
    // the builder instead of looking under its own cwd.
    const releaseWorktree = path.join(fixture.root, "fresh-release-worktree");
    fs.mkdirSync(releaseWorktree);
    const accepted = runFromFreshWorktree(fixture, releaseWorktree, [
      "accept-release-handoff",
      "42",
      "--contract-id",
      release.contractId,
      "--thread-id",
      "release-thread",
      "--host-id",
      "release-host",
      "--builder-thread",
      "builder-thread",
      "--builder-host",
      "builder-host",
      "--builder-archived",
      "true",
    ]);

    expect(accepted).toMatchObject({
      action: "release-handoff-accepted",
      contractId: release.contractId,
      stateDirectory: release.stateDirectory,
    });
    expect(fs.existsSync(path.join(releaseWorktree, ".local", "pr-lifecycle"))).toBe(false);
  });

  it("emits a durable repo-backed packet instead of creating a release thread", () => {
    const fixture = makeFixture();
    completeTesterPass(fixture);
    const dependenciesPath = path.join(fixture.root, "dependencies.json");
    fs.writeFileSync(
      dependenciesPath,
      JSON.stringify([{ pr: 41, relation: "requires", reason: "uses its landed contract" }]),
    );

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
      "--queue",
      "repo-backed",
      "--declared-dependencies",
      dependenciesPath,
    ]);

    expect(release.action).toBe("enqueue-release-packet");
    expect(release.nativeTool?.sequence).toEqual([
      "pr-release-queue enqueue",
      "create-or-wake-replaceable-operator",
    ]);
    expect(release.releasePacket).toMatchObject({
      candidate: { pr: 42, headSha: "a".repeat(40) },
      builder: {
        threadId: "builder-thread",
        hostId: "builder-host",
        wakeRoute: { threadId: "builder-thread", hostId: "builder-host" },
      },
      testerReceipt: { status: "PASS", closure: "archived" },
      authority: { allowedActions: ["normal-merge"] },
      declaredDependencies: [{ pr: 41, relation: "requires", reason: "uses its landed contract" }],
      lifecycle: {
        contractId: release.contractId,
        stateDirectory: fixture.env.OPENCLAW_PR_LIFECYCLE_STATE_DIR,
      },
    });
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
        routing: tester.routing,
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
    expect(tester.routing).toMatchObject({
      dispatcher: { role: "builder", threadId: "builder-thread", hostId: "builder-host" },
      decision: "nested-eligible",
    });

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
        routing: tester.routing,
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

  it("rejects a tester receipt that omits the builder dispatcher rationale", () => {
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
    const receiptPath = path.join(fixture.root, "missing-routing-receipt.json");
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

    const result = runFailure(fixture, ["record-test-receipt", "42", "--receipt", receiptPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dispatcher routing");
  });

  it("carries direct normal-merge and deploy authority but rejects protected actions", () => {
    const fixture = makeFixture();
    completeTesterPass(fixture);
    const authorityPath = path.join(fixture.root, "task-authority.json");
    fs.writeFileSync(
      authorityPath,
      JSON.stringify({
        schemaVersion: 1,
        source: "direct-user-task",
        scope: "merge PR #42 and deploy it to the already-authorized staging target",
        allowedActions: ["normal-merge", "deploy"],
        constraints: ["no credentials", "no admin or bypass", "no public release"],
      }),
    );
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
      "--task-authority",
      authorityPath,
    ]);
    expect(release.taskAuthority).toMatchObject({
      source: "direct-user-task",
      allowedActions: ["normal-merge", "deploy"],
    });
    expect(release.nativeTool?.createThread).toEqual({
      model: "gpt-5.6-terra",
      thinking: "high",
    });
    expect(release.prompt).toContain('"allowedActions":["normal-merge","deploy"]');

    const protectedFixture = makeFixture();
    completeTesterPass(protectedFixture);
    const protectedPath = path.join(protectedFixture.root, "bad-authority.json");
    fs.writeFileSync(
      protectedPath,
      JSON.stringify({
        schemaVersion: 1,
        source: "direct-user-task",
        scope: "PR #42",
        allowedActions: ["normal-merge", "credentials"],
        constraints: [],
      }),
    );
    const rejected = runFailure(protectedFixture, [
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
      "--task-authority",
      protectedPath,
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("granting only normal-merge and optional deploy");
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
        routing: firstTester.routing,
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
    const prematureReturn = runFailure(fixture, [
      "return-source",
      "42",
      "--contract-id",
      release.contractId,
      "--thread-id",
      "release-thread",
      "--host-id",
      "release-host",
      "--builder-thread",
      "builder-thread",
      "--builder-host",
      "builder-host",
      "--builder-unarchived",
      "true",
      "--finding",
      "must not skip acceptance",
    ]);
    expect(prematureReturn.status).toBe(1);
    expect(prematureReturn.stderr).toContain("active accepted release handoff");
    expect(acceptReleaseHandoff(fixture, release.contractId).action).toBe(
      "release-handoff-accepted",
    );
    expect(acceptReleaseHandoff(fixture, release.contractId).action).toBe(
      "release-handoff-already-accepted",
    );

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

    const stolen = runFailure(fixture, [
      "handoff-test",
      "42",
      "--test-kind",
      "read-only",
      "--transport",
      "user-visible-task",
      "--owner-thread",
      "attacker-thread",
      "--owner-host",
      "attacker-host",
      "--returning-release-contract",
      release.contractId,
    ]);
    expect(stolen.status).toBe(1);
    expect(stolen.stderr).toContain("builder identity differs from the recorded candidate owner");

    expect(returnSource(fixture, release.contractId).action).toBe("source-returned");
    expect(returnSource(fixture, release.contractId).action).toBe("source-already-returned");

    const returningTestArgs = (contractId: string) => [
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
      contractId,
    ];
    const repairedTester = run(fixture, returningTestArgs(release.contractId));
    expect(repairedTester.action).toBe("create_thread");

    // A reservation that definitely never acquired an owner must not strand
    // the accepted release contract when main advances again. The release
    // owner reopens the same builder, and the replacement candidate retires
    // the cancelled fingerprint without creating another release owner.
    run(fixture, [
      "cancel-pending",
      "42",
      "--role",
      "tester",
      "--contract-id",
      repairedTester.contractId,
      "--confirm-no-thread-created",
    ]);
    fixture.metadata.baseRefOid = "f".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    fixture.env.TEST_PR_PATCH =
      "diff --git a/AGENTS.md b/AGENTS.md\n+repaired policy after second main advance\n";

    const directRefreshWithoutReturn = runFailure(fixture, returningTestArgs(release.contractId));
    expect(directRefreshWithoutReturn.status).toBe(1);
    expect(directRefreshWithoutReturn.stderr).toContain("owner may still be active");

    const wrongContractReturn = runFailure(
      fixture,
      returnSourceArgs("wrong-release-contract", "must preserve the release contract identity"),
    );
    expect(wrongContractReturn.status).toBe(1);
    expect(wrongContractReturn.stderr).toContain("no matching release handoff contract");

    const wrongBuilderReturn = runFailure(
      fixture,
      returnSourceArgs(release.contractId, "must preserve the builder identity", "wrong-builder"),
    );
    expect(wrongBuilderReturn.status).toBe(1);
    expect(wrongBuilderReturn.stderr).toContain("exact recorded builder");

    const statePath = path.join(fixture.root, "state", "pr-42.json");
    const malformedCancelledState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    delete malformedCancelledState.tester.owner;
    fs.writeFileSync(statePath, JSON.stringify(malformedCancelledState));
    const missingOwnerReturn = runFailure(
      fixture,
      returnSourceArgs(release.contractId, "must reject an ambiguous cancelled owner"),
    );
    expect(missingOwnerReturn.status).toBe(1);
    expect(missingOwnerReturn.stderr).toContain("ownerless cancelled tester reservation");

    // Restore the explicit null written by cancel-pending. The preceding shape
    // is intentionally malformed test state, not a supported lifecycle edit.
    malformedCancelledState.tester.owner = null;
    fs.writeFileSync(statePath, JSON.stringify(malformedCancelledState));

    const repeatedReturn = run(
      fixture,
      returnSourceArgs(
        release.contractId,
        "main advanced again after the tester reservation was cancelled",
      ),
    );
    expect(repeatedReturn).toMatchObject({
      action: "source-returned",
      contractId: release.contractId,
      owner: { threadId: "release-thread", hostId: "release-host" },
      builder: { threadId: "builder-thread", hostId: "builder-host" },
    });

    const replacementTester = run(fixture, returningTestArgs(release.contractId));
    expect(replacementTester.action).toBe("create_thread");
    expect(replacementTester.contractId).not.toBe(repairedTester.contractId);
    expect(replacementTester.candidate).toMatchObject({
      headSha: "c".repeat(40),
    });
    expect(replacementTester.candidate?.diffFingerprint).not.toBe(
      repairedTester.candidate?.diffFingerprint,
    );
    const replacementState = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "state", "pr-42.json"), "utf8"),
    );
    expect(replacementState.history.at(-1)).toMatchObject({
      candidate: {
        baseSha: "b".repeat(40),
        diffFingerprint: repairedTester.candidate?.diffFingerprint,
      },
      tester: {
        phase: "cancelled",
        contractId: repairedTester.contractId,
        owner: null,
      },
      release: {
        contractId: release.contractId,
        owner: { threadId: "release-thread", hostId: "release-host" },
      },
    });
    expect(replacementState.release).toMatchObject({
      phase: "awaiting-retest",
      contractId: release.contractId,
      owner: { threadId: "release-thread", hostId: "release-host" },
    });

    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      replacementTester.contractId,
      "--thread-id",
      "replacement-tester",
      "--host-id",
      "tester-host",
    ]);
    fixture.metadata.baseRefOid = "1".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    const ownedTesterBlocksRepeatedReturn = runFailure(
      fixture,
      returnSourceArgs(release.contractId, "must not replace an owned tester"),
    );
    expect(ownedTesterBlocksRepeatedReturn.status).toBe(1);
    expect(ownedTesterBlocksRepeatedReturn.stderr).toContain(
      "ownerless cancelled tester reservation",
    );

    // Restore the first repaired-candidate setup used by the existing
    // repeated-repair proof below.
    fixture.metadata.baseRefOid = "f".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    const replacementReceiptPath = path.join(fixture.root, "replacement-receipt.json");
    fs.writeFileSync(
      replacementReceiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        routing: replacementTester.routing,
        contractId: replacementTester.contractId,
        status: "FAIL",
        headSha: replacementTester.candidate?.headSha,
        diffFingerprint: replacementTester.candidate?.diffFingerprint,
        owner: { threadId: "replacement-tester", hostId: "tester-host" },
        evidence: ["tester found a second source repair"],
        cleanup: { status: "complete" },
        limitations: [],
      }),
    );
    run(fixture, ["record-test-receipt", "42", "--receipt", replacementReceiptPath]);
    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      replacementTester.contractId,
      "--thread-id",
      "replacement-tester",
      "--host-id",
      "tester-host",
      "--closure",
      "archived",
    ]);

    fixture.metadata.headRefOid = "d".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    fixture.env.TEST_PR_PATCH = "diff --git a/AGENTS.md b/AGENTS.md\n+second repaired policy\n";
    const secondRepairedTester = run(fixture, returningTestArgs(release.contractId));
    expect(secondRepairedTester.action).toBe("create_thread");
    expect(secondRepairedTester.contractId).not.toBe(replacementTester.contractId);
    expect(run(fixture, returningTestArgs(release.contractId))).toMatchObject({
      action: "do-not-create",
      contractId: secondRepairedTester.contractId,
      owner: null,
    });

    const repeatedState = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "state", "pr-42.json"), "utf8"),
    );
    expect(repeatedState.history).toHaveLength(3);
    expect(
      repeatedState.history.map(
        (entry: { release: { contractId: string } }) => entry.release.contractId,
      ),
    ).toEqual([release.contractId, release.contractId, release.contractId]);
    expect(repeatedState.release).toMatchObject({
      phase: "awaiting-retest",
      contractId: release.contractId,
      owner: { threadId: "release-thread", hostId: "release-host" },
    });

    run(fixture, [
      "accept-test-owner",
      "42",
      "--contract-id",
      secondRepairedTester.contractId,
      "--thread-id",
      "second-repaired-tester",
      "--host-id",
      "tester-host",
    ]);
    fixture.metadata.headRefOid = "e".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    const activeTesterBlocksRefresh = runFailure(fixture, returningTestArgs(release.contractId));
    expect(activeTesterBlocksRefresh.status).toBe(1);
    expect(activeTesterBlocksRefresh.stderr).toContain("owner may still be active");

    fixture.metadata.headRefOid = "d".repeat(40);
    fixture.env.TEST_PR_METADATA = JSON.stringify(fixture.metadata);
    const secondReceiptPath = path.join(fixture.root, "second-repaired-receipt.json");
    fs.writeFileSync(
      secondReceiptPath,
      JSON.stringify({
        schemaVersion: 1,
        role: "tester",
        routing: secondRepairedTester.routing,
        contractId: secondRepairedTester.contractId,
        status: "PASS",
        headSha: secondRepairedTester.candidate?.headSha,
        diffFingerprint: secondRepairedTester.candidate?.diffFingerprint,
        owner: { threadId: "second-repaired-tester", hostId: "tester-host" },
        evidence: ["second repaired candidate passed"],
        cleanup: { status: "complete" },
        limitations: [],
      }),
    );
    run(fixture, ["record-test-receipt", "42", "--receipt", secondReceiptPath]);
    run(fixture, [
      "close-test",
      "42",
      "--contract-id",
      secondRepairedTester.contractId,
      "--thread-id",
      "second-repaired-tester",
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
    expect(resumed.nativeTool?.sequence).toEqual([
      "send_message_to_thread",
      "set_thread_archived",
      "accept-release-handoff",
    ]);
    expect(resumed.prompt).toContain("repeat the acceptance gate and re-archive the builder");
  });
});
