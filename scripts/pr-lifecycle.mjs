#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const GH_BIN = process.env.OPENCLAW_PR_LIFECYCLE_GH ?? "gh";
const RELEASE_ACTIONS = new Set(["normal-merge", "deploy"]);

const RELEASE_CAPABILITY_POLICY = Object.freeze({
  routine: "routine-release",
  escalation: "reasoning-escalation",
});

class LifecycleError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 1) {
  // Throw instead of exiting so an error inside a locked transition always
  // reaches the finally block and releases only this process's lock.
  throw new LifecycleError(message, exitCode);
}

function usage() {
  process.stderr.write(`Usage:
  scripts/pr-lifecycle handoff-test <PR> --test-kind <read-only|live-external> --transport <nested-read-only|user-visible-task> --owner-thread <ID> --owner-host <ID> --review-receipt <FILE> [--returning-release-contract <ID>] [--capacity-retry-contract <ID> --capacity-recovery-receipt <FILE>]
  scripts/pr-lifecycle accept-test-owner <PR> --contract-id <ID> --thread-id <ID> --host-id <ID>
  scripts/pr-lifecycle record-test-receipt <PR> --receipt <FILE>
  scripts/pr-lifecycle close-test <PR> --contract-id <ID> --thread-id <ID> --host-id <ID> --closure <archived|terminal-receipt>
  scripts/pr-lifecycle handoff-release <PR> --transport <queue-lease|user-visible-task> --authority normal-merge --owner-thread <ID> --owner-host <ID> [--task-authority <FILE>] [--queue repo-backed|direct] [--declared-dependencies <FILE>]
  scripts/pr-lifecycle accept-release-owner <PR> --contract-id <ID> --thread-id <ID> --host-id <ID>
  scripts/pr-lifecycle accept-release-handoff <PR> --contract-id <ID> --thread-id <ID> --host-id <ID> --builder-thread <ID> --builder-host <ID> --builder-archived true
  scripts/pr-lifecycle return-source <PR> --contract-id <ID> --thread-id <ID> --host-id <ID> --builder-thread <ID> --builder-host <ID> --builder-unarchived true --finding <TEXT>
  scripts/pr-lifecycle cancel-pending <PR> --role <tester|release> --contract-id <ID> --confirm-no-thread-created

Direct handoffs emit action=create_thread and require native task acceptance.
Repo-backed handoffs emit an immutable packet; a distinct fenced queue lease is
the release owner, while native callbacks remain optional coordination.
`);
}

function parseArgs(argv) {
  if (argv.length < 2) {
    usage();
    throw new LifecycleError("missing command or PR number", 2);
  }

  const [command, prText, ...rest] = argv;
  if (!/^\d+$/.test(prText)) {
    fail(`invalid PR number: ${prText}`, 2);
  }

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) {
      fail(`unexpected argument: ${key}`, 2);
    }
    if (key === "--confirm-no-thread-created") {
      options.confirmNoThreadCreated = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`missing value for ${key}`, 2);
    }
    options[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return { command, pr: Number(prText), options };
}

function requireOption(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`--${key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`, 2);
  }
  return value.trim();
}

function runGh(args) {
  try {
    return execFileSync(GH_BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    fail(`GitHub query failed: gh ${args.join(" ")}${stderr ? `: ${stderr}` : ""}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fetchCandidate(pr) {
  const raw = runGh([
    "pr",
    "view",
    String(pr),
    "--json",
    "number,url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,files,body",
  ]);
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    fail("GitHub returned invalid PR metadata JSON");
  }

  if (metadata.number !== pr || metadata.state !== "OPEN") {
    fail(`PR #${pr} must be open`);
  }
  for (const field of ["url", "headRefName", "headRefOid", "baseRefName", "baseRefOid"]) {
    if (typeof metadata[field] !== "string" || metadata[field] === "") {
      fail(`PR #${pr} is missing immutable field ${field}`);
    }
  }

  const changedPaths = Array.isArray(metadata.files)
    ? metadata.files
        .map((file) => file?.path)
        .filter((value) => typeof value === "string")
        .toSorted()
    : [];
  if (changedPaths.length === 0) {
    fail(`PR #${pr} has no changed paths`);
  }

  // Hash the effective GitHub patch, not the local checkout. That keeps the
  // receipt bound to the exact review surface even when the builder compacts
  // context or invokes the command from a checkout with unrelated local state.
  const patch = runGh(["pr", "diff", String(pr), "--patch"]);
  if (patch.trim() === "") {
    fail(`PR #${pr} returned an empty patch`);
  }

  const body = typeof metadata.body === "string" ? metadata.body : "";
  const acceptanceMatch = body.match(/Observable claim \+ acceptance criteria:\s*(.+)/i);
  const acceptance = acceptanceMatch?.[1]?.trim() ?? "";
  if (!acceptance || acceptance === "-") {
    fail("PR body must contain a filled Observable claim + acceptance criteria field");
  }

  return {
    number: pr,
    url: metadata.url,
    isDraft: metadata.isDraft === true,
    headRefName: metadata.headRefName,
    headSha: metadata.headRefOid,
    baseRefName: metadata.baseRefName,
    baseSha: metadata.baseRefOid,
    diffFingerprint: `sha256:${sha256(patch)}`,
    changedPaths,
    acceptance,
    prContract: body,
  };
}

function resolveStateRoot() {
  const configured = process.env.OPENCLAW_PR_LIFECYCLE_STATE_DIR;
  return path.resolve(configured || path.join(process.cwd(), ".local", "pr-lifecycle"));
}

function lifecycleStateInstruction(root) {
  // Native tester and release tasks run in fresh worktrees. Carry the exact
  // builder-owned state directory in the transport contract so those workers
  // cannot silently resolve an empty, worktree-local lifecycle ledger.
  return `Set OPENCLAW_PR_LIFECYCLE_STATE_DIR=${JSON.stringify(root)} for every scripts/pr-lifecycle command in this handoff. Treat a missing or different state directory as an unresolved ownership gate; do not create, cancel, or replace an owner.`;
}

function withStateLock(pr, callback) {
  const root = resolveStateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, `pr-${pr}.lock`);
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        `PR #${pr} lifecycle state is locked; inspect ${lockPath} and do not create another owner`,
      );
    }
    throw error;
  }

  try {
    const statePath = path.join(root, `pr-${pr}.json`);
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
    const result = callback(state);
    if (result?.state) {
      // Rename is the commit point. A crash cannot expose a half-written owner
      // record that might tempt the next agent to create a duplicate task.
      const candidatePath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(candidatePath, `${JSON.stringify(result.state, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(candidatePath, statePath);
    }
    // Every transition result carries its ledger provenance. This also makes
    // do-not-create and resume receipts independently reconcilable after the
    // caller compacts or hands work to a fresh project worktree.
    return result?.output ? { ...result.output, stateDirectory: root } : result?.output;
  } finally {
    fs.rmdirSync(lockPath);
  }
}

function sameCandidate(left, right) {
  return (
    left?.headSha === right.headSha &&
    left?.baseSha === right.baseSha &&
    left?.diffFingerprint === right.diffFingerprint
  );
}

function hasUnclosedOwner(state) {
  return [state?.tester, state?.release].some(
    (owner) =>
      owner &&
      !["closed", "cancelled"].includes(owner.phase) &&
      // Legacy repo-backed handoffs could attempt a native wake before queue
      // ownership existed. Once the durable queue is authoritative, an
      // ownerless pending wake is coordination state, not an execution owner.
      !(
        owner === state?.release &&
        owner.queueMode === "repo-backed" &&
        owner.phase === "handoff-pending" &&
        owner.owner === null
      ),
  );
}

// Pending tester ownership may be retired only through cancel-pending, which
// records that native task creation definitely did not happen. Keep the owner
// check explicit so corrupted or future cancelled shapes cannot be mistaken
// for a safe candidate-replacement boundary.
function isOwnerlessCancelledTester(tester) {
  return tester?.phase === "cancelled" && Object.hasOwn(tester, "owner") && tester.owner === null;
}

function testerAllowsCandidateRefresh(state) {
  return (
    state.tester?.phase === "closed" ||
    (state.release?.phase === "awaiting-source" && isOwnerlessCancelledTester(state.tester))
  );
}

function makeBaseState(pr, candidate, builder, previous) {
  return {
    schemaVersion: SCHEMA_VERSION,
    pr,
    candidate,
    builder,
    tester: null,
    testerHistory: [],
    release: null,
    history: previous
      ? [
          ...(Array.isArray(previous.history) ? previous.history : []),
          {
            candidate: previous.candidate,
            tester: previous.tester,
            testerHistory: previous.testerHistory ?? [],
            release: previous.release,
            retiredAt: new Date().toISOString(),
          },
        ]
      : [],
    updatedAt: new Date().toISOString(),
  };
}

function testerRouting(testKind, transport, builder) {
  // Make the dispatcher and routing decision auditable. The release worker
  // must never infer either from a worker name or from conversational context.
  return {
    dispatcher: { role: "builder", threadId: builder.threadId, hostId: builder.hostId },
    decision: transport === "nested-read-only" ? "nested-eligible" : "user-visible-required",
    rationale:
      transport === "nested-read-only"
        ? [
            "short-lived deterministic immutable-head read-only validation",
            "no protected resource, external effect, cleanup duty, long wait, user decision, or durable-transcript need",
          ]
        : [
            testKind === "live-external"
              ? "live or external validation requires an independently addressable task"
              : "validation requires an independently addressable durable task",
            "archive the exact tester task only after its terminal receipt is recorded",
          ],
  };
}

function readCapacityRecovery(receiptPath, priorTester) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
  } catch (error) {
    fail(`cannot read capacity recovery receipt: ${error.message}`);
  }

  // Recovery is intentionally narrower than a generic tester retry. The packet
  // must bind one measured guard refusal before workload start, prove the exact
  // failed host gate recovered, and show that no protected lock remains owned.
  const availableKiB = receipt?.capacity?.availableKiB;
  const requiredKiB = receipt?.capacity?.requiredKiB;
  const validCapacity =
    Number.isSafeInteger(availableKiB) &&
    Number.isSafeInteger(requiredKiB) &&
    availableKiB > 0 &&
    requiredKiB > 0 &&
    availableKiB >= requiredKiB;
  const causeCode = receipt?.cause?.code;
  const validRecoveredGate =
    (causeCode === "disk_pressure" && validCapacity) ||
    (causeCode === "jarvis_unhealthy" && receipt?.health?.jarvisHealthy === true) ||
    // A bounded wait can fail solely because another healthy lane owns the
    // shared heavy slot. Retry once only after that exact owner is gone and
    // the same capacity/empty-lock proof used by other recovery paths exists.
    (causeCode === "heavy_slot_occupied" && validCapacity);
  const validLocks =
    receipt?.capacity?.heavyLockDirectoriesEmpty === true &&
    receipt?.capacity?.releaseLockDirectoriesEmpty === true;
  if (
    receipt?.schemaVersion !== SCHEMA_VERSION ||
    receipt?.role !== "capacity-recovery" ||
    receipt?.source !== "authorized-capacity-owner-receipt" ||
    receipt?.priorTesterContractId !== priorTester.contractId ||
    !new Set(["host_unhealthy", "host_capacity"]).has(receipt?.cause?.class) ||
    !new Set(["disk_pressure", "jarvis_unhealthy", "heavy_slot_occupied"]).has(causeCode) ||
    (causeCode === "heavy_slot_occupied" && receipt.cause.class !== "host_capacity") ||
    (causeCode !== "heavy_slot_occupied" && receipt.cause.class !== "host_unhealthy") ||
    receipt?.cause?.workloadStarted !== false ||
    !validRecoveredGate ||
    !validLocks ||
    !Array.isArray(receipt?.evidence) ||
    receipt.evidence.length === 0 ||
    receipt.evidence.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    fail(
      "capacity recovery receipt must bind the prior tester, prove an allowed guard refusal before workload start, prove that exact host gate recovered, and prove empty heavy/release locks",
    );
  }
  return receipt;
}

function ownerPrompt(role, state, stateDirectory) {
  const { candidate, builder } = state;
  const testerReceipt = role === "release" ? state.tester?.receipt : null;
  const releaseAuthority = role === "release" ? state.release?.taskAuthority : null;
  return [
    `Task: ${role === "tester" ? "Independently test" : "Release"} OpenClaw PR #${candidate.number} on the immutable candidate below.`,
    `Owner/cwd: fresh user-visible project-scoped Codex task in the OpenClaw project.`,
    `PR: ${candidate.number} ${candidate.url}`,
    `Head: ${candidate.headSha}`,
    `Base: ${candidate.baseRefName} ${candidate.baseSha}`,
    `Diff: ${candidate.diffFingerprint}; ${candidate.changedPaths.join(", ")}`,
    `Claim / acceptance: ${candidate.acceptance}`,
    `Builder: thread=${builder.threadId} host=${builder.hostId}`,
    `Lifecycle state: ${lifecycleStateInstruction(stateDirectory)}`,
    role === "tester"
      ? `Dispatch: role=${state.tester.routing.dispatcher.role}; decision=${state.tester.routing.decision}; rationale=${state.tester.routing.rationale.join(" | ")}`
      : `Tester dispatch: role=${state.tester.receipt.routing.dispatcher.role}; decision=${state.tester.receipt.routing.decision}; rationale=${state.tester.receipt.routing.rationale.join(" | ")}`,
    `PR contract (builder proof, risks, overlap, and remaining proof):\n${candidate.prContract}`,
    role === "tester"
      ? `Scope: falsify the fixed acceptance criteria on this exact head; do not edit source, merge, deploy, or expand scope.`
      : `Tester: ${testerReceipt.status}; thread=${testerReceipt.owner.threadId} host=${testerReceipt.owner.hostId}; evidence=${testerReceipt.evidence.join(" | ")}`,
    role === "tester"
      ? `Diff identity: if independently recomputing the fingerprint, hash the exact raw stdout bytes from gh pr diff ${candidate.number} --patch with SHA-256. A plain gh pr diff uses a different format and is not the lifecycle fingerprint.`
      : null,
    role === "tester"
      ? `Constraints: return one terminal receipt; preserve source/runtime/live proof boundaries; perform external or live actions only when explicitly granted in this task.`
      : `Authority packet: ${JSON.stringify(releaseAuthority)}. Treat only allowedActions as durable authority. Never infer credentials, OTP, admin/bypass, irreversible/public-release, or new-scope authority.`,
    role === "tester"
      ? `Handback: send the builder a JSON receipt matching scripts/pr-lifecycle record-test-receipt, including the emitted routing object, exact task identity, head, diff, PASS|FAIL, evidence, cleanup, and limitations.`
      : `Acceptance gate: before review, merge, or deploy work, archive the exact builder thread above, verify archived=true, then run scripts/pr-lifecycle accept-release-handoff with both exact identities and --builder-archived true. Stop if that receipt is not release-handoff-accepted.`,
    role === "release"
      ? `Source return: if review finds concrete source work, unarchive only that exact builder, verify archived=false, run scripts/pr-lifecycle return-source with the exact finding, send the finding to that same builder, and pause. Never create a replacement builder. After repaired proof resumes this task, repeat the acceptance gate and re-archive the builder before continuing.`
      : null,
    role === "release"
      ? `Handback: independently verify current head/diff/checks/reviews; merge only if every gate passes; send the merge receipt. Builder archival belongs to acceptance, not post-merge cleanup.`
      : null,
    `Read AGENTS.md, CONSUMER.md, docs/agent-guides/workflow.md, and docs/agent-guides/fleet-resource-control.md before acting. Never route live/external testing or release through a nested sub-agent.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function handoffTest(pr, options) {
  const testKind = requireOption(options, "testKind");
  const transport = requireOption(options, "transport");
  const builder = {
    threadId: requireOption(options, "ownerThread"),
    hostId: requireOption(options, "ownerHost"),
  };
  const returningReleaseContract = options.returningReleaseContract?.trim() || null;
  const capacityRetryContract = options.capacityRetryContract?.trim() || null;
  const capacityRecoveryReceipt = options.capacityRecoveryReceipt?.trim() || null;
  if (Boolean(capacityRetryContract) !== Boolean(capacityRecoveryReceipt)) {
    fail(
      "capacity retry requires both --capacity-retry-contract and --capacity-recovery-receipt",
      2,
    );
  }
  if (capacityRetryContract && returningReleaseContract) {
    fail("capacity retry and release source-return retry are separate transitions", 2);
  }
  if (!new Set(["read-only", "live-external"]).has(testKind)) {
    fail("--test-kind must be read-only or live-external", 2);
  }
  if (!new Set(["nested-read-only", "user-visible-task"]).has(transport)) {
    fail("--transport must be nested-read-only or user-visible-task", 2);
  }
  if (testKind === "live-external" && transport !== "user-visible-task") {
    fail(
      "live/external testing requires transport=user-visible-task; nested sub-agents are forbidden",
    );
  }
  if (transport === "nested-read-only" && testKind !== "read-only") {
    fail("nested-read-only transport is legal only for short deterministic read-only testing");
  }

  const candidate = fetchCandidate(pr);
  const reviewReceipt = readReviewReceipt(
    requireOption(options, "reviewReceipt"),
    candidate,
    builder,
  );
  return withStateLock(pr, (existing) => {
    let state = existing;
    if (
      state &&
      (state.builder.threadId !== builder.threadId || state.builder.hostId !== builder.hostId)
    ) {
      // Validate the durable owner before rebuilding state for a new candidate.
      // Comparing after makeBaseState would only compare caller input to itself
      // and would let a repaired-head handoff replace the recorded builder.
      fail("builder identity differs from the recorded candidate owner");
    }
    if (state && !sameCandidate(state.candidate, candidate)) {
      const returningFromRelease =
        ["awaiting-source", "awaiting-retest"].includes(state.release?.phase) &&
        state.release.contractId === returningReleaseContract &&
        testerAllowsCandidateRefresh(state);
      if (!returningFromRelease && hasUnclosedOwner(state)) {
        fail(
          "PR head/diff changed while an owner may still be active; resolve that exact owner first",
        );
      }
      const previous = state;
      state = makeBaseState(pr, candidate, builder, previous);
      if (returningFromRelease) {
        // A release discrepancy returns source ownership to the exact builder,
        // but it must not create a second release owner. Carry that identity
        // across both the first repair and any tester-driven follow-up repairs,
        // then park it until fresh proof closes.
        state.release = {
          ...previous.release,
          phase: "awaiting-retest",
          returnedAt: new Date().toISOString(),
        };
      }
    } else if (!state) {
      state = makeBaseState(pr, candidate, builder, null);
    }

    if (state.builder.threadId !== builder.threadId || state.builder.hostId !== builder.hostId) {
      fail("builder identity differs from the recorded candidate owner");
    }

    // A canceled or replayed reservation may keep the same source identity
    // while the builder refreshes the durable PR receipt. Always compose the
    // next tester prompt from current GitHub metadata, not cached body text.
    state.candidate = candidate;
    state.reviewReceipt = reviewReceipt;

    // Capacity recovery grants one replacement for this immutable candidate,
    // not one replacement per failed tester. The attempt ledger is therefore
    // the durable retry budget: once it contains a recovery receipt, a later
    // replacement failure cannot recursively become a new retry source.
    const consumedCapacityRetry = state.testerHistory?.some(
      (attempt) => attempt?.capacityRecoveryReceipt !== null,
    );
    if (
      capacityRetryContract &&
      consumedCapacityRetry &&
      state.tester?.retryOfContractId === capacityRetryContract
    ) {
      // The recovery packet is one-shot, but its replay remains idempotent even
      // after the replacement tester advances beyond pending or later closes.
      return {
        state,
        output: {
          schemaVersion: SCHEMA_VERSION,
          action: "do-not-create",
          reason: `capacity retry already created tester lifecycle ${state.tester.phase}`,
          contractId: state.tester.contractId,
          owner: state.tester.owner ?? null,
        },
      };
    }
    if (capacityRetryContract && consumedCapacityRetry) {
      fail("capacity retry was already consumed for this immutable candidate");
    }

    if (state.tester && !["closed", "cancelled"].includes(state.tester.phase)) {
      return {
        state,
        output: {
          schemaVersion: SCHEMA_VERSION,
          action: "do-not-create",
          reason: `tester handoff is already ${state.tester.phase}`,
          contractId: state.tester.contractId,
          owner: state.tester.owner ?? null,
        },
      };
    }
    let retryOfContractId = null;
    let recoveryReceipt = null;
    if (state.tester?.phase === "closed") {
      if (!capacityRetryContract) {
        return {
          state,
          output: {
            schemaVersion: SCHEMA_VERSION,
            action: "do-not-create",
            reason: "this immutable candidate already has a closed tester lifecycle",
            contractId: state.tester.contractId,
          },
        };
      }

      const priorTester = state.tester;
      if (priorTester.contractId !== capacityRetryContract) {
        fail("capacity retry contract does not match the exact closed tester");
      }
      if (
        priorTester.transport !== "user-visible-task" ||
        priorTester.transport !== transport ||
        priorTester.testKind !== testKind ||
        priorTester.receipt?.status !== "FAIL" ||
        !(
          priorTester.receipt?.cleanup?.status === "not-required" ||
          (priorTester.receipt?.cleanup?.status === "complete" &&
            priorTester.receipt?.workloadStarted === false)
        ) ||
        priorTester.closure?.type !== "archived" ||
        state.release !== null
      ) {
        fail(
          "capacity retry requires the same test contract, one archived user-visible pre-workload FAIL with complete or unnecessary cleanup, and no release owner",
        );
      }

      recoveryReceipt = readCapacityRecovery(capacityRecoveryReceipt, priorTester);
      retryOfContractId = priorTester.contractId;
      // Preserve the terminal failed tester verbatim. Moving it into an attempt
      // ledger makes the new reservation atomic without rewriting past truth.
      state.testerHistory = [
        ...(Array.isArray(state.testerHistory) ? state.testerHistory : []),
        {
          tester: priorTester,
          capacityRecoveryReceipt: recoveryReceipt,
          retiredAt: new Date().toISOString(),
        },
      ];
      state.tester = null;
    } else if (capacityRetryContract) {
      fail("capacity retry requires the exact closed tester on this immutable candidate");
    }

    const contractId = randomUUID();
    const routing = testerRouting(testKind, transport, builder);
    state.tester = {
      phase: "handoff-pending",
      contractId,
      testKind,
      transport,
      routing,
      owner: null,
      receipt: null,
      closure: null,
      retryOfContractId,
      capacityRecoveryReceipt: recoveryReceipt,
      createdAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    return {
      state,
      output: {
        schemaVersion: SCHEMA_VERSION,
        action: transport === "user-visible-task" ? "create_thread" : "spawn_nested_read_only",
        contractId,
        transport,
        routing,
        candidate,
        retryOfContractId,
        nativeTool:
          transport === "user-visible-task"
            ? {
                sequence: ["list_projects", "create_thread", "accept-test-owner"],
                target: {
                  type: "project",
                  environment: {
                    type: "worktree",
                    startingState: { type: "branch", branchName: candidate.headSha },
                  },
                },
              }
            : null,
        prompt: ownerPrompt("tester", state, resolveStateRoot()),
        warning:
          "Consume this action once. A rerun fails closed with do-not-create until the exact owner is recorded or pending state is explicitly cancelled.",
      },
    };
  });
}

function acceptOwner(pr, options, role) {
  const contractId = requireOption(options, "contractId");
  const owner = {
    threadId: requireOption(options, "threadId"),
    hostId: requireOption(options, "hostId"),
  };
  return withStateLock(pr, (state) => {
    if (!state?.[role] || state[role].contractId !== contractId) {
      fail(`no matching ${role} handoff contract`);
    }
    if (
      role === "tester" &&
      state.builder.threadId === owner.threadId &&
      state.builder.hostId === owner.hostId
    ) {
      fail("tester owner must differ from the exact builder identity");
    }
    const record = state[role];
    const acceptedPhase = role === "release" ? "owner-recorded" : "active";
    if (record.phase === acceptedPhase || (role === "release" && record.phase === "active")) {
      if (record.owner.threadId !== owner.threadId || record.owner.hostId !== owner.hostId) {
        fail(`a different ${role} owner is already active`);
      }
      return { state, output: { action: "owner-already-recorded", role, contractId, owner } };
    }
    if (record.phase !== "handoff-pending") {
      fail(`${role} handoff is ${record.phase}, not handoff-pending`);
    }
    record.owner = owner;
    record.phase = acceptedPhase;
    record.acceptedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    return { state, output: { action: "owner-recorded", role, contractId, owner } };
  });
}

function exactReleaseAndBuilder(state, options) {
  const contractId = requireOption(options, "contractId");
  const releaseOwner = {
    threadId: requireOption(options, "threadId"),
    hostId: requireOption(options, "hostId"),
  };
  const builder = {
    threadId: requireOption(options, "builderThread"),
    hostId: requireOption(options, "builderHost"),
  };
  if (!state?.release || state.release.contractId !== contractId) {
    fail("no matching release handoff contract");
  }
  if (
    state.release.owner?.threadId !== releaseOwner.threadId ||
    state.release.owner?.hostId !== releaseOwner.hostId
  ) {
    fail("release transition identity does not match the exact recorded owner");
  }
  if (state.builder.threadId !== builder.threadId || state.builder.hostId !== builder.hostId) {
    fail("release transition builder identity does not match the exact recorded builder");
  }
  return { contractId, releaseOwner, builder };
}

function acceptReleaseHandoff(pr, options) {
  return withStateLock(pr, (state) => {
    const { contractId, releaseOwner, builder } = exactReleaseAndBuilder(state, options);
    const release = state.release;
    if (release.phase === "active" && release.builderArchiveReceipt?.archived === true) {
      return {
        state,
        output: {
          action: "release-handoff-already-accepted",
          contractId,
          owner: releaseOwner,
          builderArchiveReceipt: release.builderArchiveReceipt,
        },
      };
    }
    // States written by the first deterministic lifecycle revision marked the
    // release active immediately after owner recording. Treat only that
    // receipt-less legacy shape as awaiting acceptance; never grandfather it
    // into release authority.
    const legacyAwaitingAcceptance =
      release.phase === "active" && release.builderArchiveReceipt == null;
    if (release.phase !== "owner-recorded" && !legacyAwaitingAcceptance) {
      fail(`release handoff is ${release.phase}, not owner-recorded`);
    }
    if (requireOption(options, "builderArchived") !== "true") {
      fail("release acceptance requires --builder-archived true after exact native verification");
    }

    // This is the release work gate. Recording the exact native result here
    // makes acceptance retry-safe and prevents review or merge while the
    // builder still appears in the active task list.
    release.builderArchiveReceipt = {
      archived: true,
      builder,
      verifiedBy: releaseOwner,
      recordedAt: new Date().toISOString(),
    };
    release.phase = "active";
    release.handoffAcceptedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    return {
      state,
      output: {
        action: "release-handoff-accepted",
        contractId,
        owner: releaseOwner,
        builderArchiveReceipt: release.builderArchiveReceipt,
        authority: release.taskAuthority,
      },
    };
  });
}

function returnSource(pr, options) {
  return withStateLock(pr, (state) => {
    const { contractId, releaseOwner, builder } = exactReleaseAndBuilder(state, options);
    const release = state.release;
    const finding = requireOption(options, "finding");
    if (release.phase === "awaiting-source") {
      if (release.sourceReturn?.finding !== finding) {
        fail("source was already returned with a different exact finding");
      }
      return {
        state,
        output: {
          action: "source-already-returned",
          contractId,
          owner: releaseOwner,
          builder,
          finding,
        },
      };
    }
    const archiveReceiptMatches =
      release.builderArchiveReceipt?.archived === true &&
      release.builderArchiveReceipt.builder?.threadId === builder.threadId &&
      release.builderArchiveReceipt.builder?.hostId === builder.hostId &&
      release.builderArchiveReceipt.verifiedBy?.threadId === releaseOwner.threadId &&
      release.builderArchiveReceipt.verifiedBy?.hostId === releaseOwner.hostId;
    if (!archiveReceiptMatches || !["active", "awaiting-retest"].includes(release.phase)) {
      fail(
        `source return requires an active accepted release handoff with builder archive proof, not ${release.phase}`,
      );
    }
    if (release.phase === "awaiting-retest" && !isOwnerlessCancelledTester(state.tester)) {
      fail(
        "repeated source return from awaiting-retest requires the exact ownerless cancelled tester reservation",
      );
    }
    if (requireOption(options, "builderUnarchived") !== "true") {
      fail("source return requires --builder-unarchived true after exact native verification");
    }

    release.sourceReturn = {
      finding,
      builder,
      unarchived: true,
      verifiedBy: releaseOwner,
      recordedAt: new Date().toISOString(),
    };
    release.phase = "awaiting-source";
    state.updatedAt = new Date().toISOString();
    return {
      state,
      output: {
        action: "source-returned",
        contractId,
        owner: releaseOwner,
        builder,
        finding,
        nativeTool: { sequence: ["send_message_to_thread"] },
        warning: "Steer only the exact revived builder and pause this release task.",
      },
    };
  });
}

function readReceipt(receiptPath) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
  } catch (error) {
    fail(`cannot read tester receipt: ${error.message}`);
  }
  return receipt;
}

function readReviewReceipt(receiptPath, candidate, builder) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(path.resolve(receiptPath), "utf8"));
  } catch (error) {
    fail(`cannot read code review receipt: ${error.message}`);
  }
  const validFindings =
    Array.isArray(receipt?.unresolvedFindings) &&
    receipt.unresolvedFindings.every(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        ["low", "medium", "high", "critical"].includes(finding.severity),
    );
  if (
    receipt?.schemaVersion !== SCHEMA_VERSION ||
    receipt?.role !== "code-reviewer" ||
    receipt?.status !== "PASS" ||
    receipt?.headSha !== candidate.headSha ||
    receipt?.diffFingerprint !== candidate.diffFingerprint ||
    typeof receipt?.owner?.threadId !== "string" ||
    receipt.owner.threadId.trim() === "" ||
    typeof receipt?.owner?.hostId !== "string" ||
    receipt.owner.hostId.trim() === "" ||
    (receipt.owner.threadId === builder.threadId && receipt.owner.hostId === builder.hostId) ||
    !validFindings ||
    receipt.unresolvedFindings.some((finding) => ["high", "critical"].includes(finding.severity))
  ) {
    fail(
      "tester handoff requires an exact-head independent code review PASS with no unresolved high or critical findings",
    );
  }
  return receipt;
}

function readTaskAuthority(authorityPath, pr) {
  if (!authorityPath) {
    // Normal merge is the narrow default explicitly requested by the existing
    // --authority flag. Protected runtime work never appears by implication.
    return {
      schemaVersion: SCHEMA_VERSION,
      source: "builder-handoff",
      scope: `PR #${pr} source merge only`,
      allowedActions: ["normal-merge"],
      constraints: [
        "no admin or bypass",
        "no credentials or OTP",
        "no irreversible or public release",
        "no new scope",
      ],
    };
  }

  let authority;
  try {
    authority = JSON.parse(fs.readFileSync(path.resolve(authorityPath), "utf8"));
  } catch (error) {
    fail(`cannot read task authority: ${error.message}`);
  }
  const allowedActions = authority?.allowedActions;
  const validActions =
    Array.isArray(allowedActions) &&
    allowedActions.length > 0 &&
    allowedActions.every((action) => RELEASE_ACTIONS.has(action));
  if (
    authority?.schemaVersion !== SCHEMA_VERSION ||
    authority?.source !== "direct-user-task" ||
    typeof authority?.scope !== "string" ||
    authority.scope.trim() === "" ||
    !validActions ||
    !allowedActions.includes("normal-merge") ||
    !Array.isArray(authority.constraints) ||
    authority.constraints.some((constraint) => typeof constraint !== "string")
  ) {
    fail(
      "task authority must be a direct-user-task packet granting only normal-merge and optional deploy with explicit scope and constraints",
    );
  }
  return authority;
}

function readDeclaredDependencies(dependenciesPath, pr) {
  if (!dependenciesPath) {
    return [];
  }
  let dependencies;
  try {
    dependencies = JSON.parse(fs.readFileSync(path.resolve(dependenciesPath), "utf8"));
  } catch (error) {
    fail(`cannot read declared dependencies: ${error.message}`);
  }
  if (!Array.isArray(dependencies)) {
    fail("declared dependencies must be a JSON array");
  }
  for (const dependency of dependencies) {
    if (
      !Number.isSafeInteger(dependency?.pr) ||
      dependency.pr <= 0 ||
      dependency.pr === pr ||
      !["requires", "before", "after", "incompatible"].includes(dependency?.relation) ||
      typeof dependency?.reason !== "string" ||
      dependency.reason.trim() === ""
    ) {
      fail("each declared dependency requires another PR, relation, and reason");
    }
  }
  return dependencies;
}

function makeReleasePacket(state, contractId) {
  const { candidate, builder, tester, release } = state;
  return {
    schemaVersion: SCHEMA_VERSION,
    candidate: {
      pr: candidate.number,
      url: candidate.url,
      headSha: candidate.headSha,
      baseBranch: candidate.baseRefName,
      testedBaseSha: candidate.baseSha,
      diffFingerprint: candidate.diffFingerprint,
      changedPaths: candidate.changedPaths,
    },
    builder: {
      threadId: builder.threadId,
      hostId: builder.hostId,
      wakeRoute: { threadId: builder.threadId, hostId: builder.hostId },
    },
    testerReceipt: {
      status: tester.receipt.status,
      headSha: candidate.headSha,
      diffFingerprint: candidate.diffFingerprint,
      closure: tester.closure.type,
      contractId: tester.contractId,
      owner: tester.receipt.owner,
    },
    reviewReceipt: state.reviewReceipt,
    capabilityPolicy: RELEASE_CAPABILITY_POLICY,
    authority: release.taskAuthority,
    declaredDependencies: release.declaredDependencies,
    lifecycle: {
      contractId,
      stateDirectory: resolveStateRoot(),
    },
  };
}

function recordTestReceipt(pr, options) {
  const receipt = readReceipt(requireOption(options, "receipt"));
  const candidate = fetchCandidate(pr);
  return withStateLock(pr, (state) => {
    if (!state?.tester || state.tester.phase !== "active") {
      fail("tester receipt requires one exact active tester owner");
    }
    if (!sameCandidate(state.candidate, candidate)) {
      fail("PR head/diff changed before the tester receipt was recorded");
    }
    const expected = state.tester;
    const validStatus = receipt.status === "PASS" || receipt.status === "FAIL";
    const validOwner =
      receipt.owner?.threadId === expected.owner.threadId &&
      receipt.owner?.hostId === expected.owner.hostId;
    const validCleanup = ["complete", "not-required"].includes(receipt.cleanup?.status);
    const validRouting = JSON.stringify(receipt.routing) === JSON.stringify(expected.routing);
    if (
      receipt.schemaVersion !== SCHEMA_VERSION ||
      receipt.role !== "tester" ||
      receipt.contractId !== expected.contractId ||
      !validStatus ||
      receipt.headSha !== candidate.headSha ||
      receipt.diffFingerprint !== candidate.diffFingerprint ||
      !validOwner ||
      !validRouting ||
      !Array.isArray(receipt.evidence) ||
      receipt.evidence.length === 0 ||
      !validCleanup ||
      !Array.isArray(receipt.limitations)
    ) {
      fail(
        "tester receipt is incomplete or does not match the immutable candidate, dispatcher routing, and exact owner",
      );
    }
    expected.receipt = receipt;
    expected.phase = "receipt-recorded";
    expected.receiptRecordedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    return {
      state,
      output: {
        action:
          expected.transport === "user-visible-task"
            ? "archive-exact-tester-thread"
            : "resolve-exact-nested-agent",
        contractId: expected.contractId,
        owner: expected.owner,
        status: receipt.status,
      },
    };
  });
}

function closeTest(pr, options) {
  const contractId = requireOption(options, "contractId");
  const threadId = requireOption(options, "threadId");
  const hostId = requireOption(options, "hostId");
  const closure = requireOption(options, "closure");
  return withStateLock(pr, (state) => {
    const tester = state?.tester;
    if (!tester || tester.contractId !== contractId || tester.phase !== "receipt-recorded") {
      fail("tester closure requires the matching recorded terminal receipt");
    }
    if (tester.owner.threadId !== threadId || tester.owner.hostId !== hostId) {
      fail("tester closure identity does not match the exact recorded owner");
    }
    const expectedClosure =
      tester.transport === "user-visible-task" ? "archived" : "terminal-receipt";
    if (closure !== expectedClosure) {
      fail(`${tester.transport} requires closure=${expectedClosure}`);
    }
    tester.closure = { type: closure, threadId, hostId, recordedAt: new Date().toISOString() };
    tester.phase = "closed";
    state.updatedAt = new Date().toISOString();
    return {
      state,
      output: { action: "tester-closed", contractId, status: tester.receipt.status },
    };
  });
}

function handoffRelease(pr, options) {
  const transport = requireOption(options, "transport");
  const authority = requireOption(options, "authority");
  const builder = {
    threadId: requireOption(options, "ownerThread"),
    hostId: requireOption(options, "ownerHost"),
  };
  if (!new Set(["queue-lease", "user-visible-task"]).has(transport)) {
    fail("release transport must be queue-lease or user-visible-task");
  }
  if (authority !== "normal-merge") {
    fail(
      "release handoff requires explicit authority=normal-merge and cannot invent broader authority",
    );
  }
  const taskAuthority = readTaskAuthority(options.taskAuthority, pr);
  const requestedQueueMode = options.queue?.trim() || null;
  if (requestedQueueMode && !["repo-backed", "direct"].includes(requestedQueueMode)) {
    fail("--queue must be repo-backed or direct when provided", 2);
  }
  let queueMode = requestedQueueMode === "direct" ? null : requestedQueueMode;
  // Direct routing is an explicit rollback, never an ambient environment
  // escape hatch. Every ordinary or repo-backed handoff must consult the
  // authoritative queue so paused or unreachable rollout state fails closed.
  const mustResolveQueue = requestedQueueMode !== "direct";
  if (mustResolveQueue) {
    try {
      const queueScript = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "pr-release-queue.mjs",
      );
      const status = JSON.parse(
        execFileSync(process.execPath, [queueScript, "status"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      if (["dogfood", "graduated"].includes(status?.rollout?.phase)) {
        queueMode = "repo-backed";
      } else if (status?.rollout?.phase === "paused") {
        fail(`repo-backed release rollout is paused: ${status.rollout.pausedReason}`);
      } else {
        fail("authoritative release rollout returned an unknown phase");
      }
    } catch (error) {
      if (error instanceof LifecycleError) {
        throw error;
      }
      fail(
        `cannot resolve authoritative release routing; use --queue direct only for the documented rollback: ${error.message}`,
        75,
      );
    }
  }
  if (queueMode === "repo-backed" && transport !== "queue-lease") {
    fail("repo-backed release execution requires transport=queue-lease");
  }
  if (queueMode === null && transport !== "user-visible-task") {
    fail("direct release rollback requires transport=user-visible-task");
  }
  const declaredDependencies = readDeclaredDependencies(options.declaredDependencies, pr);
  const candidate = fetchCandidate(pr);
  if (candidate.isDraft) {
    fail("release handoff requires a ready-for-review PR, not a draft");
  }

  return withStateLock(pr, (state) => {
    if (!state || !sameCandidate(state.candidate, candidate)) {
      fail("release handoff has no matching immutable tester candidate");
    }
    if (state.builder.threadId !== builder.threadId || state.builder.hostId !== builder.hostId) {
      fail("release handoff builder identity differs from the recorded owner");
    }
    const requiredClosure =
      state.tester?.transport === "user-visible-task" ? "archived" : "terminal-receipt";
    if (
      state.tester?.phase !== "closed" ||
      state.tester?.receipt?.status !== "PASS" ||
      state.tester?.receipt?.routing?.dispatcher?.role !== "builder" ||
      state.tester?.receipt?.routing?.decision !== state.tester?.routing?.decision ||
      (state.tester?.owner?.threadId === state.builder.threadId &&
        state.tester?.owner?.hostId === state.builder.hostId) ||
      state.tester?.closure?.type !== requiredClosure
    ) {
      fail(
        "release handoff requires an exact-head PASS and the transport's exact tester lifecycle closure",
      );
    }
    if (
      state.reviewReceipt?.role !== "code-reviewer" ||
      state.reviewReceipt?.status !== "PASS" ||
      state.reviewReceipt?.headSha !== candidate.headSha ||
      state.reviewReceipt?.diffFingerprint !== candidate.diffFingerprint ||
      typeof state.reviewReceipt?.owner?.threadId !== "string" ||
      state.reviewReceipt.owner.threadId.trim() === "" ||
      typeof state.reviewReceipt?.owner?.hostId !== "string" ||
      state.reviewReceipt.owner.hostId.trim() === "" ||
      (state.reviewReceipt.owner.threadId === state.builder.threadId &&
        state.reviewReceipt.owner.hostId === state.builder.hostId) ||
      !Array.isArray(state.reviewReceipt?.unresolvedFindings) ||
      !state.reviewReceipt.unresolvedFindings.every(
        (finding) =>
          finding &&
          typeof finding === "object" &&
          ["low", "medium", "high", "critical"].includes(finding.severity),
      ) ||
      state.reviewReceipt.unresolvedFindings.some((finding) =>
        ["high", "critical"].includes(finding?.severity),
      )
    ) {
      fail("release handoff requires a fresh exact-head review PASS with no serious findings");
    }
    // The PR body is the durable receipt surface and normally advances after
    // tester closure without changing the immutable source candidate. Refresh
    // that mutable contract before composing the release prompt so the cheaper
    // release model never receives stale "tester pending" or old-head claims.
    state.candidate = candidate;
    if (state.release?.phase === "awaiting-retest") {
      // The same release owner resumes, but it cannot resume release work until
      // it re-archives the repaired builder and records acceptance again.
      state.release.phase = "owner-recorded";
      state.release.builderArchiveReceipt = null;
      state.release.resumedAt = new Date().toISOString();
      state.updatedAt = new Date().toISOString();
      return {
        state,
        output: {
          schemaVersion: SCHEMA_VERSION,
          action: "resume-thread",
          contractId: state.release.contractId,
          transport: state.release.transport,
          authority: state.release.authority,
          taskAuthority: state.release.taskAuthority,
          owner: state.release.owner,
          candidate,
          testerReceipt: state.tester.receipt,
          nativeTool: {
            sequence: ["send_message_to_thread", "set_thread_archived", "accept-release-handoff"],
          },
          prompt: ownerPrompt("release", state, resolveStateRoot()),
          warning: "Resume only the exact recorded release task; never create a replacement owner.",
        },
      };
    }
    if (state.release && !["cancelled"].includes(state.release.phase)) {
      return {
        state,
        output: {
          schemaVersion: SCHEMA_VERSION,
          action: "do-not-create",
          reason: `release handoff is already ${state.release.phase}`,
          contractId: state.release.contractId,
          owner: state.release.owner ?? null,
        },
      };
    }

    const contractId = randomUUID();
    state.release = {
      phase: "handoff-pending",
      contractId,
      transport,
      authority,
      taskAuthority,
      queueMode,
      declaredDependencies,
      owner: null,
      createdAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    if (queueMode === "repo-backed") {
      return {
        state,
        output: {
          schemaVersion: SCHEMA_VERSION,
          action: "enqueue-release-packet",
          contractId,
          transport,
          releasePacket: makeReleasePacket(state, contractId),
          queueTool: { sequence: ["pr-release-queue enqueue", "pr-release-queue claim"] },
          optionalCoordination: {
            nativeThread: "create-or-wake-best-effort",
            establishesOwnership: false,
          },
          capabilityPolicy: RELEASE_CAPABILITY_POLICY,
          warning:
            "Persist the packet before execution. Only a distinct active fenced queue lease establishes release ownership; native callbacks are optional wake signals.",
        },
      };
    }
    return {
      state,
      output: {
        schemaVersion: SCHEMA_VERSION,
        action: "create_thread",
        contractId,
        transport,
        authority,
        taskAuthority,
        candidate,
        testerReceipt: state.tester.receipt,
        nativeTool: {
          sequence: [
            "list_projects",
            "create_thread",
            "accept-release-owner",
            "set_thread_archived",
            "accept-release-handoff",
          ],
          target: { type: "project", environment: { type: "worktree" } },
        },
        capabilityPolicy: RELEASE_CAPABILITY_POLICY,
        prompt: ownerPrompt("release", state, resolveStateRoot()),
        warning:
          "Consume this direct rollback action once. Prevent recursive handoffs. A rerun fails closed with do-not-create until the exact owner is recorded or pending state is explicitly cancelled.",
      },
    };
  });
}

function cancelPending(pr, options) {
  const role = requireOption(options, "role");
  const contractId = requireOption(options, "contractId");
  if (!new Set(["tester", "release"]).has(role)) {
    fail("--role must be tester or release", 2);
  }
  if (options.confirmNoThreadCreated !== true) {
    fail("cancelling pending ownership requires --confirm-no-thread-created");
  }
  return withStateLock(pr, (state) => {
    const owner = state?.[role];
    if (!owner || owner.contractId !== contractId || owner.phase !== "handoff-pending") {
      fail(`no matching pending ${role} handoff`);
    }
    owner.phase = "cancelled";
    owner.cancelledAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    return { state, output: { action: "pending-cancelled", role, contractId } };
  });
}

try {
  const { command, pr, options } = parseArgs(process.argv.slice(2));
  let output;
  switch (command) {
    case "handoff-test":
      output = handoffTest(pr, options);
      break;
    case "accept-test-owner":
      output = acceptOwner(pr, options, "tester");
      break;
    case "record-test-receipt":
      output = recordTestReceipt(pr, options);
      break;
    case "close-test":
      output = closeTest(pr, options);
      break;
    case "handoff-release":
      output = handoffRelease(pr, options);
      break;
    case "accept-release-owner":
      output = acceptOwner(pr, options, "release");
      break;
    case "accept-release-handoff":
      output = acceptReleaseHandoff(pr, options);
      break;
    case "return-source":
      output = returnSource(pr, options);
      break;
    case "cancel-pending":
      output = cancelPending(pr, options);
      break;
    default:
      usage();
      throw new LifecycleError(`unknown command: ${command}`, 2);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pr-lifecycle] ${message}\n`);
  process.exitCode = error instanceof LifecycleError ? error.exitCode : 1;
}
