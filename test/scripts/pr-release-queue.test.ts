import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  recovery?: Record<string, unknown>;
  sourceReturnReceipt?: Record<string, unknown>;
  builder?: { threadId: string; hostId: string };
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
const bases = JSON.parse(process.env.TEST_PR_BASES ?? "{}");
const paths = JSON.parse(process.env.TEST_PR_PATHS ?? "{}");
const patches = JSON.parse(process.env.TEST_PR_PATCHES ?? "{}");
if (args[0] === "pr" && args[1] === "view") {
  const afterChecks = fs.existsSync(process.env.TEST_GH_CHECK_MARKER);
  const afterCompare = fs.existsSync(process.env.TEST_GH_COMPARE_MARKER);
  const head = afterChecks && process.env.TEST_PR_HEAD_AFTER_CHECK
    ? process.env.TEST_PR_HEAD_AFTER_CHECK
    : heads[pr];
  const base = afterCompare && process.env.TEST_PR_BASE_AFTER_COMPARE
    ? process.env.TEST_PR_BASE_AFTER_COMPARE
    : bases[pr];
  process.stdout.write(JSON.stringify({
    headRefOid: head,
    baseRefName: "main",
    baseRefOid: base,
    mergeable: process.env.TEST_PR_MERGEABLE ?? "MERGEABLE",
    files: (paths[pr] ?? []).map((path) => ({ path })),
  }));
} else if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write(patches[pr] ?? "");
} else if (args[0] === "api") {
  const endpoint = args.at(-1);
  if (endpoint.includes("/compare/")) {
    fs.writeFileSync(process.env.TEST_GH_COMPARE_MARKER, "queried");
    process.stdout.write(process.env.TEST_BASE_COMPARISON);
  } else if (endpoint.includes("/protection/required_status_checks")) {
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
      TEST_PR_BASES: "{}",
      TEST_PR_PATHS: "{}",
      TEST_PR_PATCHES: "{}",
      TEST_GH_CHECK_MARKER: path.join(root, "checks-queried"),
      TEST_GH_COMPARE_MARKER: path.join(root, "compare-queried"),
      TEST_LEGACY_PROTECTION: JSON.stringify({
        contexts: ["test"],
        checks: [{ context: "test", app_id: 1 }],
      }),
      TEST_BRANCH_RULES: "[[]]",
      TEST_CHECK_RUN_PAGES: JSON.stringify([
        {
          check_runs: [
            { name: "test", app: { id: 1 }, status: "completed", conclusion: "success" },
          ],
        },
      ]),
      TEST_STATUS_PAGES: "[[]]",
      TEST_BASE_COMPARISON: "{}",
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
    jarvisDeliveryBoundary?: unknown;
    title?: string;
    prContract?: string;
  } = {},
) {
  const headSha = pr.toString(16).padStart(40, "a").slice(-40);
  const baseSha = pr.toString(16).padStart(40, "b").slice(-40);
  const changedPaths = options.paths ?? [`src/feature-${pr}.ts`];
  const patch = `diff --git a/${changedPaths[0]} b/${changedPaths[0]}\n+feature ${pr}\n`;
  const diffFingerprint = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
  const heads = JSON.parse(fixture.env.TEST_PR_HEADS);
  heads[String(pr)] = headSha;
  fixture.env.TEST_PR_HEADS = JSON.stringify(heads);
  const bases = JSON.parse(fixture.env.TEST_PR_BASES);
  bases[String(pr)] = baseSha;
  fixture.env.TEST_PR_BASES = JSON.stringify(bases);
  const paths = JSON.parse(fixture.env.TEST_PR_PATHS);
  paths[String(pr)] = changedPaths;
  fixture.env.TEST_PR_PATHS = JSON.stringify(paths);
  const patches = JSON.parse(fixture.env.TEST_PR_PATCHES);
  patches[String(pr)] = patch;
  fixture.env.TEST_PR_PATCHES = JSON.stringify(patches);
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
        changedPaths,
        title: options.title ?? `fix(feature): deliver PR ${pr}`,
        prContract:
          options.prContract ??
          "Observable claim + acceptance criteria: the scoped feature behaves as tested.",
        jarvisDeliveryBoundary: options.jarvisDeliveryBoundary,
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

function configureBaseDrift(
  fixture: ReturnType<typeof makeFixture>,
  pr: number,
  options: { basePaths?: string[]; currentBaseSha?: string; mergeable?: string } = {},
) {
  const packet = JSON.parse(fs.readFileSync(path.join(fixture.root, `packet-${pr}.json`), "utf8"));
  const currentBaseSha = options.currentBaseSha ?? "f".repeat(40);
  const basePaths = options.basePaths ?? ["src/unrelated.ts"];
  const bases = JSON.parse(fixture.env.TEST_PR_BASES);
  bases[String(pr)] = currentBaseSha;
  fixture.env.TEST_PR_BASES = JSON.stringify(bases);
  fixture.env.TEST_PR_MERGEABLE = options.mergeable ?? "MERGEABLE";
  fixture.env.TEST_BASE_COMPARISON = JSON.stringify({
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    merge_base_commit: { sha: packet.candidate.testedBaseSha },
    base_commit: { sha: packet.candidate.testedBaseSha },
    commits: [{ sha: currentBaseSha }],
    files: basePaths.map((filename) => ({
      filename,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: `@@ -1 +1,2 @@\n existing\n+base change in ${filename}`,
    })),
  });
  return { packet, currentBaseSha };
}

function routeBaseDrift(
  fixture: ReturnType<typeof makeFixture>,
  pr: number,
  transactionId = `route-base-drift-${pr}`,
) {
  const owner = claim(fixture, `release-drift-${pr}`, pr);
  const packet = JSON.parse(fs.readFileSync(path.join(fixture.root, `packet-${pr}.json`), "utf8"));
  return run(fixture, [
    "route-base-drift",
    "--lease-id",
    owner.lease!.leaseId,
    "--fence",
    String(owner.lease!.fence),
    "--expected-head-sha",
    packet.candidate.headSha,
    "--expected-diff-fingerprint",
    packet.candidate.diffFingerprint,
    "--transaction-id",
    transactionId,
  ]);
}

function rewriteFreshCandidate(
  fixture: ReturnType<typeof makeFixture>,
  pr: number,
  headSha: string,
  testedBaseSha: string,
) {
  const packetPath = path.join(fixture.root, `packet-${pr}.json`);
  const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
  const patch = `diff --git a/${packet.candidate.changedPaths[0]} b/${packet.candidate.changedPaths[0]}\n+fresh candidate ${headSha.slice(0, 8)}\n`;
  const diffFingerprint = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
  packet.candidate.headSha = headSha;
  packet.candidate.testedBaseSha = testedBaseSha;
  packet.candidate.diffFingerprint = diffFingerprint;
  packet.testerReceipt.headSha = headSha;
  packet.testerReceipt.diffFingerprint = diffFingerprint;
  packet.reviewReceipt.headSha = headSha;
  packet.reviewReceipt.diffFingerprint = diffFingerprint;
  fs.writeFileSync(packetPath, JSON.stringify(packet));
  const heads = JSON.parse(fixture.env.TEST_PR_HEADS);
  heads[String(pr)] = headSha;
  fixture.env.TEST_PR_HEADS = JSON.stringify(heads);
  const bases = JSON.parse(fixture.env.TEST_PR_BASES);
  bases[String(pr)] = testedBaseSha;
  fixture.env.TEST_PR_BASES = JSON.stringify(bases);
  const patches = JSON.parse(fixture.env.TEST_PR_PATCHES);
  patches[String(pr)] = patch;
  fixture.env.TEST_PR_PATCHES = JSON.stringify(patches);
  return { packetPath, packet };
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
  it("rejects a Jarvis release packet that omits the carried boundary receipt", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init"]);
    const packetPath = writePacket(fixture, 15, {
      paths: ["apps/macos/Sources/Jarvis/App.swift"],
    });

    const rejected = runFailure(fixture, ["enqueue", "--packet", packetPath]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("release packet is missing Jarvis delivery boundary");
    expect(rejected.stderr).toContain("apps/macos/Sources/Jarvis/App.swift");
  });

  it("rejects an omitted receipt when only the packet title or claim names Jarvis", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init"]);

    const titlePacket = writePacket(fixture, 17, {
      paths: ["src/agents/system-prompt.ts"],
      title: "fix(jarvis): preserve reminder behavior",
    });
    const titleRejected = runFailure(fixture, ["enqueue", "--packet", titlePacket]);
    expect(titleRejected.status).toBe(1);
    expect(titleRejected.stderr).toContain("PR title names Jarvis");

    const claimPacket = writePacket(fixture, 18, {
      paths: ["src/agents/system-prompt.ts"],
      prContract:
        "Observable claim + acceptance criteria: Jarvis preserves reminder prerequisites.",
    });
    const claimRejected = runFailure(fixture, ["enqueue", "--packet", claimPacket]);
    expect(claimRejected.status).toBe(1);
    expect(claimRejected.stderr).toContain("PR summary or acceptance names Jarvis");
  });

  it("rejects a carried Jarvis receipt with an inflated completion claim", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init"]);
    const inflatedReceipt = {
      schemaVersion: 1,
      workScope: "product-wide",
      deliveryTarget: "public-release",
      completionClaim: "consumer-delivered",
      upgradeImpact: "not-applicable",
      layers: {
        localConfiguration: {
          status: "not-applicable",
          evidence: "No personal-home mutation was used.",
        },
        source: { status: "proven", evidence: "Exact candidate source passed." },
        packagedArtifact: { status: "pending", evidence: "Package proof remains." },
        installedRuntime: { status: "pending", evidence: "Install proof remains." },
        upgradeMigration: {
          status: "not-applicable",
          evidence: "Persisted state is unaffected.",
        },
        publicRelease: { status: "pending", evidence: "Publication remains." },
        endUserBehavior: { status: "pending", evidence: "Shipped behavior remains." },
      },
    };
    const packetPath = writePacket(fixture, 16, {
      title: "fix(jarvis): publish behavior",
      prContract: `Observable claim + acceptance criteria: Jarvis ships the behavior.\n<!-- jarvis-delivery-boundary:start -->\n\`\`\`json\n${JSON.stringify(inflatedReceipt)}\n\`\`\`\n<!-- jarvis-delivery-boundary:end -->`,
      jarvisDeliveryBoundary: inflatedReceipt,
    });

    const rejected = runFailure(fixture, ["enqueue", "--packet", packetPath]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("invalid Jarvis delivery boundary");
    expect(rejected.stderr).toContain("consumer-delivered is missing proven receipts");
  });

  it("rejects a carried receipt that is detached from or differs from the PR contract", () => {
    const fixture = makeFixture();
    run(fixture, ["init", "--transaction-id", "init"]);
    const validReceipt = {
      schemaVersion: 1,
      workScope: "product-wide",
      deliveryTarget: "source",
      completionClaim: "declared-boundary-complete",
      upgradeImpact: "not-applicable",
      layers: {
        localConfiguration: { status: "not-applicable", evidence: "No personal mutation." },
        source: { status: "proven", evidence: "Exact source passed." },
        packagedArtifact: { status: "pending", evidence: "Outside source boundary." },
        installedRuntime: { status: "pending", evidence: "Outside source boundary." },
        upgradeMigration: { status: "not-applicable", evidence: "No state change." },
        publicRelease: { status: "pending", evidence: "Outside source boundary." },
        endUserBehavior: { status: "pending", evidence: "Outside source boundary." },
      },
    };
    const detachedPacket = writePacket(fixture, 19, {
      jarvisDeliveryBoundary: validReceipt,
    });
    const detached = runFailure(fixture, ["enqueue", "--packet", detachedPacket]);
    expect(detached.status).toBe(1);
    expect(detached.stderr).toContain("detached Jarvis receipt");

    const embeddedReceipt = structuredClone(validReceipt);
    embeddedReceipt.layers.source.evidence = "Different embedded evidence.";
    const mismatchPacket = writePacket(fixture, 20, {
      title: "fix(jarvis): preserve behavior",
      prContract: `Observable claim + acceptance criteria: Jarvis preserves behavior.\n<!-- jarvis-delivery-boundary:start -->\n\`\`\`json\n${JSON.stringify(embeddedReceipt)}\n\`\`\`\n<!-- jarvis-delivery-boundary:end -->`,
      jarvisDeliveryBoundary: validReceipt,
    });
    const mismatch = runFailure(fixture, ["enqueue", "--packet", mismatchPacket]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("does not match the receipt embedded in prContract");
  });

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

  it("routes benign base drift to the exact builder and accepts only its fresh exact-base packet", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 45);
    const { currentBaseSha } = configureBaseDrift(fixture, 45);
    const routed = routeBaseDrift(fixture, 45);
    expect(routed).toMatchObject({
      action: "base-drift-returned-to-builder",
      pr: 45,
      builder: { threadId: "builder-45", hostId: "builder-host" },
      recovery: {
        classification: "automatic-safe-refresh",
        status: "awaiting-builder-refresh",
        evidence: {
          currentBase: { branch: "main", sha: currentBaseSha },
          overlapPaths: [],
        },
      },
      sourceReturnReceipt: {
        role: "queue-base-drift-source-return",
        classification: "automatic-safe-refresh",
        sourceLease: { released: true },
      },
    });
    expect(run(fixture, ["status"]).state?.mergeLease).toBeNull();

    const { packetPath: repairedPacketPath } = rewriteFreshCandidate(
      fixture,
      45,
      "e".repeat(40),
      currentBaseSha,
    );
    const wrongBasePacket = JSON.parse(fs.readFileSync(repairedPacketPath, "utf8"));
    wrongBasePacket.candidate.testedBaseSha = "0".repeat(40);
    fs.writeFileSync(repairedPacketPath, JSON.stringify(wrongBasePacket));
    const mismatchedRefresh = runFailure(fixture, [
      "refresh",
      "--packet",
      repairedPacketPath,
      "--recovery-attempt-id",
      String((routed.recovery as { attemptId: string }).attemptId),
      "--transaction-id",
      "refresh-wrong-base-45",
    ]);
    expect(mismatchedRefresh.status).toBe(1);
    expect(mismatchedRefresh.stderr).toContain("exact active base-drift attempt");
    wrongBasePacket.candidate.testedBaseSha = currentBaseSha;
    fs.writeFileSync(repairedPacketPath, JSON.stringify(wrongBasePacket));

    const refreshed = run(fixture, [
      "refresh",
      "--packet",
      repairedPacketPath,
      "--recovery-attempt-id",
      String((routed.recovery as { attemptId: string }).attemptId),
      "--transaction-id",
      "refresh-45",
    ]);
    expect(refreshed).toMatchObject({ action: "candidate-refreshed", pr: 45 });

    const status = run(fixture, ["status"]);
    expect(status.state?.items["45"]).toMatchObject({
      state: "queued",
      activeBaseDriftRecovery: null,
      baseDriftRecoveryHistory: [{ status: "completed" }],
    });
    expect(claim(fixture, "replacement-owner", 45)).toMatchObject({
      action: "claimed",
      lease: { claimedPr: 45, fence: 2 },
    });
  });

  it("repeats benign drift with one durable attempt per fence and an eventual higher-fenced claim", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 75);
    const firstBase = "d".repeat(40);
    configureBaseDrift(fixture, 75, { currentBaseSha: firstBase });
    const first = routeBaseDrift(fixture, 75, "route-first-drift-75");
    rewriteFreshCandidate(fixture, 75, "e".repeat(40), firstBase);
    run(fixture, [
      "refresh",
      "--packet",
      path.join(fixture.root, "packet-75.json"),
      "--recovery-attempt-id",
      String((first.recovery as { attemptId: string }).attemptId),
      "--transaction-id",
      "refresh-first-drift-75",
    ]);

    const secondBase = "f".repeat(40);
    configureBaseDrift(fixture, 75, { currentBaseSha: secondBase });
    const second = routeBaseDrift(fixture, 75, "route-second-drift-75");
    expect(second).toMatchObject({
      action: "base-drift-returned-to-builder",
      recovery: { attemptNumber: 2, sourceLease: { fence: 2 } },
    });
    rewriteFreshCandidate(fixture, 75, "1".repeat(40), secondBase);
    run(fixture, [
      "refresh",
      "--packet",
      path.join(fixture.root, "packet-75.json"),
      "--recovery-attempt-id",
      String((second.recovery as { attemptId: string }).attemptId),
      "--transaction-id",
      "refresh-second-drift-75",
    ]);
    const eventualOwner = claim(fixture, "eventual-release-owner-75", 75);
    expect(eventualOwner).toMatchObject({
      action: "claimed",
      lease: { fence: 3, claimedPr: 75 },
    });
    expect(
      run(fixture, [
        "record-merge",
        "--lease-id",
        eventualOwner.lease!.leaseId,
        "--fence",
        String(eventualOwner.lease!.fence),
        "--receipt",
        writeMergeReceipt(fixture, 75),
        "--transaction-id",
        "eventual-expected-head-merge-75",
      ]),
    ).toMatchObject({ action: "merge-recorded-closed", pr: 75 });
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    expect(state.items["75"].baseDriftRecoveryHistory).toHaveLength(2);
  });

  it("terminates automatic churn for exact path overlap or a real merge conflict", () => {
    for (const [pr, basePaths, mergeable, classification] of [
      [76, ["src/feature-76.ts"], "MERGEABLE", "substantive-overlap"],
      [77, ["src/unrelated.ts"], "CONFLICTING", "substantive-conflict"],
    ] as const) {
      const fixture = makeFixture();
      initAndEnqueue(fixture, pr);
      configureBaseDrift(fixture, pr, { basePaths: [...basePaths], mergeable });
      const routed = routeBaseDrift(fixture, pr);
      expect(routed).toMatchObject({
        action: "base-drift-requires-semantic-resolution",
        recovery: { classification, status: "semantic-resolution-required" },
        sourceReturnReceipt: null,
      });
      expect(run(fixture, ["status"]).state?.items[String(pr)]).toMatchObject({
        state: "blocked",
        baseDriftRecoveryHistory: [{ classification }],
      });
    }
  });

  it("makes typed base-drift routing lease-fenced and replay-safe without callbacks", () => {
    const fixture = makeFixture();
    initAndEnqueue(fixture, 78);
    configureBaseDrift(fixture, 78);
    const owner = claim(fixture, "release-drift-78", 78);
    const packet = JSON.parse(fs.readFileSync(path.join(fixture.root, "packet-78.json"), "utf8"));
    const args = [
      "route-base-drift",
      "--lease-id",
      owner.lease!.leaseId,
      "--fence",
      String(owner.lease!.fence),
      "--expected-head-sha",
      packet.candidate.headSha,
      "--expected-diff-fingerprint",
      packet.candidate.diffFingerprint,
      "--transaction-id",
    ];
    expect(run(fixture, [...args, "route-drift-78"])).toMatchObject({
      action: "base-drift-returned-to-builder",
      callbackRequiredForCorrectness: false,
    });
    fixture.env.TEST_GH_FAIL = "1";
    expect(run(fixture, [...args, "route-drift-78"])).toMatchObject({
      action: "transaction-already-recorded",
    });
    expect(run(fixture, [...args, "route-drift-78-replay"])).toMatchObject({
      action: "base-drift-already-routed",
      sourceReturnReceipt: { attemptId: expect.any(String) },
    });

    const stale = runFailure(fixture, [
      ...args.slice(0, args.indexOf("--fence") + 1),
      String(owner.lease!.fence + 1),
      ...args.slice(args.indexOf("--fence") + 2, -1),
      "route-drift-78-stale",
    ]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("lease identity or fencing number is stale");
  });

  it("fails closed on incomplete or changing base comparison evidence and keeps the lease", () => {
    for (const [pr, configure, expected] of [
      [
        79,
        (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_BASE_COMPARISON = JSON.stringify({
            status: "ahead",
            ahead_by: 2,
            behind_by: 0,
            merge_base_commit: {
              sha: JSON.parse(fs.readFileSync(path.join(fixture.root, "packet-79.json"), "utf8"))
                .candidate.testedBaseSha,
            },
            base_commit: {
              sha: JSON.parse(fs.readFileSync(path.join(fixture.root, "packet-79.json"), "utf8"))
                .candidate.testedBaseSha,
            },
            commits: [{ sha: "f".repeat(40) }],
            files: [],
          });
        },
        "incomplete, non-linear, or ambiguous",
      ],
      [
        80,
        (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_PR_BASE_AFTER_COMPARE = "1".repeat(40);
        },
        "changed during base-drift classification",
      ],
    ] as const) {
      const fixture = makeFixture();
      initAndEnqueue(fixture, pr);
      configureBaseDrift(fixture, pr);
      configure(fixture);
      const owner = claim(fixture, `release-drift-${pr}`, pr);
      const packet = JSON.parse(
        fs.readFileSync(path.join(fixture.root, `packet-${pr}.json`), "utf8"),
      );
      const rejected = runFailure(fixture, [
        "route-base-drift",
        "--lease-id",
        owner.lease!.leaseId,
        "--fence",
        String(owner.lease!.fence),
        "--expected-head-sha",
        packet.candidate.headSha,
        "--expected-diff-fingerprint",
        packet.candidate.diffFingerprint,
        "--transaction-id",
        `route-ambiguous-${pr}`,
      ]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(expected);
      expect(run(fixture, ["status"]).state?.mergeLease).toMatchObject({
        leaseId: owner.lease!.leaseId,
        fence: owner.lease!.fence,
      });
    }
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
      [],
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ruleset-ci", integration_id: 7 }] },
        },
      ],
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

  it("accepts live-shaped ruleset checks with omitted integration IDs as any-app", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 70);
    fixture.env.TEST_LEGACY_PROTECTION = "404";
    fixture.env.TEST_BRANCH_RULES = JSON.stringify([
      [],
      [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "pr-required" }, { context: "actionlint" }],
          },
        },
      ],
    ]);
    fixture.env.TEST_CHECK_RUN_PAGES = JSON.stringify([
      {
        check_runs: [
          { name: "pr-required", app: { id: 11 }, status: "completed", conclusion: "success" },
          { name: "actionlint", app: { id: 12 }, status: "completed", conclusion: "success" },
        ],
      },
    ]);

    const recovered = run(fixture, [
      ...checksRecoveryArgs(fixture, 70),
      "--transaction-id",
      "recover-any-app-70",
    ]);
    expect(recovered).toMatchObject({
      action: "transient-blocker-recovered",
      recovery: {
        receipt: {
          requiredChecks: [
            { context: "actionlint", appId: null, source: "ruleset" },
            { context: "pr-required", appId: null, source: "ruleset" },
          ],
        },
      },
    });
  });

  it("keeps omitted-ID checks fail-closed when check-run and status observations conflict", () => {
    const fixture = makeFixture();
    blockChecksPending(fixture, 71);
    fixture.env.TEST_LEGACY_PROTECTION = "404";
    fixture.env.TEST_BRANCH_RULES = JSON.stringify([
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "pr-required" }] },
        },
      ],
    ]);
    fixture.env.TEST_CHECK_RUN_PAGES = JSON.stringify([
      {
        check_runs: [
          { name: "pr-required", app: { id: 11 }, status: "completed", conclusion: "success" },
        ],
      },
    ]);
    fixture.env.TEST_STATUS_PAGES = JSON.stringify([
      [{ context: "pr-required", state: "failure" }],
    ]);

    const rejected = runFailure(fixture, [
      ...checksRecoveryArgs(fixture, 71),
      "--transaction-id",
      "recover-conflict-71",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("required check pr-required (app any) is not passing");
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
          fixture.env.TEST_BRANCH_RULES = JSON.stringify([
            [],
            [{ type: "workflows", parameters: {} }],
          ]);
        },
        expected: "required-workflow rules are unsupported",
      },
      {
        pr: 74,
        configure: (fixture: ReturnType<typeof makeFixture>) => {
          fixture.env.TEST_LEGACY_PROTECTION = "404";
          fixture.env.TEST_BRANCH_RULES = JSON.stringify([
            [
              {
                type: "required_status_checks",
                parameters: {
                  required_status_checks: [
                    { context: "ambiguous", integration_id: "not-an-app-id" },
                  ],
                },
              },
            ],
          ]);
        },
        expected: "required-check configuration is ambiguous",
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
