#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
  scripts/pr-release-queue.mjs refresh --packet <FILE>
  scripts/pr-release-queue.mjs recover-transient-blocker --pr <NUMBER> --head-sha <SHA> --diff-fingerprint <SHA256> --kind checks-pending --receipt <FILE>
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
    !/^[0-9a-f]{40}$/i.test(candidate?.headSha ?? "") ||
    typeof candidate?.baseBranch !== "string" ||
    !/^[0-9a-f]{40}$/i.test(candidate?.testedBaseSha ?? "") ||
    !/^sha256:[0-9a-f]{64}$/i.test(candidate?.diffFingerprint ?? "")
  ) {
    fail("release packet candidate must bind PR, URL, exact head/base, and SHA-256 diff");
  }
  assertNonEmptyStrings(candidate.changedPaths, "candidate.changedPaths");
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
      terminalReceipts: [],
    };
    return { action: "enqueued", pr: packet.candidate.pr };
  });
}

function mutateRefresh(state, packet, transactionId, now) {
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
      (!legacyUnreviewedQueued && !["blocked", "awaiting-decision"].includes(item.state))
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

    // Preserve the old immutable attempt and its release-time findings. The
    // repaired packet becomes a fresh queued attempt only after its own exact
    // tester PASS has already been validated by validatePacket.
    item.candidateHistory ??= [];
    item.candidateHistory.push({
      candidate: item.candidate,
      testerReceipt: item.testerReceipt,
      reviewReceipt: item.reviewReceipt,
      discoveredBlockers: item.discoveredBlockers,
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
    item.readyAt = now.toISOString();
    item.state = "queued";
    return { action: "candidate-refreshed", pr: packet.candidate.pr };
  });
}

function validateTransientRecoveryReceipt(receipt, options) {
  const pr = parsePositiveInteger(requireOption(options, "pr"), "--pr");
  const headSha = requireOption(options, "headSha");
  const diffFingerprint = requireOption(options, "diffFingerprint");
  const blockerKind = requireOption(options, "kind");
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    fail("--head-sha must be a 40-character commit SHA", 2);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(diffFingerprint)) {
    fail("--diff-fingerprint must be a SHA-256 lifecycle fingerprint", 2);
  }
  if (blockerKind !== "checks-pending") {
    fail("only the checks-pending transient blocker is recoverable");
  }

  const observedAt = new Date(receipt?.observedAt ?? "");
  const requiredChecks = receipt?.requiredChecks;
  if (
    receipt?.schemaVersion !== SCHEMA_VERSION ||
    receipt?.kind !== "checks-pending-recovery" ||
    typeof receipt?.receiptId !== "string" ||
    receipt.receiptId.trim() === "" ||
    receipt?.source !== "github-required-checks" ||
    receipt?.candidate?.pr !== pr ||
    receipt?.candidate?.headSha !== headSha ||
    receipt?.candidate?.diffFingerprint !== diffFingerprint ||
    receipt?.allRequiredChecksPassed !== true ||
    Number.isNaN(observedAt.valueOf()) ||
    !Array.isArray(requiredChecks) ||
    requiredChecks.length === 0 ||
    requiredChecks.some(
      (check) =>
        typeof check?.name !== "string" ||
        check.name.trim() === "" ||
        check?.conclusion !== "SUCCESS",
    )
  ) {
    fail(
      "recovery receipt must bind the exact candidate and prove all GitHub required checks passed",
    );
  }
  return { pr, headSha, diffFingerprint, blockerKind, receipt };
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
      JSON.stringify(priorRecovery?.receipt) === JSON.stringify(recovery.receipt) &&
      priorRecovery?.candidate?.headSha === recovery.headSha &&
      priorRecovery?.candidate?.diffFingerprint === recovery.diffFingerprint
    ) {
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
    if (
      new Date(recovery.receipt.observedAt).valueOf() < new Date(blockers[0].observedAt).valueOf()
    ) {
      fail("required-check recovery evidence predates the recorded checks-pending blocker");
    }

    const recoveryRecord = {
      candidate: {
        pr: recovery.pr,
        headSha: recovery.headSha,
        diffFingerprint: recovery.diffFingerprint,
      },
      blocker: blockers[0],
      receipt: recovery.receipt,
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

function mutateBlock(state, options, transactionId, now) {
  const kind = requireOption(options, "kind");
  const details = requireOption(options, "details");
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
        (state) => mutateRefresh(state, packet, transactionId, now),
      );
    }
    case "recover-transient-blocker": {
      const receipt = readJsonFile(requireOption(options, "receipt"), "recovery receipt");
      const recovery = validateTransientRecoveryReceipt(receipt, options);
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
