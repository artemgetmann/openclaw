import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "pr-release-queue.mjs");

type CommandOutput = {
  action: string;
  lease?: { leaseId: string; fence: number; claimedPr: number };
  item?: { pr: number; ready: boolean; blockers: unknown[]; overlaps: unknown[] };
  items?: Array<{ pr: number; ready: boolean; blockers: unknown[]; overlaps: unknown[] }>;
  state?: {
    sequence: number;
    mergeLease: null | { leaseId: string; fence: number; claimedPr: number };
    items: Record<
      string,
      { state: string; terminalReceipts: unknown[]; ownershipReceipt?: Record<string, unknown> }
    >;
  };
  rollout?: {
    phase: string;
    successfulPrs: number[];
    successfulCount: number;
    remaining: number;
    pausedReason: string | null;
    newlyGraduated?: boolean;
  };
};

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pr-release-queue-"));
  const statePath = path.join(root, "queue.json");
  const gh = path.join(root, "fake-gh.mjs");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.TEST_GH_FAIL === "1") {
  process.stderr.write("injected GitHub failure");
  process.exit(1);
}
const pr = args[2];
const heads = JSON.parse(process.env.TEST_PR_HEADS ?? "{}");
if (args[0] === "pr" && args[1] === "view") {
  const afterChecks = fs.existsSync(process.env.TEST_GH_CHECK_MARKER);
  const head = afterChecks && process.env.TEST_PR_HEAD_AFTER_CHECK
    ? process.env.TEST_PR_HEAD_AFTER_CHECK
    : heads[pr];
  process.stdout.write(JSON.stringify({ headRefOid: head, baseRefName: "main" }));
} else if (args[0] === "api") {
  const endpoint = args.at(-1);
  if (endpoint.includes("/protection/required_status_checks")) {
    if (process.env.TEST_LEGACY_PROTECTION === "404") {
      process.stderr.write("HTTP 404: branch protection not found");
      process.exit(1);
    }
    process.stdout.write(process.env.TEST_LEGACY_PROTECTION);
  } else if (endpoint.includes("/rules/branches/")) {
    process.stdout.write(process.env.TEST_BRANCH_RULES);
  } else if (endpoint.includes("/check-runs")) {
    fs.writeFileSync(process.env.TEST_GH_CHECK_MARKER, "queried");
    process.stdout.write(process.env.TEST_CHECK_RUN_PAGES);
  } else if (endpoint.includes("/statuses")) {
    process.stdout.write(process.env.TEST_STATUS_PAGES);
  } else {
    process.stderr.write("unexpected fake gh api endpoint: " + endpoint);
    process.exit(2);
  }
} else {
  process.stderr.write("unexpected fake gh call: " + args.join(" "));
  process.exit(2);
}
`,
  );
  fs.chmodSync(gh, 0o755);
  return {
    root,
    statePath,
    env: {
      ...process.env,
      OPENCLAW_PR_RELEASE_QUEUE_LOCAL_STATE: statePath,
      OPENCLAW_PR_RELEASE_QUEUE_GH: gh,
      OPENCLAW_PR_RELEASE_QUEUE_REPO: "artemgetmann/openclaw",
      OPENCLAW_PR_RELEASE_QUEUE_NOW: "2026-08-05T00:00:00.000Z",
      TEST_PR_HEADS: "{}",
      TEST_GH_CHECK_MARKER: path.join(root, "checks-queried"),
      TEST_LEGACY_PROTECTION: JSON.stringify({
        contexts: ["test"],
        checks: [{ context: "test", app_id: 1 }],
      }),
      TEST_BRANCH_RULES: "[]",
      TEST_CHECK_RUN_PAGES: JSON.stringify([
        {
          check_runs: [
            { name: "test", app: { id: 1 }, status: "completed", conclusion: "success" },
          ],
        },
      ]),
      TEST_STATUS_PAGES: "[[]]",
    },
  };
}

function run(
  fixture: ReturnType<typeof makeFixture>,
  args: string[],
  envOverrides: Record<string, string> = {},
) {
  const output = execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...fixture.env, ...envOverrides },
    encoding: "utf8",
  });
  return JSON.parse(output) as CommandOutput;
}

function runFailure(fixture: ReturnType<typeof makeFixture>, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: fixture.env,
    encoding: "utf8",
  });
}

function writePacket(
  fixture: ReturnType<typeof makeFixture>,
  pr: number,
  options: {
    paths?: string[];
    dependencies?: Array<{ pr: number; relation: string; reason: string }>;
    actions?: string[];
  } = {},
) {
  const headSha = pr.toString(16).padStart(40, "a").slice(-40);
  const baseSha = pr.toString(16).padStart(40, "b").slice(-40);
  const diffFingerprint = `sha256:${pr.toString(16).padStart(64, "c").slice(-64)}`;
  const heads = JSON.parse(fixture.env.TEST_PR_HEADS);
  heads[String(pr)] = headSha;
  fixture.env.TEST_PR_HEADS = JSON.stringify(heads);
  const packetPath = path.join(fixture.root, `packet-${pr}.json`);
  fs.writeFileSync(
    packetPath,
    JSON.stringify({
      schemaVersion: 1,
      candidate: {
        pr,
        url: `https://github.com/artemgetmann/openclaw/pull/${pr}`,
        headSha,
        baseBranch: "main",
        testedBaseSha: baseSha,
        diffFingerprint,
        changedPaths: options.paths ?? [`src/feature-${pr}.ts`],
      },
      builder: {
        threadId: `builder-${pr}`,
        hostId: "builder-host",
        wakeRoute: { threadId: `builder-${pr}`, hostId: "builder-host" },
      },
      testerReceipt: {
        status: "PASS",
        owner: { threadId: `tester-${pr}`, hostId: "tester-host" },
        headSha,
        diffFingerprint,
        closure: "archived",
      },
      reviewReceipt: {
        role: "code-reviewer",
        status: "PASS",
        owner: { threadId: `reviewer-${pr}`, hostId: "reviewer-host" },
        headSha,
        diffFingerprint,
        unresolvedFindings: [],
      },
      capabilityPolicy: {
        routine: "routine-release",
        escalation: "reasoning-escalation",
      },
      authority: {
        source: "builder-handoff",
        scope: `PR #${pr} source merge only`,
        allowedActions: options.actions ?? ["normal-merge"],
        constraints: ["no admin or bypass"],
      },
      lifecycle: {
        contractId: `release-contract-${pr}`,
        stateDirectory: path.join(fixture.root, "lifecycle"),
      },
      declaredDependencies: options.dependencies ?? [],
    }),
  );
  return packetPath;
}

function initAndEnqueue(
  fixture: ReturnType<typeof makeFixture>,
  pr: number,
  options: Parameters<typeof writePacket>[2] = {},
) {
  if (!fs.existsSync(fixture.statePath)) {
    run(fixture, ["init", "--transaction-id", "init"]);
  }
  const packetPath = writePacket(fixture, pr, options);
  return run(fixture, ["enqueue", "--packet", packetPath, "--transaction-id", `enqueue-${pr}`]);
}

function claim(fixture: ReturnType<typeof makeFixture>, threadId: string, pr?: number) {
  const args = [
    "claim",
    "--thread-id",
    threadId,
    "--host-id",
    "release-host",
    "--ttl-seconds",
    "1200",
    "--transaction-id",
    `claim-${threadId}`,
  ];
  if (pr) {
    args.push("--pr", String(pr));
  }
  return run(fixture, args);
}

function writeMergeReceipt(fixture: ReturnType<typeof makeFixture>, pr: number) {
  const packet = JSON.parse(fs.readFileSync(path.join(fixture.root, `packet-${pr}.json`), "utf8"));
  const receiptPath = path.join(fixture.root, `merge-${pr}.json`);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "source-merge",
      pr,
      reviewedHeadSha: packet.candidate.headSha,
      diffFingerprint: packet.candidate.diffFingerprint,
      mergeSha: pr.toString(16).padStart(40, "d").slice(-40),
      normalNonAdmin: true,
      expectedHeadProtected: true,
      landedTreeMatchesReviewed: true,
      targetAncestryProven: true,
    }),
  );
  return receiptPath;
}

function checksRecoveryArgs(fixture: ReturnType<typeof makeFixture>, pr: number) {
  const packet = JSON.parse(fs.readFileSync(path.join(fixture.root, `packet-${pr}.json`), "utf8"));
  return [
    "recover-transient-blocker",
    "--pr",
    String(pr),
    "--head-sha",
    packet.candidate.headSha,
    "--diff-fingerprint",
    packet.candidate.diffFingerprint,
    "--kind",
    "checks-pending",
  ];
}

function blockChecksPending(fixture: ReturnType<typeof makeFixture>, pr: number) {
  initAndEnqueue(fixture, pr);
  const owner = claim(fixture, `release-owner-${pr}`, pr);
  run(fixture, [
    "block",
    "--lease-id",
    owner.lease!.leaseId,
    "--fence",
    String(owner.lease!.fence),
    "--kind",
    "checks-pending",
    "--details",
    "required checks are still running",
    "--transaction-id",
    `block-${pr}`,
  ]);
}

function finishMerge(fixture: ReturnType<typeof makeFixture>, pr: number) {
  const owner = claim(fixture, `release-${pr}`, pr);
  return run(fixture, [
    "record-merge",
    "--lease-id",
    owner.lease!.leaseId,
    "--fence",
    String(owner.lease!.fence),
    "--receipt",
    writeMergeReceipt(fixture, pr),
    "--transaction-id",
    `merge-${pr}`,
  ]);
}

describe("scripts/pr-release-queue", () => {
  it("rejects packets with unresolved serious code-review findings", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init-review-gate"]);
    const packetPath = writePacket(fixture, 19);
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    packet.reviewReceipt.unresolvedFindings = [
      { severity: "critical", summary: "merge gate can be bypassed" },
    ];
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    const result = runFailure(fixture, [
      "enqueue",
      "--packet",
      packetPath,
      "--transaction-id",
      "enqueue-review-blocked",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no serious unresolved findings");
  });

  it("rejects malformed review identities and severity values", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init-malformed-review"]);
    const packetPath = writePacket(fixture, 18);
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    packet.reviewReceipt.owner.threadId = "";
    packet.reviewReceipt.unresolvedFindings = [{ severity: "HIGH", details: "not normalized" }];
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    const result = runFailure(fixture, [
      "enqueue",
      "--packet",
      packetPath,
      "--transaction-id",
      "enqueue-malformed-review",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exact-head review PASS");
  });

  it("rejects an empty tester identity in a direct queue packet", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init-empty-tester"]);
    const packetPath = writePacket(fixture, 17);
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    packet.testerReceipt.owner = { threadId: " ", hostId: "" };
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    const result = runFailure(fixture, [
      "enqueue",
      "--packet",
      packetPath,
      "--transaction-id",
      "enqueue-empty-tester",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("closed exact-candidate tester PASS");
  });

  it("migrates the current schema-1 receipt and derives dogfood progress", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 1354);
    finishMerge(fixture, 1354);
    const legacy = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    delete legacy.items["1354"].reviewReceipt;
    delete legacy.items["1354"].capabilityPolicy;
    delete legacy.rollout;
    fs.writeFileSync(fixture.statePath, JSON.stringify(legacy));

    const status = run(fixture, ["status"]);
    expect(status.rollout).toMatchObject({
      phase: "dogfood",
      successfulPrs: [1354],
      successfulCount: 1,
      remaining: 2,
    });
  });

  it("counts only complete qualifying merges once and ignores failed terminal states", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 60);
    finishMerge(fixture, 60);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    state.items["60"].terminalReceipts.push(state.items["60"].terminalReceipts[0]);
    for (const [pr, terminalState] of [
      [61, "cancelled"],
      [62, "superseded"],
      [63, "closed"],
    ] as const) {
      const packetPath = writePacket(fixture, pr);
      const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
      state.items[String(pr)] = {
        ...packet,
        state: terminalState,
        terminalReceipts: pr === 63 ? [{ kind: "source-merge", pr }] : [],
      };
    }
    state.rollout.successfulPrs = [60];
    fs.writeFileSync(fixture.statePath, JSON.stringify(state));

    expect(run(fixture, ["status"]).rollout).toMatchObject({
      phase: "dogfood",
      successfulPrs: [60],
      successfulCount: 1,
    });
  });

  it("stays dogfood at two receipts and atomically graduates on the third", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 70);
    expect(finishMerge(fixture, 70).rollout).toMatchObject({
      phase: "dogfood",
      successfulCount: 1,
      remaining: 2,
    });
    initAndEnqueue(fixture, 71);
    expect(finishMerge(fixture, 71).rollout).toMatchObject({
      phase: "dogfood",
      successfulCount: 2,
      remaining: 1,
      newlyGraduated: false,
    });
    initAndEnqueue(fixture, 72);
    const third = finishMerge(fixture, 72);
    expect(third.rollout).toMatchObject({
      phase: "graduated",
      successfulPrs: [70, 71, 72],
      successfulCount: 3,
      remaining: 0,
      newlyGraduated: true,
    });
    expect(run(fixture, ["status"]).state?.items["72"].terminalReceipts).toHaveLength(1);
  });

  it("self-heals when authoritative receipts extend a stale successful-PR cache", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 80);
    finishMerge(fixture, 80);
    initAndEnqueue(fixture, 81);
    finishMerge(fixture, 81);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    state.rollout.successfulPrs = [80];
    fs.writeFileSync(fixture.statePath, JSON.stringify(state));

    const status = run(fixture, ["status"]);
    expect(status.rollout).toMatchObject({
      phase: "dogfood",
      successfulPrs: [80, 81],
      successfulCount: 2,
      pausedReason: null,
    });
    const reconciled = run(fixture, ["reconcile-rollout", "--transaction-id", "heal-stale-cache"]);
    expect(reconciled).toMatchObject({ action: "rollout-reconciled" });
    const durable = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    expect(durable.rollout).toMatchObject({
      phase: "dogfood",
      successfulPrs: [80, 81],
      pausedReason: null,
    });

    const repeated = run(fixture, ["reconcile-rollout", "--transaction-id", "heal-stale-cache"]);
    expect(repeated).toMatchObject({
      action: "transaction-already-recorded",
      transactionId: "heal-stale-cache",
    });
    expect(JSON.parse(fs.readFileSync(fixture.statePath, "utf8"))).toEqual(durable);
  });

  it("recomputes and clears an obsolete persisted cache-mismatch pause", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 82);
    finishMerge(fixture, 82);
    initAndEnqueue(fixture, 83);
    finishMerge(fixture, 83);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    state.rollout = {
      ...state.rollout,
      phase: "paused",
      successfulPrs: [82],
      pausedReason: "cached successful PRs [82] do not match recomputed [82,83]",
    };
    fs.writeFileSync(fixture.statePath, JSON.stringify(state));

    expect(run(fixture, ["status"]).rollout).toMatchObject({
      phase: "dogfood",
      successfulPrs: [82, 83],
      pausedReason: null,
    });
    expect(
      run(fixture, ["reconcile-rollout", "--transaction-id", "clear-obsolete-pause"]),
    ).toMatchObject({ action: "rollout-reconciled", rollout: { phase: "dogfood" } });
  });

  it("keeps blocking when the cache claims success without an authoritative receipt", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 80);
    finishMerge(fixture, 80);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    state.rollout.successfulPrs = [80, 999];
    fs.writeFileSync(fixture.statePath, JSON.stringify(state));

    const status = run(fixture, ["status"]);
    expect(status.rollout?.phase).toBe("paused");
    expect(status.rollout?.pausedReason).toContain("unverified successful PRs [999]");

    expect(
      run(fixture, ["reconcile-rollout", "--transaction-id", "preserve-unsafe-cache"]),
    ).toMatchObject({ action: "rollout-paused" });
    expect(run(fixture, ["status"]).rollout).toMatchObject({
      phase: "paused",
      successfulPrs: [80],
    });
    const durable = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    expect(durable.rollout).toMatchObject({
      phase: "paused",
      successfulPrs: [80, 999],
    });
    expect(
      run(fixture, ["reconcile-rollout", "--transaction-id", "preserve-unsafe-cache-again"]),
    ).toMatchObject({ action: "rollout-paused" });
    expect(run(fixture, ["status"]).rollout?.phase).toBe("paused");
  });

  it("keeps blocking contradictory or incomplete receipt evidence", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 84);
    finishMerge(fixture, 84);
    const contradictory = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    contradictory.items["84"].terminalReceipts.push({
      ...contradictory.items["84"].terminalReceipts[0],
      mergeSha: "f".repeat(40),
    });
    fs.writeFileSync(fixture.statePath, JSON.stringify(contradictory));

    expect(run(fixture, ["status"]).rollout).toMatchObject({
      phase: "paused",
      pausedReason: "PR #84 has conflicting qualifying merge receipts",
    });

    const incompleteFixture = makeFixture();
    initAndEnqueue(incompleteFixture, 85);
    const incomplete = JSON.parse(fs.readFileSync(incompleteFixture.statePath, "utf8"));
    incomplete.items["85"].state = "closed";
    incomplete.items["85"].terminalReceipts = [
      {
        ...JSON.parse(fs.readFileSync(writeMergeReceipt(incompleteFixture, 85), "utf8")),
        expectedHeadProtected: false,
      },
    ];
    incomplete.rollout.successfulPrs = [85];
    fs.writeFileSync(incompleteFixture.statePath, JSON.stringify(incomplete));

    expect(run(incompleteFixture, ["status"]).rollout).toMatchObject({
      phase: "paused",
      successfulPrs: [],
    });
    expect(run(incompleteFixture, ["status"]).rollout?.pausedReason).toContain(
      "unverified successful PRs [85]",
    );
  });

  it("orders declared dependencies and reports path overlap without inventing an order", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 10, { paths: ["src/shared.ts", "src/first.ts"] });
    initAndEnqueue(fixture, 11, {
      paths: ["src/shared.ts", "src/second.ts"],
      dependencies: [{ pr: 10, relation: "requires", reason: "uses the new contract" }],
    });

    const explained = run(fixture, ["explain-order"]);
    expect(explained.items?.map((item) => ({ pr: item.pr, ready: item.ready }))).toEqual([
      { pr: 10, ready: true },
      { pr: 11, ready: false },
    ]);
    expect(explained.items?.[0]?.overlaps).toEqual([{ pr: 11, paths: ["src/shared.ts"] }]);
    expect(explained.items?.[1]?.blockers).toEqual([
      {
        kind: "declared-dependency",
        dependency: { pr: 10, relation: "requires", reason: "uses the new contract" },
      },
    ]);
  });

  it("allows exactly one active lease and replaces an expired owner with a higher fence", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 20);

    const first = claim(fixture, "release-one", 20);
    expect(first).toMatchObject({ action: "claimed", lease: { fence: 1, claimedPr: 20 } });

    const duplicate = run(fixture, [
      "claim",
      "--thread-id",
      "release-two",
      "--host-id",
      "release-host",
      "--pr",
      "20",
      "--transaction-id",
      "claim-release-two-blocked",
    ]);
    expect(duplicate).toMatchObject({
      action: "do-not-claim",
      reason: "active-release-owner",
      lease: { fence: 1 },
    });

    const replacement = run(
      fixture,
      [
        "claim",
        "--thread-id",
        "release-two",
        "--host-id",
        "release-host",
        "--pr",
        "20",
        "--transaction-id",
        "claim-release-two-after-expiry",
      ],
      { OPENCLAW_PR_RELEASE_QUEUE_NOW: "2026-08-05T00:21:00.000Z" },
    );
    expect(replacement).toMatchObject({ action: "claimed", lease: { fence: 2, claimedPr: 20 } });
    expect(replacement.lease?.leaseId).not.toBe(first.lease?.leaseId);

    const stale = runFailure(fixture, [
      "release",
      "--lease-id",
      first.lease!.leaseId,
      "--fence",
      "1",
      "--transaction-id",
      "stale-release",
    ]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("fencing number is stale");
  });

  it("rejects builder self-claim and records a distinct queue ownership receipt", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 21);

    const selfClaim = runFailure(fixture, [
      "claim",
      "--thread-id",
      "builder-21",
      "--host-id",
      "builder-host",
      "--pr",
      "21",
      "--transaction-id",
      "self-claim-21",
    ]);
    expect(selfClaim.status).toBe(1);
    expect(selfClaim.stderr).toContain(
      "release queue owner must differ from the exact builder identity",
    );

    const owner = claim(fixture, "release-21", 21);
    const status = run(fixture, ["status"]);
    expect(status.state?.items["21"]).toMatchObject({
      state: "claimed",
      ownershipReceipt: {
        mode: "queue-lease",
        owner: { threadId: "release-21", hostId: "release-host" },
        builder: { threadId: "builder-21", hostId: "builder-host" },
        builderSuspended: true,
        leaseId: owner.lease!.leaseId,
        fence: owner.lease!.fence,
      },
    });
  });

  it("cannot claim a legacy queued packet without the exact-head review gate", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 23);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    delete state.items["23"].reviewReceipt;
    delete state.items["23"].capabilityPolicy;
    fs.writeFileSync(fixture.statePath, JSON.stringify(state));

    const rejected = runFailure(fixture, [
      "claim",
      "--thread-id",
      "release-23",
      "--host-id",
      "release-host",
      "--pr",
      "23",
      "--transaction-id",
      "claim-unreviewed-23",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("fresh exact-head review PASS");
  });

  it("rejects merge recording when the queue ownership receipt is missing", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 22);
    const owner = claim(fixture, "release-22", 22);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    delete state.items["22"].ownershipReceipt;
    fs.writeFileSync(fixture.statePath, JSON.stringify(state));

    const rejected = runFailure(fixture, [
      "record-merge",
      "--lease-id",
      owner.lease!.leaseId,
      "--fence",
      String(owner.lease!.fence),
      "--receipt",
      writeMergeReceipt(fixture, 22),
      "--transaction-id",
      "merge-without-owner-22",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      "merge requires the active distinct-owner queue ownership receipt",
    );
  });

  it("records source-only merge proof, closes the item, and unblocks its dependent", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 30);
    initAndEnqueue(fixture, 31, {
      dependencies: [{ pr: 30, relation: "after", reason: "must consume landed schema" }],
    });
    const owner = claim(fixture, "release-owner", 30);
    const receiptPath = writeMergeReceipt(fixture, 30);

    const merged = run(fixture, [
      "record-merge",
      "--lease-id",
      owner.lease!.leaseId,
      "--fence",
      String(owner.lease!.fence),
      "--receipt",
      receiptPath,
      "--transaction-id",
      "merge-30",
    ]);
    expect(merged).toMatchObject({
      action: "merge-recorded-closed",
      pr: 30,
      mergeSha: (30).toString(16).padStart(40, "d"),
    });

    const explained = run(fixture, ["explain-order"]);
    expect(explained.items?.find((item) => item.pr === 31)).toMatchObject({ ready: true });
    const status = run(fixture, ["status"]);
    expect(status.state?.items["30"]).toMatchObject({ state: "closed" });
    expect(status.state?.mergeLease).toBeNull();
  });

  it("keeps an explicitly authorized deploy behind a delivery barrier", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 40, { actions: ["normal-merge", "deploy"] });
    initAndEnqueue(fixture, 41, {
      dependencies: [{ pr: 40, relation: "requires", reason: "uses its landed source" }],
    });
    const owner = claim(fixture, "release-owner", 40);
    const receiptPath = writeMergeReceipt(fixture, 40);

    const merged = run(fixture, [
      "record-merge",
      "--lease-id",
      owner.lease!.leaseId,
      "--fence",
      String(owner.lease!.fence),
      "--receipt",
      receiptPath,
      "--transaction-id",
      "merge-40",
    ]);
    expect(merged.action).toBe("merge-recorded-delivery-required");
    const status = run(fixture, ["status"]);
    expect(status.state?.items["40"]).toMatchObject({ state: "delivery-barrier" });
    const explained = run(fixture, ["explain-order"]);
    expect(explained.items?.find((item) => item.pr === 41)).toMatchObject({ ready: true });
  });

  it("accepts a newly tested candidate from the same builder after source return", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 45);
    const owner = claim(fixture, "release-owner", 45);
    run(fixture, [
      "block",
      "--lease-id",
      owner.lease!.leaseId,
      "--fence",
      String(owner.lease!.fence),
      "--kind",
      "base-drift",
      "--details",
      "main advanced",
      "--transaction-id",
      "block-45",
    ]);

    const repairedPacketPath = writePacket(fixture, 45);
    const repairedPacket = JSON.parse(fs.readFileSync(repairedPacketPath, "utf8"));
    repairedPacket.candidate.headSha = "e".repeat(40);
    repairedPacket.candidate.testedBaseSha = "f".repeat(40);
    repairedPacket.candidate.diffFingerprint = `sha256:${"1".repeat(64)}`;
    repairedPacket.testerReceipt.headSha = repairedPacket.candidate.headSha;
    repairedPacket.testerReceipt.diffFingerprint = repairedPacket.candidate.diffFingerprint;
    repairedPacket.reviewReceipt.headSha = repairedPacket.candidate.headSha;
    repairedPacket.reviewReceipt.diffFingerprint = repairedPacket.candidate.diffFingerprint;
    fs.writeFileSync(repairedPacketPath, JSON.stringify(repairedPacket));

    const refreshed = run(fixture, [
      "refresh",
      "--packet",
      repairedPacketPath,
      "--transaction-id",
      "refresh-45",
    ]);
    expect(refreshed).toMatchObject({ action: "candidate-refreshed", pr: 45 });

    const status = run(fixture, ["status"]);
    expect(status.state?.items["45"]).toMatchObject({ state: "queued" });
    expect(claim(fixture, "replacement-owner", 45)).toMatchObject({
      action: "claimed",
      lease: { claimedPr: 45, fence: 2 },
    });
  });

  it("recovers an unchanged candidate after authoritative required-check evidence", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 46);

    const recovered = run(fixture, [
      ...checksRecoveryArgs(fixture, 46),
      "--transaction-id",
      "recover-checks-46",
    ]);
    expect(recovered).toMatchObject({
      action: "transient-blocker-recovered",
      pr: 46,
      recovery: {
        blocker: { kind: "checks-pending" },
        receipt: {
          source: "github-live-required-checks",
          repository: "artemgetmann/openclaw",
          requiredChecks: [
            {
              context: "test",
              appId: 1,
              source: "branch-protection",
              observed: {
                kind: "check-run",
                appId: 1,
                status: "completed",
                conclusion: "success",
              },
            },
          ],
        },
      },
    });
    expect(run(fixture, ["explain-order"]).items?.find((item) => item.pr === 46)).toMatchObject({
      state: "queued",
      ready: true,
      blockers: [],
    });
    expect(claim(fixture, "replacement-owner-46", 46)).toMatchObject({
      action: "claimed",
      lease: { claimedPr: 46, fence: 2 },
    });
  });

  it("makes transient recovery replay-safe by transaction and durable receipt", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 47);
    const args = [...checksRecoveryArgs(fixture, 47), "--transaction-id"];

    expect(run(fixture, [...args, "recover-checks-47"])).toMatchObject({
      action: "transient-blocker-recovered",
    });
    fixture.env.TEST_GH_FAIL = "1";
    expect(run(fixture, [...args, "recover-checks-47"])).toMatchObject({
      action: "transaction-already-recorded",
      transactionId: "recover-checks-47",
    });
    expect(run(fixture, [...args, "recover-checks-47-reconciled"])).toMatchObject({
      action: "transient-blocker-already-recovered",
      recovery: { receipt: { source: "github-live-required-checks" } },
    });
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    expect(state.items["47"].blockerRecoveryHistory).toHaveLength(1);
  });

  it("refuses transient recovery while any release lease is active", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 48);
    initAndEnqueue(fixture, 49);
    claim(fixture, "release-owner-49", 49);

    const rejected = runFailure(fixture, [
      ...checksRecoveryArgs(fixture, 48),
      "--transaction-id",
      "recover-checks-48",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("refuses while a release lease is active");
  });

  it("refuses transient recovery when immutable candidate identity mismatches", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 51);
    const args = checksRecoveryArgs(fixture, 51);
    const headIndex = args.indexOf("--head-sha") + 1;
    args[headIndex] = "f".repeat(40);

    const rejected = runFailure(fixture, [...args, "--transaction-id", "recover-checks-51"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("does not match the immutable queue candidate");
  });

  it("rejects forged receipts instead of trusting caller-authored check results", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 57);
    const forgedReceipt = path.join(fixture.root, "forged-recovery.json");
    fs.writeFileSync(
      forgedReceipt,
      JSON.stringify({ allRequiredChecksPassed: true, requiredChecks: [{ name: "fake" }] }),
    );

    const rejected = runFailure(fixture, [
      ...checksRecoveryArgs(fixture, 57),
      "--receipt",
      forgedReceipt,
      "--transaction-id",
      "forged-recovery-57",
    ]);
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("recovery evidence is read live from GitHub");
  });

  it("refuses a configured required check that never started and is absent from observations", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 58);
    fixture.env.TEST_LEGACY_PROTECTION = JSON.stringify({
      contexts: ["test", "never-started"],
      checks: [
        { context: "test", app_id: 1 },
        { context: "never-started", app_id: 2 },
      ],
    });

    const rejected = runFailure(fixture, [
      ...checksRecoveryArgs(fixture, 58),
      "--transaction-id",
      "recover-missing-58",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      "required check never-started (app 2) is not passing: missing",
    );
  });

  it("enumerates applicable ruleset checks with their required app identity", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 59);
    fixture.env.TEST_LEGACY_PROTECTION = "404";
    fixture.env.TEST_BRANCH_RULES = JSON.stringify([
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ruleset-ci", integration_id: 7 }] },
      },
    ]);
    fixture.env.TEST_CHECK_RUN_PAGES = JSON.stringify([
      {
        check_runs: [
          { name: "ruleset-ci", app: { id: 7 }, status: "completed", conclusion: "success" },
        ],
      },
    ]);

    const recovered = run(fixture, [
      ...checksRecoveryArgs(fixture, 59),
      "--transaction-id",
      "recover-ruleset-59",
    ]);
    expect(recovered).toMatchObject({
      action: "transient-blocker-recovered",
      recovery: {
        receipt: {
          requiredChecks: [{ context: "ruleset-ci", appId: 7, source: "ruleset" }],
        },
      },
    });
  });

  it("refuses missing, malformed, pending, failing, app-mismatched, or unsupported policies", () => {
    const cases = [
      {
        pr: 60,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_LEGACY_PROTECTION = "404";
        },
        expected: "did not report any configured required checks",
      },
      {
        pr: 61,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_LEGACY_PROTECTION = JSON.stringify({ contexts: ["test"] });
        },
        expected: "branch-protection checks are malformed",
      },
      {
        pr: 67,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_CHECK_RUN_PAGES = JSON.stringify([
            { check_runs: [{ name: "test", app: { id: 1 }, status: "in_progress" }] },
          ]);
        },
        expected: "is not passing: in_progress/unknown",
      },
      {
        pr: 68,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_CHECK_RUN_PAGES = JSON.stringify([
            {
              check_runs: [
                { name: "test", app: { id: 1 }, status: "completed", conclusion: "failure" },
              ],
            },
          ]);
        },
        expected: "is not passing: completed/failure",
      },
      {
        pr: 69,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_CHECK_RUN_PAGES = JSON.stringify([
            {
              check_runs: [
                { name: "test", app: { id: 99 }, status: "completed", conclusion: "success" },
              ],
            },
          ]);
        },
        expected: "required check test (app 1) is not passing: missing",
      },
      {
        pr: 73,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_BRANCH_RULES = JSON.stringify([{ type: "workflows", parameters: {} }]);
        },
        expected: "required-workflow rules are unsupported",
      },
      {
        pr: 74,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_LEGACY_PROTECTION = "404";
          fixture.env.TEST_BRANCH_RULES = JSON.stringify([
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "ambiguous" }] },
            },
          ]);
        },
        expected: "ruleset check identity is ambiguous",
      },
    ];
    for (const { pr, configure, expected } of cases) {
      const fixture = makeFixture();
      blockChecksPending(fixture, pr);
      configure(fixture);
      const rejected = runFailure(fixture, [
        ...checksRecoveryArgs(fixture, pr),
        "--transaction-id",
        `recover-policy-${pr}`,
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(expected);
    }
  });

  it("refuses GitHub head drift before or during live required-check verification", () => {
    for (const [pr, afterChecks] of [
      [62, false],
      [63, true],
    ] as const) {
      const fixture = makeFixture();
      blockChecksPending(fixture, pr);
      if (afterChecks) {
        fixture.env.TEST_PR_HEAD_AFTER_CHECK = "f".repeat(40);
      } else {
        const heads = JSON.parse(fixture.env.TEST_PR_HEADS);
        heads[String(pr)] = "f".repeat(40);
        fixture.env.TEST_PR_HEADS = JSON.stringify(heads);
      }
      const rejected = runFailure(fixture, [
        ...checksRecoveryArgs(fixture, pr),
        "--transaction-id",
        `recover-drift-${pr}`,
      ]);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toMatch(/candidate drifted|candidate changed/);
    }
  });

  it("refuses malformed or future blocker timestamps and future stored recovery replay", () => {
    for (const [pr, observedAt, expected] of [
      [64, "not-a-timestamp", "must be an ISO timestamp"],
      [65, "2026-08-05T00:00:01.000Z", "cannot be in the future"],
    ] as const) {
      const fixture = makeFixture();
      blockChecksPending(fixture, pr);
      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
      state.items[String(pr)].discoveredBlockers[0].observedAt = observedAt;
      fs.writeFileSync(fixture.statePath, JSON.stringify(state));
      const rejected = runFailure(fixture, [
        ...checksRecoveryArgs(fixture, pr),
        "--transaction-id",
        `recover-time-${pr}`,
      ]);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(expected);
    }

    const replayFixture = makeFixture();
    blockChecksPending(replayFixture, 66);
    run(replayFixture, [
      ...checksRecoveryArgs(replayFixture, 66),
      "--transaction-id",
      "recover-checks-66",
    ]);
    const replayState = JSON.parse(fs.readFileSync(replayFixture.statePath, "utf8"));
    replayState.items["66"].blockerRecoveryHistory[0].receipt.observedAt =
      "2026-08-05T00:00:01.000Z";
    fs.writeFileSync(replayFixture.statePath, JSON.stringify(replayState));
    const replayRejected = runFailure(replayFixture, [
      ...checksRecoveryArgs(replayFixture, 66),
      "--transaction-id",
      "recover-checks-66-replay",
    ]);
    expect(replayRejected.status).toBe(1);
    expect(replayRejected.stderr).toContain("out of order or in the future");
  });

  it("refuses recovery for decision-required and non-retryable blockers", () => {
    for (const [pr, blockerKind] of [
      [52, "decision-required"],
      [53, "base-drift"],
      [54, "lifecycle-ambiguity"],
      [55, "source-finding"],
      [56, "unknown-new-blocker"],
    ] as const) {
      const fixture = makeFixture();
      initAndEnqueue(fixture, pr);
      const owner = claim(fixture, `release-owner-${pr}`, pr);
      run(fixture, [
        "block",
        "--lease-id",
        owner.lease!.leaseId,
        "--fence",
        String(owner.lease!.fence),
        "--kind",
        blockerKind,
        "--details",
        "requires a separate repair path",
        "--transaction-id",
        `block-${pr}`,
      ]);

      const rejected = runFailure(fixture, [
        ...checksRecoveryArgs(fixture, pr),
        "--transaction-id",
        `recover-checks-${pr}`,
      ]);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toMatch(
        /not blocked by a retryable transient condition|not blocked solely by checks-pending/,
      );
    }
  });

  it("rejects stale tester identity and authority expansion", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init"]);
    const packetPath = writePacket(fixture, 50, { actions: ["normal-merge", "public-release"] });
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    packet.testerReceipt.headSha = "f".repeat(40);
    fs.writeFileSync(packetPath, JSON.stringify(packet));

    const result = runFailure(fixture, ["enqueue", "--packet", packetPath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exact-candidate tester PASS");

    packet.testerReceipt.headSha = packet.candidate.headSha;
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    const authorityResult = runFailure(fixture, ["enqueue", "--packet", packetPath]);
    expect(authorityResult.status).toBe(1);
    expect(authorityResult.stderr).toContain("optional deploy");
  });
});
