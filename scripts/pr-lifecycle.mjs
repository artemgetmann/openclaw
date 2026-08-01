#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = 1;
const GH_BIN = process.env.OPENCLAW_PR_LIFECYCLE_GH ?? "gh";

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
  scripts/pr-lifecycle handoff-test <PR> --test-kind <read-only|live-external> --transport <nested-read-only|user-visible-task> --owner-thread <ID> --owner-host <ID> [--returning-release-contract <ID>]
  scripts/pr-lifecycle accept-test-owner <PR> --contract-id <ID> --thread-id <ID> --host-id <ID>
  scripts/pr-lifecycle record-test-receipt <PR> --receipt <FILE>
  scripts/pr-lifecycle close-test <PR> --contract-id <ID> --thread-id <ID> --host-id <ID> --closure <archived|terminal-receipt>
  scripts/pr-lifecycle handoff-release <PR> --transport user-visible-task --authority normal-merge --owner-thread <ID> --owner-host <ID>
  scripts/pr-lifecycle accept-release-owner <PR> --contract-id <ID> --thread-id <ID> --host-id <ID>
  scripts/pr-lifecycle cancel-pending <PR> --role <tester|release> --contract-id <ID> --confirm-no-thread-created

The handoff commands emit JSON. A native agent must consume action=create_thread
with list_projects/create_thread, then record the exact returned task identity.
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
    return result?.output;
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
    (owner) => owner && !["closed", "cancelled"].includes(owner.phase),
  );
}

function makeBaseState(pr, candidate, builder, previous) {
  return {
    schemaVersion: SCHEMA_VERSION,
    pr,
    candidate,
    builder,
    tester: null,
    release: null,
    history: previous
      ? [
          ...(Array.isArray(previous.history) ? previous.history : []),
          {
            candidate: previous.candidate,
            tester: previous.tester,
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

function ownerPrompt(role, state) {
  const { candidate, builder } = state;
  const testerReceipt = role === "release" ? state.tester?.receipt : null;
  return [
    `Task: ${role === "tester" ? "Independently test" : "Release"} OpenClaw PR #${candidate.number} on the immutable candidate below.`,
    `Owner/cwd: fresh user-visible project-scoped Codex task in the OpenClaw project.`,
    `PR: ${candidate.number} ${candidate.url}`,
    `Head: ${candidate.headSha}`,
    `Base: ${candidate.baseRefName} ${candidate.baseSha}`,
    `Diff: ${candidate.diffFingerprint}; ${candidate.changedPaths.join(", ")}`,
    `Claim / acceptance: ${candidate.acceptance}`,
    `Builder: thread=${builder.threadId} host=${builder.hostId}`,
    role === "tester"
      ? `Dispatch: role=${state.tester.routing.dispatcher.role}; decision=${state.tester.routing.decision}; rationale=${state.tester.routing.rationale.join(" | ")}`
      : `Tester dispatch: role=${state.tester.receipt.routing.dispatcher.role}; decision=${state.tester.receipt.routing.decision}; rationale=${state.tester.receipt.routing.rationale.join(" | ")}`,
    `PR contract (builder proof, risks, overlap, and remaining proof):\n${candidate.prContract}`,
    role === "tester"
      ? `Scope: falsify the fixed acceptance criteria on this exact head; do not edit source, merge, deploy, or expand scope.`
      : `Tester: ${testerReceipt.status}; thread=${testerReceipt.owner.threadId} host=${testerReceipt.owner.hostId}; evidence=${testerReceipt.evidence.join(" | ")}`,
    role === "tester"
      ? `Constraints: return one terminal receipt; preserve source/runtime/live proof boundaries; perform external or live actions only when explicitly granted in this task.`
      : `Authority: normal non-admin merge only. No bypass, admin override, deploy, restart, package, install, shared-runtime mutation, or product release.`,
    role === "tester"
      ? `Handback: send the builder a JSON receipt matching scripts/pr-lifecycle record-test-receipt, including the emitted routing object, exact task identity, head, diff, PASS|FAIL, evidence, cleanup, and limitations.`
      : `Handback: verify current head/diff/checks/reviews, merge only if every gate passes, send the merge receipt, then archive the exact builder thread above.`,
    `Read AGENTS.md, CONSUMER.md, docs/agent-guides/workflow.md, and docs/agent-guides/fleet-resource-control.md before acting. Never route live/external testing or release through a nested sub-agent.`,
  ].join("\n");
}

function handoffTest(pr, options) {
  const testKind = requireOption(options, "testKind");
  const transport = requireOption(options, "transport");
  const builder = {
    threadId: requireOption(options, "ownerThread"),
    hostId: requireOption(options, "ownerHost"),
  };
  const returningReleaseContract = options.returningReleaseContract?.trim() || null;
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
  return withStateLock(pr, (existing) => {
    let state = existing;
    if (state && !sameCandidate(state.candidate, candidate)) {
      const returningFromRelease =
        state.release?.phase === "active" &&
        state.release.contractId === returningReleaseContract &&
        state.tester?.phase === "closed";
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
        // across the repaired candidate and park it until fresh proof closes.
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
    if (state.tester?.phase === "closed") {
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
        prompt: ownerPrompt("tester", state),
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
    const record = state[role];
    if (record.phase === "active") {
      if (record.owner.threadId !== owner.threadId || record.owner.hostId !== owner.hostId) {
        fail(`a different ${role} owner is already active`);
      }
      return { state, output: { action: "owner-already-recorded", role, contractId, owner } };
    }
    if (record.phase !== "handoff-pending") {
      fail(`${role} handoff is ${record.phase}, not handoff-pending`);
    }
    record.owner = owner;
    record.phase = "active";
    record.acceptedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    return { state, output: { action: "owner-recorded", role, contractId, owner } };
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
  if (transport !== "user-visible-task") {
    fail("release workers require transport=user-visible-task; nested sub-agents are forbidden");
  }
  if (authority !== "normal-merge") {
    fail(
      "release handoff requires explicit authority=normal-merge and cannot invent broader authority",
    );
  }
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
      state.tester?.closure?.type !== requiredClosure
    ) {
      fail(
        "release handoff requires an exact-head PASS and the transport's exact tester lifecycle closure",
      );
    }
    if (state.release?.phase === "awaiting-retest") {
      state.release.phase = "active";
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
          owner: state.release.owner,
          candidate,
          testerReceipt: state.tester.receipt,
          nativeTool: { sequence: ["send_message_to_thread"] },
          prompt: ownerPrompt("release", state),
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
      owner: null,
      createdAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    return {
      state,
      output: {
        schemaVersion: SCHEMA_VERSION,
        action: "create_thread",
        contractId,
        transport,
        authority,
        candidate,
        testerReceipt: state.tester.receipt,
        nativeTool: {
          sequence: ["list_projects", "create_thread", "accept-release-owner"],
          target: { type: "project", environment: { type: "worktree" } },
        },
        prompt: ownerPrompt("release", state),
        warning:
          "Consume this action once. A rerun fails closed with do-not-create until the exact owner is recorded or pending state is explicitly cancelled.",
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
