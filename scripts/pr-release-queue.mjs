#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
  jarvisDeliverySignals,
  validateJarvisPullRequest,
} from "./lib/jarvis-delivery-boundary.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_BRANCH = "ops/release-state";
const DEFAULT_QUEUE_PATH = "queue.json";
const DEFAULT_LEASE_SECONDS = 20 * 60;
const ROLLOUT_THRESHOLD = 3;
const GH_BIN = process.env.OPENCLAW_PR_RELEASE_QUEUE_GH ?? "gh";

class QueueError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 1) {
  throw new QueueError(message, exitCode);
}

function usage() {
  process.stderr.write(`Usage:
  scripts/pr-release-queue.mjs init
  scripts/pr-release-queue.mjs status
  scripts/pr-release-queue.mjs reconcile-rollout
  scripts/pr-release-queue.mjs explain-order
  scripts/pr-release-queue.mjs enqueue --packet <FILE>
  scripts/pr-release-queue.mjs refresh --packet <FILE> [--recovery-attempt-id <ID>]
  scripts/pr-release-queue.mjs route-base-drift --lease-id <ID> --fence <NUMBER> --expected-head-sha <SHA> --expected-diff-fingerprint <SHA256>
  scripts/pr-release-queue.mjs recover-transient-blocker --pr <NUMBER> --head-sha <SHA> --diff-fingerprint <SHA256> --kind checks-pending
  scripts/pr-release-queue.mjs claim --thread-id <ID> --host-id <ID> [--pr <NUMBER>] [--ttl-seconds <SECONDS>]
  scripts/pr-release-queue.mjs heartbeat --lease-id <ID> --fence <NUMBER> [--ttl-seconds <SECONDS>]
  scripts/pr-release-queue.mjs block --lease-id <ID> --fence <NUMBER> --kind <KIND> --details <TEXT>
  scripts/pr-release-queue.mjs record-merge --lease-id <ID> --fence <NUMBER> --receipt <FILE>
  scripts/pr-release-queue.mjs release --lease-id <ID> --fence <NUMBER>

Production state lives on the GitHub branch ops/release-state. Override the
repository or branch with OPENCLAW_PR_RELEASE_QUEUE_REPO and
OPENCLAW_PR_RELEASE_QUEUE_BRANCH. Tests may use the explicitly configured local
state file OPENCLAW_PR_RELEASE_QUEUE_LOCAL_STATE.
`);
}

function parseArgs(argv) {
  if (argv.length === 0) {
    usage();
    fail("missing command", 2);
  }
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      fail(`unexpected argument: ${argument}`, 2);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`missing value for ${argument}`, 2);
    }
    const key = argument.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`--${name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`, 2);
  }
  return value.trim();
}

function parsePositiveInteger(value, label) {
  if (!/^\d+$/.test(String(value))) {
    fail(`${label} must be a positive integer`, 2);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`, 2);
  }
  return parsed;
}

function nowDate() {
  // Tests inject time so lease expiry and takeover behavior is deterministic.
  // Production deliberately uses one captured instant per command instead of
  // comparing several moving Date values during a transition.
  const configured = process.env.OPENCLAW_PR_RELEASE_QUEUE_NOW;
  const date = configured ? new Date(configured) : new Date();
  if (Number.isNaN(date.valueOf())) {
    fail("OPENCLAW_PR_RELEASE_QUEUE_NOW must be an ISO timestamp", 2);
  }
  return date;
}

function isoAfter(date, seconds) {
  return new Date(date.valueOf() + seconds * 1000).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emptyState(timestamp) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sequence: 0,
    nextFence: 1,
    mergeLease: null,
    items: {},
    rollout: {
      phase: "dogfood",
      threshold: ROLLOUT_THRESHOLD,
      successfulPrs: [],
      pausedReason: null,
      graduatedAt: null,
      graduatedByPr: null,
    },
    lastTransaction: null,
    updatedAt: timestamp,
  };
}

function qualifyingMerge(item, receipt) {
  // Schema-1 terminal receipts created before the exact-head review gate
  // landed have neither field. Preserve their already-proven rollout credit;
  // every newly enqueued or refreshed packet is validated to carry both.
  const reviewQualifies =
    (item?.reviewReceipt === undefined && item?.capabilityPolicy === undefined) ||
    (item?.reviewReceipt?.status === "PASS" &&
      item.reviewReceipt.headSha === item?.candidate?.headSha &&
      item.reviewReceipt.diffFingerprint === item?.candidate?.diffFingerprint &&
      Array.isArray(item.reviewReceipt.unresolvedFindings) &&
      !item.reviewReceipt.unresolvedFindings.some((finding) =>
        ["high", "critical"].includes(finding?.severity),
      ));
  return (
    receipt?.schemaVersion === SCHEMA_VERSION &&
    receipt?.kind === "source-merge" &&
    receipt?.pr === item?.candidate?.pr &&
    receipt?.reviewedHeadSha === item?.candidate?.headSha &&
    receipt?.diffFingerprint === item?.candidate?.diffFingerprint &&
    /^[0-9a-f]{40}$/i.test(receipt?.mergeSha ?? "") &&
    receipt?.normalNonAdmin === true &&
    receipt?.expectedHeadProtected === true &&
    receipt?.landedTreeMatchesReviewed === true &&
    receipt?.targetAncestryProven === true &&
    item?.testerReceipt?.status === "PASS" &&
    item?.testerReceipt?.headSha === item?.candidate?.headSha &&
    item?.testerReceipt?.diffFingerprint === item?.candidate?.diffFingerprint &&
    ["archived", "terminal-receipt"].includes(item?.testerReceipt?.closure) &&
    reviewQualifies &&
    typeof item?.lifecycle?.contractId === "string" &&
    item.lifecycle.contractId.length > 0 &&
    item?.authority?.allowedActions?.includes("normal-merge") &&
    ["merged", "delivery-barrier", "delivered", "closed"].includes(item?.state) &&
    Array.isArray(item?.ownerHistory) &&
    item.ownerHistory.some(
      (owner) => typeof owner?.leaseId === "string" && owner.leaseId.length > 0,
    )
  );
}

function exactReviewQualifies(item) {
  return (
    item?.reviewReceipt?.role === "code-reviewer" &&
    item.reviewReceipt.status === "PASS" &&
    item.reviewReceipt.headSha === item?.candidate?.headSha &&
    item.reviewReceipt.diffFingerprint === item?.candidate?.diffFingerprint &&
    typeof item.reviewReceipt.owner?.threadId === "string" &&
    item.reviewReceipt.owner.threadId.trim() !== "" &&
    typeof item.reviewReceipt.owner?.hostId === "string" &&
    item.reviewReceipt.owner.hostId.trim() !== "" &&
    Array.isArray(item.reviewReceipt.unresolvedFindings) &&
    item.reviewReceipt.unresolvedFindings.every(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        ["low", "medium", "high", "critical"].includes(finding.severity),
    ) &&
    !item.reviewReceipt.unresolvedFindings.some((finding) =>
      ["high", "critical"].includes(finding?.severity),
    )
  );
}

function recomputeSuccessfulPrs(state) {
  const successful = [];
  const mergeOwners = new Map();
  for (const item of Object.values(state.items)) {
    const receipts = Array.isArray(item.terminalReceipts) ? item.terminalReceipts : [];
    const qualifying = receipts.filter((receipt) => qualifyingMerge(item, receipt));
    if (qualifying.length === 0) {
      continue;
    }
    // Replayed copies of the same receipt are idempotent. Conflicting terminal
    // merge claims for one PR are ambiguous and must stop graduation.
    const identities = new Set(qualifying.map((receipt) => `${receipt.pr}:${receipt.mergeSha}`));
    if (identities.size !== 1) {
      return {
        successfulPrs: [],
        safetyFailure: `PR #${item.candidate.pr} has conflicting qualifying merge receipts`,
      };
    }
    const receipt = qualifying[0];
    const priorPr = mergeOwners.get(receipt.mergeSha);
    if (priorPr && priorPr !== receipt.pr) {
      return {
        successfulPrs: [],
        safetyFailure: `merge ${receipt.mergeSha} is claimed by PR #${priorPr} and PR #${receipt.pr}`,
      };
    }
    mergeOwners.set(receipt.mergeSha, receipt.pr);
    successful.push(receipt.pr);
  }
  return { successfulPrs: successful.toSorted((left, right) => left - right), safetyFailure: null };
}

function rolloutView(state) {
  const recomputed = recomputeSuccessfulPrs(state);
  const cached = state.rollout?.successfulPrs;
  // The cache is a derived acceleration hint, never independent merge proof.
  // Recompute every pause from current receipts so an obsolete pausedReason
  // cannot keep the queue wedged after its underlying evidence is repaired.
  let pausedReason = recomputed.safetyFailure;
  if (!pausedReason && state.rollout?.threshold && state.rollout.threshold !== ROLLOUT_THRESHOLD) {
    pausedReason = `rollout threshold ${state.rollout.threshold} does not match required ${ROLLOUT_THRESHOLD}`;
  }
  if (!pausedReason && cached !== undefined) {
    if (!Array.isArray(cached) || cached.some((pr) => !Number.isSafeInteger(pr) || pr < 1)) {
      pausedReason = "cached successful PRs are malformed";
    } else {
      // Receipts extending a cache is the ordinary stale-write case: the next
      // mutation safely rewrites the cache from those stronger receipts. A
      // cached PR with no qualifying receipt would discard positive evidence,
      // so preserve it and fail closed for an operator to investigate.
      const authoritative = new Set(recomputed.successfulPrs);
      const unverified = [...new Set(cached)]
        .filter((pr) => !authoritative.has(pr))
        .toSorted((left, right) => left - right);
      if (unverified.length > 0) {
        pausedReason = `cached successful PRs contain unverified successful PRs ${JSON.stringify(unverified)}`;
      }
    }
  }
  const count = recomputed.successfulPrs.length;
  const threshold = ROLLOUT_THRESHOLD;
  const graduated = !pausedReason && count >= threshold;
  return {
    phase: pausedReason ? "paused" : graduated ? "graduated" : "dogfood",
    threshold,
    successfulPrs: recomputed.successfulPrs,
    successfulCount: count,
    remaining: Math.max(0, threshold - count),
    pausedReason,
    graduatedAt: graduated ? (state.rollout?.graduatedAt ?? null) : null,
    graduatedByPr: graduated
      ? (state.rollout?.graduatedByPr ?? recomputed.successfulPrs.at(-1) ?? null)
      : null,
    defaultRouting: graduated ? "repo-backed" : "repo-backed-dogfood",
    rollbackRouting: "direct",
  };
}

function reconcileRollout(state, now, graduatingPr = null) {
  const view = rolloutView(state);
  const wasGraduated = state.rollout?.phase === "graduated";
  const cachedSuccessfulPrs = state.rollout?.successfulPrs;
  state.rollout = {
    phase: view.phase,
    threshold: view.threshold,
    // A pause means current evidence cannot be reconciled safely. Preserve the
    // exact cached claim that triggered it instead of erasing the discrepancy;
    // otherwise the next read could falsely appear healthy. Benign stale
    // subsets take the non-paused path and are rebuilt from receipt truth.
    successfulPrs:
      view.phase === "paused" && cachedSuccessfulPrs !== undefined
        ? cachedSuccessfulPrs
        : view.successfulPrs,
    pausedReason: view.pausedReason,
    graduatedAt:
      view.phase === "graduated" ? (state.rollout?.graduatedAt ?? now.toISOString()) : null,
    graduatedByPr:
      view.phase === "graduated"
        ? (state.rollout?.graduatedByPr ?? graduatingPr ?? view.successfulPrs.at(-1) ?? null)
        : null,
  };
  return {
    ...view,
    graduatedAt: state.rollout.graduatedAt,
    graduatedByPr: state.rollout.graduatedByPr,
    newlyGraduated: !wasGraduated && view.phase === "graduated",
  };
}

function assertState(state) {
  if (
    state?.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(state.sequence) ||
    !Number.isSafeInteger(state.nextFence) ||
    state.nextFence < 1 ||
    typeof state.items !== "object" ||
    state.items === null ||
    Array.isArray(state.items)
  ) {
    fail("release queue state is missing or incompatible");
  }
  return state;
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function assertNonEmptyStrings(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    fail(`${label} must contain only non-empty strings`);
  }
}

function validatePacket(packet) {
  const candidate = packet?.candidate;
  const builder = packet?.builder;
  const tester = packet?.testerReceipt;
  const review = packet?.reviewReceipt;
  const authority = packet?.authority;
  const lifecycle = packet?.lifecycle;
  const dependencies = packet?.declaredDependencies ?? [];
  if (
    packet?.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate?.pr) ||
    candidate.pr <= 0 ||
    typeof candidate?.url !== "string" ||
    typeof candidate?.title !== "string" ||
    candidate.title.trim() === "" ||
    typeof candidate?.prContract !== "string" ||
    candidate.prContract.trim() === "" ||
    !/^[0-9a-f]{40}$/i.test(candidate?.headSha ?? "") ||
    typeof candidate?.baseBranch !== "string" ||
    !/^[0-9a-f]{40}$/i.test(candidate?.testedBaseSha ?? "") ||
    !/^sha256:[0-9a-f]{64}$/i.test(candidate?.diffFingerprint ?? "")
  ) {
    fail("release packet candidate must bind PR, URL, exact head/base, and SHA-256 diff");
  }
  assertNonEmptyStrings(candidate.changedPaths, "candidate.changedPaths");
  // Recompute every classification signal from packet-carried PR metadata.
  // Release packets are independently writable, so checking changed paths
  // alone would lose Jarvis mentions from a generic engine PR's title/body.
  const jarvisSignals = jarvisDeliverySignals({
    title: candidate.title,
    body: candidate.prContract,
    changedPaths: candidate.changedPaths,
  });
  if (jarvisSignals.length > 0 && candidate.jarvisDeliveryBoundary == null) {
    fail(`release packet is missing Jarvis delivery boundary: ${jarvisSignals.join("; ")}`);
  }
  // Validate the receipt embedded in the carried PR contract, then bind the
  // duplicate structured field to that exact value. Otherwise an independently
  // writable packet could attach valid proof while its claimed PR body omits or
  // contradicts it.
  const deliveryBoundary = validateJarvisPullRequest(
    {
      title: candidate.title,
      body: candidate.prContract,
      changedPaths: candidate.changedPaths,
    },
    { stage: "handoff" },
  );
  if (!deliveryBoundary.ok) {
    fail(
      `release packet has invalid Jarvis delivery boundary: ${deliveryBoundary.errors.join("; ")}`,
    );
  }
  if (
    deliveryBoundary.required &&
    !isDeepStrictEqual(candidate.jarvisDeliveryBoundary, deliveryBoundary.receipt)
  ) {
    fail("release packet Jarvis receipt does not match the receipt embedded in prContract");
  }
  if (!deliveryBoundary.required && candidate.jarvisDeliveryBoundary != null) {
    fail("release packet cannot carry a detached Jarvis receipt for an unclassified PR contract");
  }
  if (
    typeof builder?.threadId !== "string" ||
    typeof builder?.hostId !== "string" ||
    builder.threadId === "" ||
    builder.hostId === "" ||
    typeof builder?.wakeRoute?.threadId !== "string" ||
    typeof builder?.wakeRoute?.hostId !== "string"
  ) {
    fail("release packet requires the exact builder and non-secret wake route");
  }
  if (
    tester?.status !== "PASS" ||
    typeof tester?.owner?.threadId !== "string" ||
    tester.owner.threadId.trim() === "" ||
    typeof tester?.owner?.hostId !== "string" ||
    tester.owner.hostId.trim() === "" ||
    (tester.owner.threadId === builder.threadId && tester.owner.hostId === builder.hostId) ||
    tester?.headSha !== candidate.headSha ||
    tester?.diffFingerprint !== candidate.diffFingerprint ||
    !["archived", "terminal-receipt"].includes(tester?.closure)
  ) {
    fail("release packet requires a closed exact-candidate tester PASS");
  }
  if (
    review?.role !== "code-reviewer" ||
    review?.status !== "PASS" ||
    typeof review?.owner?.threadId !== "string" ||
    review.owner.threadId.trim() === "" ||
    typeof review?.owner?.hostId !== "string" ||
    review.owner.hostId.trim() === "" ||
    (review.owner.threadId === builder.threadId && review.owner.hostId === builder.hostId) ||
    review?.headSha !== candidate.headSha ||
    review?.diffFingerprint !== candidate.diffFingerprint ||
    !Array.isArray(review?.unresolvedFindings) ||
    !review.unresolvedFindings.every(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        ["low", "medium", "high", "critical"].includes(finding.severity),
    ) ||
    review.unresolvedFindings.some((finding) => ["high", "critical"].includes(finding?.severity))
  ) {
    fail("release packet requires an exact-head review PASS with no serious unresolved findings");
  }
  if (
    packet?.capabilityPolicy?.routine !== "routine-release" ||
    packet?.capabilityPolicy?.escalation !== "reasoning-escalation"
  ) {
    fail("release packet requires the capability-tier execution policy");
  }
  if (
    !Array.isArray(authority?.allowedActions) ||
    authority.allowedActions.length === 0 ||
    !authority.allowedActions.includes("normal-merge") ||
    authority.allowedActions.some((action) => !["normal-merge", "deploy"].includes(action)) ||
    typeof authority?.scope !== "string" ||
    !Array.isArray(authority?.constraints)
  ) {
    fail("release packet authority allows only normal-merge and optional deploy");
  }
  if (
    typeof lifecycle?.contractId !== "string" ||
    lifecycle.contractId.trim() === "" ||
    typeof lifecycle?.stateDirectory !== "string" ||
    !path.isAbsolute(lifecycle.stateDirectory)
  ) {
    fail("release packet requires lifecycle contract and absolute state provenance");
  }
  if (!Array.isArray(dependencies)) {
    fail("declaredDependencies must be an array");
  }
  for (const dependency of dependencies) {
    if (
      !Number.isSafeInteger(dependency?.pr) ||
      dependency.pr <= 0 ||
      !["requires", "before", "after", "incompatible"].includes(dependency?.relation) ||
      typeof dependency?.reason !== "string" ||
      dependency.reason.trim() === ""
    ) {
      fail("each declared dependency requires PR, relation, and reason");
    }
    if (dependency.pr === candidate.pr) {
      fail("a release packet cannot depend on itself");
    }
  }
  return packet;
}

function terminalState(state) {
  return ["merged", "delivered", "closed", "cancelled", "superseded"].includes(state);
}

function dependencySatisfied(state) {
  // Source dependencies care whether code landed, not whether separately
  // authorized delivery work finished. Cancelled or superseded candidates did
  // not land and therefore cannot satisfy a semantic `requires` edge.
  return ["merged", "delivery-barrier", "delivered", "closed"].includes(state);
}

function leaseIsActive(lease, now) {
  return lease !== null && new Date(lease.expiresAt).valueOf() > now.valueOf();
}

function dependencyBlockers(item, state) {
  const blockers = [];
  for (const dependency of item.declaredDependencies) {
    const target = state.items[String(dependency.pr)];
    if (dependency.relation === "requires" || dependency.relation === "after") {
      if (!target || !dependencySatisfied(target.state)) {
        blockers.push({ kind: "declared-dependency", dependency });
      }
    }
    if (dependency.relation === "incompatible" && target && !terminalState(target.state)) {
      blockers.push({ kind: "declared-incompatibility", dependency });
    }
  }

  // A packet may express "this PR must land before #X". The edge belongs to
  // the declaring packet, but it blocks X. Resolve reverse edges here so a new
  // operator does not need to normalize every packet into a second graph file.
  for (const other of Object.values(state.items)) {
    if (other.candidate.pr === item.candidate.pr || terminalState(other.state)) {
      continue;
    }
    for (const dependency of other.declaredDependencies) {
      if (dependency.pr !== item.candidate.pr) {
        continue;
      }
      if (dependency.relation === "before") {
        blockers.push({
          kind: "declared-predecessor",
          dependency: { pr: other.candidate.pr, relation: "before", reason: dependency.reason },
        });
      }
      if (dependency.relation === "incompatible") {
        blockers.push({
          kind: "declared-incompatibility",
          dependency: {
            pr: other.candidate.pr,
            relation: "incompatible",
            reason: dependency.reason,
          },
        });
      }
    }
  }
  return blockers;
}

function overlapDetails(item, state) {
  const ownPaths = new Set(item.candidate.changedPaths);
  const overlaps = [];
  for (const other of Object.values(state.items)) {
    if (other.candidate.pr === item.candidate.pr || terminalState(other.state)) {
      continue;
    }
    const paths = other.candidate.changedPaths.filter((changedPath) => ownPaths.has(changedPath));
    if (paths.length > 0) {
      overlaps.push({ pr: other.candidate.pr, paths: paths.toSorted() });
    }
  }
  return overlaps.toSorted((left, right) => left.pr - right.pr);
}

function itemReadiness(item, state) {
  const blockers = [
    ...dependencyBlockers(item, state),
    ...(Array.isArray(item.discoveredBlockers) ? item.discoveredBlockers : []),
  ];
  return {
    pr: item.candidate.pr,
    state: item.state,
    ready: item.state === "queued" && blockers.length === 0,
    blockers,
    overlaps: overlapDetails(item, state),
    readyAt: item.readyAt,
  };
}

function orderedItems(state) {
  return Object.values(state.items)
    .map((item) => itemReadiness(item, state))
    .toSorted((left, right) => {
      if (left.ready !== right.ready) {
        return left.ready ? -1 : 1;
      }
      const timeComparison = String(left.readyAt).localeCompare(String(right.readyAt));
      return timeComparison === 0 ? left.pr - right.pr : timeComparison;
    });
}

function requireLease(state, options, now) {
  const leaseId = requireOption(options, "leaseId");
  const fence = parsePositiveInteger(requireOption(options, "fence"), "--fence");
  const lease = state.mergeLease;
  if (!lease || lease.leaseId !== leaseId || lease.fence !== fence) {
    fail("lease identity or fencing number is stale");
  }
  if (!leaseIsActive(lease, now)) {
    fail("release lease expired; reconcile and claim a new fenced lease");
  }
  return lease;
}

function transition(state, transactionId, now, callback) {
  const next = structuredClone(assertState(state));
  // Every write migrates legacy schema-1 queue state and verifies that cached
  // rollout state is mechanically reproducible before changing queue truth.
  const before = reconcileRollout(next, now);
  if (before.phase === "paused") {
    const output = { action: "rollout-paused", rollout: before };
    next.sequence += 1;
    next.lastTransaction = { id: transactionId, recordedAt: now.toISOString() };
    next.updatedAt = now.toISOString();
    return { state: next, output };
  }
  const output = callback(next);
  next.sequence += 1;
  next.lastTransaction = { id: transactionId, recordedAt: now.toISOString() };
  next.updatedAt = now.toISOString();
  return { state: next, output };
}

function mutateEnqueue(state, packet, transactionId, now) {
  return transition(state, transactionId, now, (next) => {
    const key = String(packet.candidate.pr);
    const existing = next.items[key];
    if (existing && !terminalState(existing.state)) {
      if (
        existing.candidate.headSha === packet.candidate.headSha &&
        existing.candidate.diffFingerprint === packet.candidate.diffFingerprint
      ) {
        return { action: "already-enqueued", pr: packet.candidate.pr, state: existing.state };
      }
      fail(`PR #${packet.candidate.pr} already has a non-terminal queue candidate`);
    }
    next.items[key] = {
      state: "queued",
      candidate: packet.candidate,
      builder: packet.builder,
      testerReceipt: packet.testerReceipt,
      reviewReceipt: packet.reviewReceipt,
      capabilityPolicy: packet.capabilityPolicy,
      authority: packet.authority,
      lifecycle: packet.lifecycle,
      declaredDependencies: packet.declaredDependencies ?? [],
      discoveredBlockers: [],
      readyAt: now.toISOString(),
      ownerHistory: [],
      mutationIntent: null,
      candidateHistory: [],
      activeBaseDriftRecovery: null,
      baseDriftRecoveryHistory: [],
      terminalReceipts: [],
    };
    return { action: "enqueued", pr: packet.candidate.pr };
  });
}

function mutateRefresh(state, packet, options, transactionId, now) {
  return transition(state, transactionId, now, (next) => {
    const item = next.items[String(packet.candidate.pr)];
    // An unowned schema-1 packet queued before review receipts existed can be
    // replaced directly by the same builder. It cannot be claimed or merged;
    // forcing a fake release owner merely to block it would recreate the
    // native-control dependency this migration removes.
    const legacyUnreviewedQueued =
      item?.state === "queued" &&
      item.reviewReceipt === undefined &&
      item.capabilityPolicy === undefined;
    if (
      !item ||
      (!legacyUnreviewedQueued &&
        !["blocked", "awaiting-decision", "awaiting-builder-refresh"].includes(item.state))
    ) {
      fail(`PR #${packet.candidate.pr} is not waiting for a repaired candidate`);
    }
    if (next.mergeLease?.claimedPr === packet.candidate.pr) {
      fail(`PR #${packet.candidate.pr} still has an active release lease`);
    }
    if (
      item.builder.threadId !== packet.builder.threadId ||
      item.builder.hostId !== packet.builder.hostId
    ) {
      fail("refreshed packet must come from the same builder identity");
    }
    if (
      item.candidate.headSha === packet.candidate.headSha &&
      item.candidate.diffFingerprint === packet.candidate.diffFingerprint
    ) {
      fail("refreshed packet must bind a new candidate head or diff");
    }

    let activeRecovery = item.activeBaseDriftRecovery ?? null;
    if (item.state === "awaiting-builder-refresh") {
      const recoveryAttemptId = requireOption(options, "recoveryAttemptId");
      if (
        activeRecovery?.attemptId !== recoveryAttemptId ||
        activeRecovery?.classification !== "automatic-safe-refresh" ||
        activeRecovery?.status !== "awaiting-builder-refresh" ||
        !/^[0-9a-f]{40}$/i.test(activeRecovery?.evidence?.currentBase?.sha ?? "") ||
        typeof activeRecovery?.sourceLease?.leaseId !== "string" ||
        !Number.isSafeInteger(activeRecovery?.sourceLease?.fence) ||
        packet.lifecycle.contractId !== activeRecovery?.lifecycle?.contractId ||
        packet.lifecycle.stateDirectory !== activeRecovery?.lifecycle?.stateDirectory
      ) {
        fail(
          "refreshed packet must close the exact active base-drift attempt on its observed base and lifecycle",
        );
      }
      const onlyActiveDriftBlocker =
        Array.isArray(item.discoveredBlockers) &&
        item.discoveredBlockers.length === 1 &&
        item.discoveredBlockers[0]?.kind === "base-drift" &&
        item.discoveredBlockers[0]?.attemptId === activeRecovery.attemptId;
      if (!onlyActiveDriftBlocker || dependencyBlockers(item, next).length > 0) {
        fail("base-drift refresh refuses mixed or newly active semantic blockers");
      }
      if (packet.candidate.testedBaseSha !== activeRecovery.evidence?.currentBase?.sha) {
        // Main may advance while the exact builder is rebasing or re-proving.
        // Classify only that additional base delta against the fresh packet;
        // ambiguity leaves the old attempt retryable, while semantic overlap
        // becomes a durable terminal record instead of a manual queue wedge.
        const continuedItem = {
          ...item,
          candidate: {
            ...packet.candidate,
            testedBaseSha: activeRecovery.evidence.currentBase.sha,
          },
        };
        const livePacket = readBaseDriftCandidate(parseRepoSlug(), continuedItem);
        if (livePacket.baseSha !== packet.candidate.testedBaseSha) {
          fail(
            "refreshed packet must close the exact active base-drift attempt on the live base and lifecycle",
          );
        }
        const evidence = readLiveBaseDriftEvidence(continuedItem, now);
        if (evidence.currentBase.sha !== packet.candidate.testedBaseSha) {
          fail("fresh packet is not bound to the exact newly classified base", 75);
        }
        item.baseDriftRecoveryHistory ??= [];
        item.baseDriftRecoveryHistory.push({
          ...activeRecovery,
          status: "superseded-by-base-drift",
          supersededAt: now.toISOString(),
          supersededByBaseSha: evidence.currentBase.sha,
        });
        const continuedRecovery = makeBaseDriftRecovery(
          item,
          evidence,
          activeRecovery.sourceLease,
          transactionId,
          now,
        );
        if (continuedRecovery.classification !== "automatic-safe-refresh") {
          item.activeBaseDriftRecovery = null;
          item.baseDriftRecoveryHistory.push(continuedRecovery);
          item.state = "blocked";
          item.discoveredBlockers = [
            {
              kind: "base-drift",
              classification: continuedRecovery.classification,
              attemptId: continuedRecovery.attemptId,
              overlapPaths: evidence.overlapPaths,
              observedAt: now.toISOString(),
            },
          ];
          return {
            action: "base-drift-requires-semantic-resolution",
            pr: item.candidate.pr,
            recovery: continuedRecovery,
          };
        }
        activeRecovery = continuedRecovery;
        item.activeBaseDriftRecovery = continuedRecovery;
      }
    } else if (options.recoveryAttemptId !== undefined) {
      fail("--recovery-attempt-id is legal only for an active automatic base-drift recovery");
    }

    // Preserve the old immutable attempt and its release-time findings. The
    // repaired packet becomes a fresh queued attempt only after its own exact
    // tester PASS has already been validated by validatePacket.
    item.candidateHistory ??= [];
    item.candidateHistory.push({
      candidate: item.candidate,
      testerReceipt: item.testerReceipt,
      reviewReceipt: item.reviewReceipt,
      discoveredBlockers: item.discoveredBlockers,
      baseDriftRecovery: activeRecovery,
      replacedAt: now.toISOString(),
    });
    item.candidate = packet.candidate;
    item.builder = packet.builder;
    item.testerReceipt = packet.testerReceipt;
    item.reviewReceipt = packet.reviewReceipt;
    item.capabilityPolicy = packet.capabilityPolicy;
    item.authority = packet.authority;
    item.lifecycle = packet.lifecycle;
    item.declaredDependencies = packet.declaredDependencies ?? [];
    item.discoveredBlockers = [];
    if (activeRecovery) {
      item.baseDriftRecoveryHistory ??= [];
      item.baseDriftRecoveryHistory.push({
        ...activeRecovery,
        status: "completed",
        completedAt: now.toISOString(),
        repairedCandidate: packet.candidate,
      });
      item.activeBaseDriftRecovery = null;
    }
    item.readyAt = now.toISOString();
    item.state = "queued";
    return { action: "candidate-refreshed", pr: packet.candidate.pr };
  });
}

function parseTransientRecoveryOptions(options) {
  const pr = parsePositiveInteger(requireOption(options, "pr"), "--pr");
  const headSha = requireOption(options, "headSha");
  const diffFingerprint = requireOption(options, "diffFingerprint");
  const blockerKind = requireOption(options, "kind");
  if (options.receipt !== undefined) {
    fail("--receipt is not accepted; recovery evidence is read live from GitHub", 2);
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    fail("--head-sha must be a 40-character commit SHA", 2);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(diffFingerprint)) {
    fail("--diff-fingerprint must be a SHA-256 lifecycle fingerprint", 2);
  }
  if (blockerKind !== "checks-pending") {
    fail("only the checks-pending transient blocker is recoverable");
  }
  return { pr, headSha, diffFingerprint, blockerKind };
}

function parseStoredTimestamp(value, label) {
  if (typeof value !== "string") {
    fail(`${label} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(`${label} must be an ISO timestamp`);
  }
  return parsed.valueOf();
}

function runGhJson(args, label) {
  let output;
  try {
    output = execFileSync(GH_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Authentication, transport, and non-success check commands are all
    // indeterminate evidence. Do not copy stderr into queue output because an
    // external CLI error is not guaranteed to be secret-free.
    fail(`${label} failed; GitHub evidence is indeterminate`, 75);
  }
  if (output.trim() === "") {
    fail(`${label} returned empty evidence`, 75);
  }
  try {
    return JSON.parse(output);
  } catch {
    fail(`${label} returned malformed JSON`, 75);
  }
}

function runGhText(args, label) {
  try {
    return execFileSync(GH_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Match the JSON path's secret-silent failure boundary. External CLI
    // stderr is not durable evidence and may contain credential-adjacent text.
    fail(`${label} failed; base-drift evidence is indeterminate`, 75);
  }
}

function parseBaseDriftOptions(options) {
  const expectedHeadSha = requireOption(options, "expectedHeadSha");
  const expectedDiffFingerprint = requireOption(options, "expectedDiffFingerprint");
  if (!/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
    fail("--expected-head-sha must be a 40-character commit SHA", 2);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(expectedDiffFingerprint)) {
    fail("--expected-diff-fingerprint must be a SHA-256 lifecycle fingerprint", 2);
  }
  return { expectedHeadSha, expectedDiffFingerprint };
}

function readBaseDriftCandidate(repo, item) {
  const metadata = runGhJson(
    [
      "pr",
      "view",
      String(item.candidate.pr),
      "--repo",
      repo,
      "--json",
      "headRefOid,baseRefName,baseRefOid,mergeable,files",
    ],
    `GitHub PR #${item.candidate.pr} base-drift query`,
  );
  const changedPaths = Array.isArray(metadata?.files)
    ? metadata.files.map((file) => file?.path).toSorted()
    : null;
  if (
    !/^[0-9a-f]{40}$/i.test(metadata?.headRefOid ?? "") ||
    typeof metadata?.baseRefName !== "string" ||
    metadata.baseRefName.trim() === "" ||
    !/^[0-9a-f]{40}$/i.test(metadata?.baseRefOid ?? "") ||
    !["MERGEABLE", "CONFLICTING"].includes(metadata?.mergeable) ||
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.some((changedPath) => typeof changedPath !== "string" || changedPath === "")
  ) {
    fail(`GitHub PR #${item.candidate.pr} base-drift identity is ambiguous`, 75);
  }
  if (JSON.stringify(changedPaths) !== JSON.stringify(item.candidate.changedPaths.toSorted())) {
    fail(`GitHub PR #${item.candidate.pr} changed paths drifted from the immutable packet`);
  }
  const patch = runGhText(
    ["pr", "diff", String(item.candidate.pr), "--repo", repo, "--patch"],
    `GitHub PR #${item.candidate.pr} patch query`,
  );
  if (patch.trim() === "") {
    fail(`GitHub PR #${item.candidate.pr} returned an empty patch`);
  }
  return {
    headSha: metadata.headRefOid,
    baseBranch: metadata.baseRefName,
    baseSha: metadata.baseRefOid,
    mergeable: metadata.mergeable,
    changedPaths,
    diffFingerprint: `sha256:${sha256(patch)}`,
  };
}

function readAuthoritativeBaseHead(repo, branch) {
  // A PR's baseRefOid is a compare snapshot and can lag the branch tip even
  // while GitHub correctly reports the PR as BEHIND. Classification must bind
  // to the protected branch ref that the eventual merge will target.
  const ref = runGhJson(
    ["api", `repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`],
    `GitHub base ref ${branch}`,
  );
  const sha = ref?.object?.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha ?? "") || ref?.object?.type !== "commit") {
    fail(`GitHub base ref ${branch} is ambiguous`, 75);
  }
  return sha;
}

function readExactBaseDelta(repo, fromBaseSha, toBaseSha) {
  const comparison = runGhJson(
    ["api", `repos/${repo}/compare/${fromBaseSha}...${toBaseSha}?per_page=100`],
    `GitHub base comparison ${fromBaseSha}...${toBaseSha}`,
  );
  const commits = comparison?.commits;
  const files = comparison?.files;
  if (
    comparison?.status !== "ahead" ||
    comparison?.behind_by !== 0 ||
    !Number.isSafeInteger(comparison?.ahead_by) ||
    comparison.ahead_by <= 0 ||
    comparison?.merge_base_commit?.sha !== fromBaseSha ||
    comparison?.base_commit?.sha !== fromBaseSha ||
    !Array.isArray(commits) ||
    commits.length !== comparison.ahead_by ||
    commits.some((commit) => !/^[0-9a-f]{40}$/i.test(commit?.sha ?? "")) ||
    !Array.isArray(files) ||
    files.length === 0 ||
    // GitHub caps compare-file output at 300. Exactly hitting the cap cannot
    // prove that no path was omitted, so large drift requires human inspection.
    files.length >= 300
  ) {
    fail("GitHub base comparison is incomplete, non-linear, or ambiguous", 75);
  }

  const normalizedFiles = files
    .map((file) => ({
      filename: file?.filename,
      previousFilename: file?.previous_filename ?? null,
      status: file?.status,
      additions: file?.additions,
      deletions: file?.deletions,
      changes: file?.changes,
      patch: file?.patch,
    }))
    .toSorted((left, right) => String(left.filename).localeCompare(String(right.filename)));
  if (
    normalizedFiles.some(
      (file) =>
        typeof file.filename !== "string" ||
        file.filename === "" ||
        file.previousFilename !== null ||
        !["added", "modified", "removed"].includes(file.status) ||
        !Number.isSafeInteger(file.additions) ||
        !Number.isSafeInteger(file.deletions) ||
        !Number.isSafeInteger(file.changes) ||
        typeof file.patch !== "string" ||
        file.patch === "",
    )
  ) {
    // Renames, binaries, and patch-truncated files can hide semantic overlap.
    // They are deliberately not classified as benign from path names alone.
    fail("GitHub base comparison contains rename, binary, or incomplete diff evidence", 75);
  }
  const paths = normalizedFiles.map((file) => file.filename);
  if (new Set(paths).size !== paths.length) {
    fail("GitHub base comparison contains duplicate changed paths", 75);
  }
  const fingerprintInput = JSON.stringify({
    fromBaseSha,
    toBaseSha,
    commits: commits.map((commit) => commit.sha),
    files: normalizedFiles,
  });
  return {
    fromBaseSha,
    toBaseSha,
    commitShas: commits.map((commit) => commit.sha),
    changedPaths: paths,
    diffFingerprint: `sha256:${sha256(fingerprintInput)}`,
  };
}

function readLiveBaseDriftEvidence(item, now) {
  const repo = parseRepoSlug();
  const before = readBaseDriftCandidate(repo, item);
  if (
    before.headSha !== item.candidate.headSha ||
    before.baseBranch !== item.candidate.baseBranch ||
    before.diffFingerprint !== item.candidate.diffFingerprint
  ) {
    fail(`GitHub PR #${item.candidate.pr} candidate drifted from the immutable queue packet`);
  }
  const beforeBaseSha = readAuthoritativeBaseHead(repo, before.baseBranch);
  if (beforeBaseSha === item.candidate.testedBaseSha) {
    fail(`GitHub PR #${item.candidate.pr} base has not advanced`);
  }
  const baseDelta = readExactBaseDelta(repo, item.candidate.testedBaseSha, beforeBaseSha);
  const after = readBaseDriftCandidate(repo, item);
  const afterBaseSha = readAuthoritativeBaseHead(repo, after.baseBranch);
  if (JSON.stringify(before) !== JSON.stringify(after) || beforeBaseSha !== afterBaseSha) {
    fail(`GitHub PR #${item.candidate.pr} changed during base-drift classification`);
  }

  const candidatePaths = item.candidate.changedPaths.toSorted();
  const candidatePathSet = new Set(candidatePaths);
  const overlapPaths = baseDelta.changedPaths.filter((changedPath) =>
    candidatePathSet.has(changedPath),
  );
  const classification =
    before.mergeable === "CONFLICTING"
      ? "substantive-conflict"
      : overlapPaths.length > 0
        ? "substantive-overlap"
        : "automatic-safe-refresh";
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "github-live-base-drift",
    repository: repo,
    observedAt: now.toISOString(),
    candidate: {
      pr: item.candidate.pr,
      headSha: item.candidate.headSha,
      testedBaseSha: item.candidate.testedBaseSha,
      diffFingerprint: item.candidate.diffFingerprint,
      changedPaths: candidatePaths,
    },
    currentBase: { branch: before.baseBranch, sha: beforeBaseSha },
    baseDelta,
    overlapPaths,
    mergeable: before.mergeable,
    classification,
  };
}

function makeStandingBaseDriftAuthority(item, evidence) {
  return {
    source: "queue-base-drift-recovery",
    // The queue reclassifies every later base advance before acceptance or
    // refresh. This standing scope lets the exact builder survive benign churn
    // without authorizing it to resolve an overlap or conflict on its own.
    scope: `PR #${item.candidate.pr} source refresh from ${item.candidate.testedBaseSha} to ${evidence.currentBase.sha}`,
    allowedActions: [
      "rebase-exact-builder-worktree",
      "push-expected-old-head",
      "fresh-code-review",
      "fresh-independent-test",
      "regenerate-release-packet",
      "refresh-release-queue",
    ],
    constraints: [
      "exact builder only",
      "no conflict resolution or overlapping semantic changes",
      "no admin, bypass, deploy, runtime mutation, packaging, signing, or public release",
    ],
  };
}

function makeBaseDriftRecovery(item, evidence, sourceLease, transactionId, now) {
  const automatic = evidence.classification === "automatic-safe-refresh";
  const attemptId = randomUUID();
  const standingAuthority = automatic ? makeStandingBaseDriftAuthority(item, evidence) : null;
  const sourceReturnReceipt = automatic
    ? {
        schemaVersion: SCHEMA_VERSION,
        role: "queue-base-drift-source-return",
        status: "awaiting-builder-refresh",
        attemptId,
        candidate: evidence.candidate,
        targetBase: evidence.currentBase,
        classification: evidence.classification,
        builder: { threadId: item.builder.threadId, hostId: item.builder.hostId },
        lifecycle: item.lifecycle,
        sourceLease: {
          leaseId: sourceLease.leaseId,
          fence: sourceLease.fence,
          owner: sourceLease.owner,
          released: true,
        },
        standingAuthority,
        observedAt: now.toISOString(),
      }
    : null;
  return {
    attemptId,
    attemptNumber: (item.baseDriftRecoveryHistory?.length ?? 0) + 1,
    classification: evidence.classification,
    status: automatic ? "awaiting-builder-refresh" : "semantic-resolution-required",
    sourceLease: {
      leaseId: sourceLease.leaseId,
      fence: sourceLease.fence,
      owner: sourceLease.owner,
      releasedAt: sourceLease.releasedAt ?? now.toISOString(),
    },
    builder: item.builder,
    lifecycle: item.lifecycle,
    evidence,
    standingAuthority,
    sourceReturnReceipt,
    transactionId,
    recordedAt: now.toISOString(),
  };
}

function runGhJsonAllowNotFound(args, label) {
  try {
    const output = execFileSync(GH_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (output.trim() === "") {
      fail(`${label} returned empty evidence`, 75);
    }
    return JSON.parse(output);
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (/HTTP 404|not found/i.test(stderr)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      fail(`${label} returned malformed JSON`, 75);
    }
    fail(`${label} failed; transient blocker recovery evidence is indeterminate`, 75);
  }
}

function expectedRequiredChecks(repo, baseBranch) {
  const encodedBranch = encodeURIComponent(baseBranch);
  const legacy = runGhJsonAllowNotFound(
    ["api", `repos/${repo}/branches/${encodedBranch}/protection/required_status_checks`],
    `GitHub ${baseBranch} branch-protection query`,
  );
  const branchRulePages = runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/rules/branches/${encodedBranch}?per_page=100`],
    `GitHub ${baseBranch} active-rules query`,
  );
  if (!Array.isArray(branchRulePages) || branchRulePages.some((page) => !Array.isArray(page))) {
    fail(`GitHub ${baseBranch} active rules are malformed`, 75);
  }
  const branchRules = branchRulePages.flat();
  if (branchRules.some((rule) => /workflow/i.test(rule?.type ?? ""))) {
    fail("required-workflow rules are unsupported by transient blocker recovery");
  }

  const expected = new Map();
  const addExpected = (context, appId, source) => {
    if (
      typeof context !== "string" ||
      context.trim() === "" ||
      (appId !== null && (!Number.isSafeInteger(appId) || appId <= 0))
    ) {
      fail(`GitHub ${baseBranch} required-check configuration is ambiguous`, 75);
    }
    expected.set(`${context}\u0000${appId ?? "any"}`, { context, appId, source });
  };

  if (legacy !== null) {
    if (!Array.isArray(legacy?.contexts) || !Array.isArray(legacy?.checks)) {
      fail(`GitHub ${baseBranch} branch-protection checks are malformed`, 75);
    }
    const checkedContexts = new Set();
    for (const check of legacy.checks) {
      addExpected(check?.context, check?.app_id ?? null, "branch-protection");
      checkedContexts.add(check.context);
    }
    // `contexts` duplicates app-bound `checks` for modern configurations.
    // Only contexts absent from `checks` are independent any-app requirements.
    for (const context of legacy.contexts) {
      if (!checkedContexts.has(context)) {
        addExpected(context, null, "branch-protection");
      }
    }
  }

  for (const rule of branchRules.filter(
    (candidate) => candidate?.type === "required_status_checks",
  )) {
    const configured = rule?.parameters?.required_status_checks;
    if (!Array.isArray(configured)) {
      fail(`GitHub ${baseBranch} ruleset required checks are malformed`, 75);
    }
    for (const check of configured) {
      // GitHub omits integration_id for valid any-app ruleset checks. Preserve
      // that semantic as null; addExpected still rejects an explicitly present
      // malformed non-null app identity.
      addExpected(check?.context, check?.integration_id ?? null, "ruleset");
    }
  }
  if (expected.size === 0) {
    fail(`GitHub ${baseBranch} did not report any configured required checks`);
  }
  return [...expected.values()].toSorted((left, right) =>
    `${left.context}:${left.appId ?? "any"}`.localeCompare(
      `${right.context}:${right.appId ?? "any"}`,
    ),
  );
}

function observedExactHeadChecks(repo, headSha) {
  const checkPages = runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`],
    `GitHub ${headSha} check-runs query`,
  );
  const statusPages = runGhJson(
    ["api", "--paginate", "--slurp", `repos/${repo}/commits/${headSha}/statuses?per_page=100`],
    `GitHub ${headSha} commit-status query`,
  );
  if (!Array.isArray(checkPages) || !Array.isArray(statusPages)) {
    fail("GitHub exact-head status evidence is malformed", 75);
  }
  const checkRuns = checkPages.flatMap((page) => {
    if (!page || !Array.isArray(page.check_runs)) {
      fail("GitHub exact-head check-run page is malformed", 75);
    }
    return page.check_runs;
  });
  const statuses = statusPages.flatMap((page) => {
    if (!Array.isArray(page)) {
      fail("GitHub exact-head commit-status page is malformed", 75);
    }
    return page;
  });
  return { checkRuns, statuses };
}

function matchRequiredChecks(expected, observed) {
  const passingConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return expected.map((requirement) => {
    const checkRuns = observed.checkRuns.filter(
      (check) =>
        check?.name === requirement.context &&
        (requirement.appId === null || check?.app?.id === requirement.appId),
    );
    const statuses =
      requirement.appId === null
        ? observed.statuses.filter((status) => status?.context === requirement.context)
        : [];
    const runPasses = (check) =>
      String(check?.status).toUpperCase() === "COMPLETED" &&
      passingConclusions.has(String(check?.conclusion).toUpperCase());
    const latestRun = checkRuns[0] ?? null;
    const latestStatus = statuses[0] ?? null;
    const observations = [latestRun, latestStatus].filter(Boolean);
    // For an any-app requirement, conflicting check-run and commit-status
    // observations with the same context are ambiguous. Requiring every latest
    // visible form to pass avoids reviving an older success behind a new failure.
    const allPass = observations.every((observation) =>
      observation === latestRun
        ? runPasses(observation)
        : String(observation?.state).toUpperCase() === "SUCCESS",
    );
    if (observations.length === 0 || !allPass) {
      const state = latestRun
        ? `${latestRun.status ?? "unknown"}/${latestRun.conclusion ?? "unknown"}`
        : (latestStatus?.state ?? "missing");
      fail(
        `required check ${requirement.context} (app ${requirement.appId ?? "any"}) is not passing: ${state}`,
      );
    }
    if (latestRun && !Number.isSafeInteger(latestRun?.app?.id)) {
      fail(`required check ${requirement.context} returned an ambiguous app identity`, 75);
    }
    return {
      ...requirement,
      observed: latestRun
        ? {
            kind: "check-run",
            appId: latestRun.app.id,
            status: latestRun.status,
            conclusion: latestRun.conclusion,
          }
        : { kind: "commit-status", state: latestStatus.state },
    };
  });
}

function readLiveRequiredCheckEvidence(recovery, now) {
  const repo = parseRepoSlug();
  const readCandidate = () => {
    const metadata = runGhJson(
      ["pr", "view", String(recovery.pr), "--repo", repo, "--json", "headRefOid,baseRefName"],
      `GitHub PR #${recovery.pr} candidate query`,
    );
    if (
      !/^[0-9a-f]{40}$/i.test(metadata?.headRefOid ?? "") ||
      typeof metadata?.baseRefName !== "string" ||
      metadata.baseRefName.trim() === ""
    ) {
      fail(`GitHub PR #${recovery.pr} candidate query returned invalid identity`, 75);
    }
    return { headSha: metadata.headRefOid, baseBranch: metadata.baseRefName };
  };

  // Bracket both policy enumeration and exact-head observations. A head/base
  // change makes the full evidence set stale, including otherwise green runs.
  const candidateBefore = readCandidate();
  if (
    candidateBefore.headSha !== recovery.headSha ||
    candidateBefore.baseBranch !== recovery.baseBranch
  ) {
    fail(`GitHub PR #${recovery.pr} candidate drifted from the immutable queue candidate`);
  }
  const expected = expectedRequiredChecks(repo, recovery.baseBranch);
  const requiredChecks = matchRequiredChecks(
    expected,
    observedExactHeadChecks(repo, recovery.headSha),
  );
  const candidateAfter = readCandidate();
  if (
    candidateAfter.headSha !== recovery.headSha ||
    candidateAfter.baseBranch !== recovery.baseBranch ||
    candidateAfter.headSha !== candidateBefore.headSha ||
    candidateAfter.baseBranch !== candidateBefore.baseBranch
  ) {
    fail(`GitHub PR #${recovery.pr} candidate changed during required-check verification`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "checks-pending-recovery",
    source: "github-live-required-checks",
    repository: repo,
    candidate: {
      pr: recovery.pr,
      headSha: recovery.headSha,
      diffFingerprint: recovery.diffFingerprint,
    },
    observedAt: now.toISOString(),
    baseBranch: recovery.baseBranch,
    headShaBefore: candidateBefore.headSha,
    headShaAfter: candidateAfter.headSha,
    requiredChecks,
  };
}

function mutateRecoverTransientBlocker(state, recovery, transactionId, now) {
  return transition(state, transactionId, now, (next) => {
    const item = next.items[String(recovery.pr)];
    if (!item) {
      fail(`PR #${recovery.pr} is not enrolled in the release queue`);
    }
    if (
      item.candidate.headSha !== recovery.headSha ||
      item.candidate.diffFingerprint !== recovery.diffFingerprint
    ) {
      fail("transient blocker recovery identity does not match the immutable queue candidate");
    }
    if (leaseIsActive(next.mergeLease, now)) {
      fail("transient blocker recovery refuses while a release lease is active");
    }

    const priorRecovery = item.blockerRecoveryHistory?.at(-1);
    if (
      item.state === "queued" &&
      item.discoveredBlockers?.length === 0 &&
      priorRecovery?.blocker?.kind === recovery.blockerKind &&
      priorRecovery?.candidate?.headSha === recovery.headSha &&
      priorRecovery?.candidate?.diffFingerprint === recovery.diffFingerprint
    ) {
      const blockerObservedAt = parseStoredTimestamp(
        priorRecovery.blocker?.observedAt,
        "stored blocker observedAt",
      );
      const recoveryObservedAt = parseStoredTimestamp(
        priorRecovery.receipt?.observedAt,
        "stored recovery observedAt",
      );
      if (blockerObservedAt > recoveryObservedAt || recoveryObservedAt > now.valueOf()) {
        fail("stored recovery timestamps are out of order or in the future");
      }
      // A caller may lose the first response and retry with a new transaction.
      // Return the durable receipt without manufacturing a second recovery.
      return {
        action: "transient-blocker-already-recovered",
        pr: recovery.pr,
        recovery: priorRecovery,
      };
    }

    if (item.state !== "blocked") {
      fail(`PR #${recovery.pr} is not blocked by a retryable transient condition`);
    }

    const blockers = Array.isArray(item.discoveredBlockers) ? item.discoveredBlockers : [];
    if (blockers.length !== 1 || blockers[0]?.kind !== recovery.blockerKind) {
      // Never partially clear a mixed blocker set. Base drift, source findings,
      // decisions, lifecycle ambiguity, and unknown blockers require their own
      // authoritative repair path and usually fresh candidate proof.
      fail(
        `PR #${recovery.pr} is not blocked solely by ${recovery.blockerKind}; refusing recovery`,
      );
    }
    const blockerObservedAt = parseStoredTimestamp(blockers[0].observedAt, "blocker observedAt");
    if (blockerObservedAt > now.valueOf()) {
      fail("blocker observedAt cannot be in the future");
    }
    const receipt = readLiveRequiredCheckEvidence(
      { ...recovery, baseBranch: item.candidate.baseBranch },
      now,
    );
    const recoveryObservedAt = parseStoredTimestamp(receipt.observedAt, "recovery observedAt");
    if (blockerObservedAt > recoveryObservedAt || recoveryObservedAt > now.valueOf()) {
      fail("recovery timestamps are out of order or in the future");
    }

    const recoveryRecord = {
      candidate: {
        pr: recovery.pr,
        headSha: recovery.headSha,
        diffFingerprint: recovery.diffFingerprint,
      },
      blocker: blockers[0],
      receipt,
      transactionId,
      recoveredAt: now.toISOString(),
    };
    item.blockerRecoveryHistory ??= [];
    item.blockerRecoveryHistory.push(recoveryRecord);
    item.discoveredBlockers = [];
    item.readyAt = now.toISOString();
    item.state = "queued";
    return {
      action: "transient-blocker-recovered",
      pr: recovery.pr,
      recovery: recoveryRecord,
    };
  });
}

function mutateClaim(state, options, transactionId, now) {
  const threadId = requireOption(options, "threadId");
  const hostId = requireOption(options, "hostId");
  const ttlSeconds = parsePositiveInteger(
    options.ttlSeconds ?? String(DEFAULT_LEASE_SECONDS),
    "--ttl-seconds",
  );
  return transition(state, transactionId, now, (next) => {
    const current = next.mergeLease;
    if (leaseIsActive(current, now)) {
      if (current.owner.threadId === threadId && current.owner.hostId === hostId) {
        return { action: "lease-already-owned", lease: current };
      }
      return { action: "do-not-claim", reason: "active-release-owner", lease: current };
    }

    if (current) {
      // Lease expiry makes the task replaceable, but never silently forgets
      // which item was abandoned. Put only that exact item back into the ready
      // pool; the new owner receives a higher fencing number below.
      const abandoned = next.items[String(current.claimedPr)];
      if (abandoned?.state === "claimed") {
        abandoned.state = "queued";
        abandoned.ownerHistory.push({
          event: "lease-expired",
          leaseId: current.leaseId,
          fence: current.fence,
          observedAt: now.toISOString(),
        });
      }
      next.mergeLease = null;
    }

    const requestedPr = options.pr ? parsePositiveInteger(options.pr, "--pr") : null;
    const readiness = orderedItems(next);
    const selected = requestedPr
      ? readiness.find((entry) => entry.pr === requestedPr)
      : readiness.find((entry) => entry.ready);
    if (!selected) {
      return { action: "do-not-claim", reason: "no-queued-item" };
    }
    if (!selected.ready) {
      return { action: "do-not-claim", reason: "item-not-ready", item: selected };
    }

    const item = next.items[String(selected.pr)];
    if (!exactReviewQualifies(item)) {
      fail("release claim requires a fresh exact-head review PASS with no serious findings");
    }
    // Queue ownership must be independent from source ownership. Native task
    // creation is deliberately not required, but a builder cannot relabel
    // itself as the release executor and silently self-merge.
    if (item.builder.threadId === threadId && item.builder.hostId === hostId) {
      fail("release queue owner must differ from the exact builder identity");
    }
    const lease = {
      leaseId: randomUUID(),
      fence: next.nextFence,
      owner: { threadId, hostId },
      claimedPr: selected.pr,
      claimedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: isoAfter(now, ttlSeconds),
    };
    next.nextFence += 1;
    next.mergeLease = lease;
    item.state = "claimed";
    item.ownerHistory.push({ ...lease });
    item.ownershipReceipt = {
      mode: "queue-lease",
      owner: { threadId, hostId },
      builder: { threadId: item.builder.threadId, hostId: item.builder.hostId },
      builderSuspended: true,
      leaseId: lease.leaseId,
      fence: lease.fence,
      recordedAt: now.toISOString(),
    };
    return { action: "claimed", lease, item: selected };
  });
}

function mutateHeartbeat(state, options, transactionId, now) {
  const ttlSeconds = parsePositiveInteger(
    options.ttlSeconds ?? String(DEFAULT_LEASE_SECONDS),
    "--ttl-seconds",
  );
  return transition(state, transactionId, now, (next) => {
    const lease = requireLease(next, options, now);
    lease.heartbeatAt = now.toISOString();
    lease.expiresAt = isoAfter(now, ttlSeconds);
    return { action: "heartbeat-recorded", lease };
  });
}

function mutateRouteBaseDrift(state, options, expected, transactionId, now) {
  return transition(state, transactionId, now, (next) => {
    const requestedLeaseId = requireOption(options, "leaseId");
    const requestedFence = parsePositiveInteger(requireOption(options, "fence"), "--fence");

    // A released fence remains the credential for this one recovery chain.
    // Replaying it on an unchanged base is idempotent; replaying after another
    // base advance performs a new exact classification and supersedes the old
    // receipt instead of leaving an ownerless item wedged on a stale base.
    for (const item of Object.values(next.items)) {
      const attempts = [
        ...(Array.isArray(item.baseDriftRecoveryHistory) ? item.baseDriftRecoveryHistory : []),
        item.activeBaseDriftRecovery,
      ].filter(Boolean);
      const prior = attempts
        .toReversed()
        .find(
          (attempt) =>
            attempt?.sourceLease?.leaseId === requestedLeaseId &&
            attempt.sourceLease.fence === requestedFence,
        );
      if (
        prior &&
        prior.evidence?.candidate?.headSha === expected.expectedHeadSha &&
        prior.evidence?.candidate?.diffFingerprint === expected.expectedDiffFingerprint
      ) {
        if (prior === item.activeBaseDriftRecovery) {
          const onlyActiveDriftBlocker =
            Array.isArray(item.discoveredBlockers) &&
            item.discoveredBlockers.length === 1 &&
            item.discoveredBlockers[0]?.kind === "base-drift" &&
            item.discoveredBlockers[0]?.attemptId === prior.attemptId;
          if (!onlyActiveDriftBlocker || dependencyBlockers(item, next).length > 0) {
            fail("continued base drift refuses mixed or newly active semantic blockers");
          }
          const evidence = readLiveBaseDriftEvidence(item, now);
          if (evidence.currentBase.sha !== prior.evidence?.currentBase?.sha) {
            item.baseDriftRecoveryHistory ??= [];
            item.baseDriftRecoveryHistory.push({
              ...prior,
              status: "superseded-by-base-drift",
              supersededAt: now.toISOString(),
              supersededByBaseSha: evidence.currentBase.sha,
            });
            const recovery = makeBaseDriftRecovery(
              item,
              evidence,
              prior.sourceLease,
              transactionId,
              now,
            );
            item.activeBaseDriftRecovery = null;
            if (recovery.classification === "automatic-safe-refresh") {
              item.activeBaseDriftRecovery = recovery;
              item.state = "awaiting-builder-refresh";
              item.discoveredBlockers = [
                {
                  kind: "base-drift",
                  classification: recovery.classification,
                  attemptId: recovery.attemptId,
                  observedAt: now.toISOString(),
                },
              ];
              return {
                action: "base-drift-return-updated",
                pr: item.candidate.pr,
                recovery,
                sourceReturnReceipt: recovery.sourceReturnReceipt,
                builder: item.builder,
                callbackRequiredForCorrectness: false,
              };
            }
            item.baseDriftRecoveryHistory.push(recovery);
            item.state = "blocked";
            item.discoveredBlockers = [
              {
                kind: "base-drift",
                classification: recovery.classification,
                attemptId: recovery.attemptId,
                overlapPaths: evidence.overlapPaths,
                observedAt: now.toISOString(),
              },
            ];
            return {
              action: "base-drift-requires-semantic-resolution",
              pr: item.candidate.pr,
              recovery,
              sourceReturnReceipt: null,
            };
          }
        }
        return {
          action: "base-drift-already-routed",
          pr: item.candidate.pr,
          recovery: prior,
          sourceReturnReceipt: prior.sourceReturnReceipt ?? null,
        };
      }
    }

    const lease = requireLease(next, options, now);
    const item = next.items[String(lease.claimedPr)];
    if (
      item.candidate.headSha !== expected.expectedHeadSha ||
      item.candidate.diffFingerprint !== expected.expectedDiffFingerprint
    ) {
      fail("base-drift routing identity does not match the immutable queue candidate");
    }
    if (item.state !== "claimed") {
      fail(`PR #${item.candidate.pr} is not held by the active claimed release lease`);
    }
    if (
      !Array.isArray(item.discoveredBlockers) ||
      item.discoveredBlockers.length > 0 ||
      dependencyBlockers(item, next).length > 0
    ) {
      fail("base-drift routing refuses mixed or newly active semantic blockers");
    }
    if (item.activeBaseDriftRecovery) {
      fail(`PR #${item.candidate.pr} already has an active base-drift recovery attempt`);
    }

    const evidence = readLiveBaseDriftEvidence(item, now);
    const automatic = evidence.classification === "automatic-safe-refresh";
    const recovery = makeBaseDriftRecovery(item, evidence, lease, transactionId, now);
    const { attemptId, sourceReturnReceipt } = recovery;

    item.ownershipReceipt = null;
    next.mergeLease = null;
    if (automatic) {
      item.activeBaseDriftRecovery = recovery;
      item.state = "awaiting-builder-refresh";
      item.discoveredBlockers = [
        {
          kind: "base-drift",
          classification: evidence.classification,
          attemptId,
          observedAt: now.toISOString(),
        },
      ];
      return {
        action: "base-drift-returned-to-builder",
        pr: item.candidate.pr,
        recovery,
        sourceReturnReceipt,
        builder: item.builder,
        lifecycleTool: {
          sequence: [
            "pr-lifecycle accept-queue-source-return",
            "exact builder rebase and fresh review/test",
            "pr-release-queue refresh",
          ],
        },
        callbackRequiredForCorrectness: false,
      };
    }

    // Any real conflict or path overlap terminates automatic churn immediately.
    // The exact evidence stays auditable and a later fresh packet may still be
    // accepted after explicit semantic resolution by the same builder.
    item.baseDriftRecoveryHistory ??= [];
    item.baseDriftRecoveryHistory.push(recovery);
    item.state = "blocked";
    item.discoveredBlockers = [
      {
        kind: "base-drift",
        classification: evidence.classification,
        attemptId,
        overlapPaths: evidence.overlapPaths,
        observedAt: now.toISOString(),
      },
    ];
    return {
      action: "base-drift-requires-semantic-resolution",
      pr: item.candidate.pr,
      recovery,
      sourceReturnReceipt: null,
      builder: item.builder,
      callbackRequiredForCorrectness: false,
    };
  });
}

function mutateBlock(state, options, transactionId, now) {
  const kind = requireOption(options, "kind");
  const details = requireOption(options, "details");
  if (kind === "base-drift") {
    fail("base-drift requires the authenticated route-base-drift transition", 2);
  }
  return transition(state, transactionId, now, (next) => {
    const lease = requireLease(next, options, now);
    const item = next.items[String(lease.claimedPr)];
    item.discoveredBlockers.push({ kind, details, observedAt: now.toISOString() });
    item.state = kind === "decision-required" ? "awaiting-decision" : "blocked";
    next.mergeLease = null;
    return { action: "blocked", pr: item.candidate.pr, blocker: item.discoveredBlockers.at(-1) };
  });
}

function validateMergeReceipt(receipt, item) {
  if (
    receipt?.schemaVersion !== SCHEMA_VERSION ||
    receipt?.kind !== "source-merge" ||
    receipt?.pr !== item.candidate.pr ||
    receipt?.reviewedHeadSha !== item.candidate.headSha ||
    receipt?.diffFingerprint !== item.candidate.diffFingerprint ||
    !/^[0-9a-f]{40}$/i.test(receipt?.mergeSha ?? "") ||
    receipt?.normalNonAdmin !== true ||
    receipt?.expectedHeadProtected !== true ||
    receipt?.landedTreeMatchesReviewed !== true ||
    receipt?.targetAncestryProven !== true
  ) {
    fail(
      "merge receipt must prove exact candidate, normal expected-head merge, tree equality, and ancestry",
    );
  }
  return receipt;
}

function mutateRecordMerge(state, options, receipt, transactionId, now) {
  return transition(state, transactionId, now, (next) => {
    const lease = requireLease(next, options, now);
    const item = next.items[String(lease.claimedPr)];
    if (!exactReviewQualifies(item)) {
      fail("merge requires a fresh exact-head review PASS with no serious findings");
    }
    const ownership = item.ownershipReceipt;
    if (
      ownership?.mode !== "queue-lease" ||
      ownership?.builderSuspended !== true ||
      ownership?.leaseId !== lease.leaseId ||
      ownership?.fence !== lease.fence ||
      ownership?.owner?.threadId !== lease.owner.threadId ||
      ownership?.owner?.hostId !== lease.owner.hostId ||
      (ownership?.builder?.threadId === lease.owner.threadId &&
        ownership?.builder?.hostId === lease.owner.hostId)
    ) {
      fail("merge requires the active distinct-owner queue ownership receipt");
    }
    validateMergeReceipt(receipt, item);
    item.terminalReceipts.push(receipt);
    const deployAuthorized = item.authority.allowedActions.includes("deploy");
    item.state = deployAuthorized ? "delivery-barrier" : "closed";
    next.mergeLease = null;
    // The receipt appended above is the sole legitimate source of cache
    // growth. Refresh the cache from receipts before the generic mismatch
    // guard, which still pauses on any malformed or conflicting proof.
    const recomputed = recomputeSuccessfulPrs(next);
    if (!recomputed.safetyFailure) {
      next.rollout.successfulPrs = recomputed.successfulPrs;
    }
    const rollout = reconcileRollout(next, now, item.candidate.pr);
    return {
      action: deployAuthorized ? "merge-recorded-delivery-required" : "merge-recorded-closed",
      pr: item.candidate.pr,
      mergeSha: receipt.mergeSha,
      rollout,
    };
  });
}

function mutateRelease(state, options, transactionId, now) {
  return transition(state, transactionId, now, (next) => {
    const lease = requireLease(next, options, now);
    const item = next.items[String(lease.claimedPr)];
    if (item.state === "claimed") {
      item.state = "queued";
    }
    next.mergeLease = null;
    return { action: "released", pr: item.candidate.pr };
  });
}

function parseRepoSlug() {
  const configured = process.env.OPENCLAW_PR_RELEASE_QUEUE_REPO;
  if (configured) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured)) {
      fail("OPENCLAW_PR_RELEASE_QUEUE_REPO must be owner/repository", 2);
    }
    return configured;
  }
  let remote;
  try {
    remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail("cannot resolve origin repository; set OPENCLAW_PR_RELEASE_QUEUE_REPO");
  }
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    fail("origin is not a GitHub repository; set OPENCLAW_PR_RELEASE_QUEUE_REPO");
  }
  return `${match[1]}/${match[2]}`;
}

function runGhApi(method, endpoint, body) {
  const args = ["api", "--method", method, endpoint];
  if (body !== undefined) {
    args.push("--input", "-");
  }
  try {
    return execFileSync(GH_BIN, args, {
      encoding: "utf8",
      input: body === undefined ? undefined : JSON.stringify(body),
      stdio: [body === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new QueueError(
      `GitHub API ${method} ${endpoint} failed${stderr ? `: ${stderr}` : ""}`,
      error?.status === 1 ? 1 : 75,
    );
  }
}

function decodeBlob(blob) {
  if (blob?.encoding !== "base64" || typeof blob?.content !== "string") {
    fail("queue blob is not base64 encoded");
  }
  return Buffer.from(blob.content.replaceAll("\n", ""), "base64").toString("utf8");
}

class GitHubQueueStore {
  constructor() {
    this.repo = parseRepoSlug();
    this.branch = process.env.OPENCLAW_PR_RELEASE_QUEUE_BRANCH ?? DEFAULT_BRANCH;
    this.queuePath = DEFAULT_QUEUE_PATH;
  }

  refEndpoint() {
    return `repos/${this.repo}/git/refs/heads/${this.branch}`;
  }

  read() {
    let ref;
    try {
      ref = JSON.parse(runGhApi("GET", this.refEndpoint()));
    } catch (error) {
      if (error instanceof QueueError && /HTTP 404|not found/i.test(error.message)) {
        return null;
      }
      throw error;
    }
    const tipSha = ref?.object?.sha;
    const commit = JSON.parse(runGhApi("GET", `repos/${this.repo}/git/commits/${tipSha}`));
    const tree = JSON.parse(
      runGhApi("GET", `repos/${this.repo}/git/trees/${commit.tree.sha}?recursive=1`),
    );
    const entry = tree.tree?.find((candidate) => candidate.path === this.queuePath);
    if (!entry?.sha) {
      fail(`${this.queuePath} is missing from ${this.branch}`);
    }
    const blob = JSON.parse(runGhApi("GET", `repos/${this.repo}/git/blobs/${entry.sha}`));
    return {
      revision: tipSha,
      treeSha: commit.tree.sha,
      state: assertState(JSON.parse(decodeBlob(blob))),
    };
  }

  init(state, transactionId) {
    if (this.read()) {
      return { action: "already-initialized", branch: this.branch };
    }
    const blob = JSON.parse(
      runGhApi("POST", `repos/${this.repo}/git/blobs`, {
        content: `${JSON.stringify(state, null, 2)}\n`,
        encoding: "utf-8",
      }),
    );
    const tree = JSON.parse(
      runGhApi("POST", `repos/${this.repo}/git/trees`, {
        tree: [{ path: this.queuePath, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    );
    const commit = JSON.parse(
      runGhApi("POST", `repos/${this.repo}/git/commits`, {
        message: `chore(release-queue): initialize state\n\nTransaction: ${transactionId}`,
        tree: tree.sha,
        parents: [],
      }),
    );
    try {
      runGhApi("POST", `repos/${this.repo}/git/refs`, {
        ref: `refs/heads/${this.branch}`,
        sha: commit.sha,
      });
    } catch (error) {
      const reconciled = this.read();
      if (reconciled) {
        return { action: "initialized-by-contender", branch: this.branch };
      }
      throw error;
    }
    return { action: "initialized", branch: this.branch, revision: commit.sha };
  }

  write(snapshot, nextState, transactionId, message) {
    const blob = JSON.parse(
      runGhApi("POST", `repos/${this.repo}/git/blobs`, {
        content: `${JSON.stringify(nextState, null, 2)}\n`,
        encoding: "utf-8",
      }),
    );
    const tree = JSON.parse(
      runGhApi("POST", `repos/${this.repo}/git/trees`, {
        base_tree: snapshot.treeSha,
        tree: [{ path: this.queuePath, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    );
    const commit = JSON.parse(
      runGhApi("POST", `repos/${this.repo}/git/commits`, {
        message: `${message}\n\nTransaction: ${transactionId}`,
        tree: tree.sha,
        parents: [snapshot.revision],
      }),
    );
    try {
      runGhApi("PATCH", this.refEndpoint(), { sha: commit.sha, force: false });
      return { revision: commit.sha };
    } catch {
      // The PATCH response can be lost after GitHub accepts it. Re-read once
      // and treat the transaction marker as the idempotency receipt. Never
      // submit a second state-changing ref update from this command.
      const reconciled = this.read();
      if (reconciled?.state?.lastTransaction?.id === transactionId) {
        return { revision: reconciled.revision, reconciled: true };
      }
      fail(
        `queue update was rejected or ambiguous; current transaction is not ${transactionId}`,
        75,
      );
    }
  }
}

class LocalQueueStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    return {
      revision: fs.statSync(this.filePath).mtimeMs.toString(),
      treeSha: "local",
      state: assertState(JSON.parse(fs.readFileSync(this.filePath, "utf8"))),
    };
  }

  init(state) {
    if (this.read()) {
      return { action: "already-initialized", path: this.filePath };
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return { action: "initialized", path: this.filePath };
  }

  write(_snapshot, nextState) {
    const candidate = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(candidate, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(candidate, this.filePath);
    return { revision: fs.statSync(this.filePath).mtimeMs.toString() };
  }
}

function makeStore() {
  const local = process.env.OPENCLAW_PR_RELEASE_QUEUE_LOCAL_STATE;
  return local ? new LocalQueueStore(local) : new GitHubQueueStore();
}

function performMutation(store, transactionId, message, mutator) {
  const snapshot = store.read();
  if (!snapshot) {
    fail("release queue is not initialized; run init first");
  }
  if (snapshot.state.lastTransaction?.id === transactionId) {
    return { action: "transaction-already-recorded", transactionId, state: snapshot.state };
  }
  const result = mutator(snapshot.state);
  const writeReceipt = store.write(snapshot, result.state, transactionId, message);
  return { ...result.output, transactionId, queueRevision: writeReceipt.revision };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const store = makeStore();
  const now = nowDate();
  if (command === "init") {
    const transactionId = options.transactionId ?? randomUUID();
    const state = emptyState(now.toISOString());
    state.lastTransaction = { id: transactionId, recordedAt: now.toISOString() };
    return store.init(state, transactionId);
  }
  if (command === "status" || command === "explain-order") {
    const snapshot = store.read();
    if (!snapshot) {
      fail("release queue is not initialized; run init first");
    }
    return command === "status"
      ? {
          action: "status",
          revision: snapshot.revision,
          rollout: rolloutView(snapshot.state),
          state: snapshot.state,
        }
      : {
          action: "order-explained",
          revision: snapshot.revision,
          leaseActive: leaseIsActive(snapshot.state.mergeLease, now),
          items: orderedItems(snapshot.state),
        };
  }

  const transactionId = options.transactionId ?? randomUUID();
  switch (command) {
    case "reconcile-rollout":
      return performMutation(
        store,
        transactionId,
        "chore(release-queue): reconcile rollout state",
        (state) =>
          transition(state, transactionId, now, (next) => ({
            action: "rollout-reconciled",
            rollout: reconcileRollout(next, now),
          })),
      );
    case "enqueue": {
      const packet = validatePacket(
        readJsonFile(requireOption(options, "packet"), "release packet"),
      );
      return performMutation(
        store,
        transactionId,
        `chore(release-queue): enqueue PR #${packet.candidate.pr}`,
        (state) => mutateEnqueue(state, packet, transactionId, now),
      );
    }
    case "refresh": {
      const packet = validatePacket(
        readJsonFile(requireOption(options, "packet"), "release packet"),
      );
      return performMutation(
        store,
        transactionId,
        `chore(release-queue): refresh PR #${packet.candidate.pr}`,
        (state) => mutateRefresh(state, packet, options, transactionId, now),
      );
    }
    case "route-base-drift": {
      const expected = parseBaseDriftOptions(options);
      return performMutation(
        store,
        transactionId,
        "chore(release-queue): route typed base drift",
        (state) => mutateRouteBaseDrift(state, options, expected, transactionId, now),
      );
    }
    case "recover-transient-blocker": {
      const recovery = parseTransientRecoveryOptions(options);
      return performMutation(
        store,
        transactionId,
        `chore(release-queue): recover PR #${recovery.pr} transient blocker`,
        (state) => mutateRecoverTransientBlocker(state, recovery, transactionId, now),
      );
    }
    case "claim":
      return performMutation(
        store,
        transactionId,
        "chore(release-queue): claim merge lease",
        (state) => mutateClaim(state, options, transactionId, now),
      );
    case "heartbeat":
      return performMutation(
        store,
        transactionId,
        "chore(release-queue): heartbeat merge lease",
        (state) => mutateHeartbeat(state, options, transactionId, now),
      );
    case "block":
      return performMutation(
        store,
        transactionId,
        "chore(release-queue): record blocker",
        (state) => mutateBlock(state, options, transactionId, now),
      );
    case "record-merge": {
      const receipt = readJsonFile(requireOption(options, "receipt"), "merge receipt");
      return performMutation(
        store,
        transactionId,
        `chore(release-queue): record PR #${receipt.pr} merge`,
        (state) => mutateRecordMerge(state, options, receipt, transactionId, now),
      );
    }
    case "release":
      return performMutation(
        store,
        transactionId,
        "chore(release-queue): release merge lease",
        (state) => mutateRelease(state, options, transactionId, now),
      );
    default:
      usage();
      fail(`unknown command: ${command}`, 2);
  }
}

try {
  const output = main();
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pr-release-queue] ${message}\n`);
  process.exitCode = error instanceof QueueError ? error.exitCode : 1;
}
