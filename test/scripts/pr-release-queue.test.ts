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
    items: Record<string, { state: string; terminalReceipts: unknown[] }>;
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
  return {
    root,
    statePath,
    env: {
      ...process.env,
      OPENCLAW_PR_RELEASE_QUEUE_LOCAL_STATE: statePath,
      OPENCLAW_PR_RELEASE_QUEUE_NOW: "2026-08-05T00:00:00.000Z",
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
        headSha,
        diffFingerprint,
        closure: "archived",
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
  it("migrates the current schema-1 receipt and derives dogfood progress", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 1354);
    finishMerge(fixture, 1354);
    const legacy = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
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
