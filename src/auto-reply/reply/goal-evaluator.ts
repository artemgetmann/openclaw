import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { SessionGoal, SessionGoalEvaluatorVerdict } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";

const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_CHARS = 2_000;
const JUDGE_TIMEOUT_MS = 60_000;
const CONTROL_ONLY_TOOLS = new Set(["create_goal", "get_goal", "update_goal", "update_plan"]);
const VERDICTS = new Set<SessionGoalEvaluatorVerdict>([
  "satisfied",
  "needs_revision",
  "needs_input",
  "approval_required",
  "goal_blocked",
]);

export type GoalEvaluatorVerdict = {
  verdict: SessionGoalEvaluatorVerdict;
  reason: string;
  evidence: string[];
  materialProgress: boolean;
  blockerKey?: string;
  question?: string;
};

export type GoalEvaluatorResult =
  | { kind: "evaluated"; result: GoalEvaluatorVerdict }
  | { kind: "unsupported_provider"; provider: string }
  | { kind: "failed"; reason: string };

type GoalEvaluatorRun = Pick<
  FollowupRun["run"],
  | "agentDir"
  | "authProfileId"
  | "authProfileIdSource"
  | "config"
  | "model"
  | "provider"
  | "timeoutMs"
>;

function normalizeText(value: unknown, maxChars = MAX_EVIDENCE_CHARS): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

/**
 * Build the judge's evidence packet from runtime-owned facts, never from a
 * second agent's ambient session history. This keeps the judge independent and
 * makes missing proof visible instead of silently treating confident prose as proof.
 */
export function collectGoalEvaluationEvidence(params: {
  payloads: ReplyPayload[];
  transcriptMessages?: unknown[];
  messagingToolSentTexts?: string[];
  messagingToolSentTargets?: Array<{ provider?: string; to?: string }>;
}): string[] {
  const evidence: string[] = [];
  for (const message of params.transcriptMessages ?? []) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "toolResult" && record.role !== "tool") {
      continue;
    }
    const toolName = normalizeText(record.toolName ?? record.name, 120) ?? "unknown_tool";
    if (CONTROL_ONLY_TOOLS.has(toolName)) {
      continue;
    }
    const content = record.content;
    const text =
      normalizeText(content) ??
      (Array.isArray(content)
        ? content
            .map((block) =>
              block && typeof block === "object"
                ? normalizeText((block as Record<string, unknown>).text)
                : undefined,
            )
            .filter((value): value is string => Boolean(value))
            .join("\n")
        : undefined);
    if (text) {
      evidence.push(
        record.isError === true
          ? `runtime_error: ${toolName} failed: ${text.slice(0, MAX_EVIDENCE_CHARS)}`
          : `tool_result:${toolName}: ${text.slice(0, MAX_EVIDENCE_CHARS)}`,
      );
    }
  }
  for (const payload of params.payloads) {
    const text = normalizeText(payload.text);
    if (text) {
      evidence.push(`assistant_final: ${text}`);
    }
    if (payload.isError) {
      evidence.push("runtime_error: final payload was marked as an error");
    }
  }
  for (const text of params.messagingToolSentTexts ?? []) {
    const normalized = normalizeText(text);
    if (normalized) {
      evidence.push(`verified_message_send_text: ${normalized}`);
    }
  }
  for (const target of params.messagingToolSentTargets ?? []) {
    const provider = normalizeText(target.provider, 80) ?? "unknown";
    const to = normalizeText(target.to, 200) ?? "unknown";
    evidence.push(`verified_message_send_target: ${provider}:${to}`);
  }
  return [...new Set(evidence)].slice(0, MAX_EVIDENCE_ITEMS);
}

function buildJudgePrompt(params: { goal: SessionGoal; evidence: string[] }): string {
  const autonomy = params.goal.autonomy ?? { level: "observe_only" as const };
  return [
    "You are an independent post-turn goal evaluator. You have no tools and no authority to act.",
    "Judge only the supplied objective, persisted claim, authority boundaries, and runtime-owned evidence.",
    "Do not trust confidence, promises, or a completion claim as proof. Missing proof means needs_revision.",
    "Use needs_input only for one concrete user decision. Use approval_required when the next action crosses an approval boundary.",
    "Use goal_blocked only for a genuine dependency requiring user input or external-state change; include a stable blocker_key and set material_progress=false. Core policy, not you, enforces the repeated-blocker threshold.",
    "Return exactly one JSON object with keys: verdict, reason, evidence, material_progress, and optional blocker_key or question.",
    `Allowed verdicts: ${[...VERDICTS].join(", ")}.`,
    "Evidence must be a non-empty array containing exact strings copied from the supplied evidence packet.",
    "",
    `Objective: ${params.goal.objective}`,
    `Claim: ${JSON.stringify(params.goal.pendingEvaluation)}`,
    `Autonomy: ${JSON.stringify(autonomy)}`,
    `Evidence packet: ${JSON.stringify(params.evidence)}`,
  ].join("\n");
}

function parseJudgeResult(text: string, allowedEvidence: string[]): GoalEvaluatorVerdict {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const raw = JSON.parse(jsonText) as Record<string, unknown>;
  const verdict = normalizeText(raw.verdict, 80) as SessionGoalEvaluatorVerdict | undefined;
  const reason = normalizeText(raw.reason, 500);
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .map((value) => normalizeText(value, 500))
        .filter((value): value is string => Boolean(value))
        .slice(0, 8)
    : [];
  const materialProgress = raw.material_progress;
  const blockerKey = normalizeText(raw.blocker_key, 500);
  const question = normalizeText(raw.question, 500);
  if (!verdict || !VERDICTS.has(verdict) || !reason || evidence.length === 0) {
    throw new Error("judge returned an invalid typed verdict");
  }
  const allowed = new Set(allowedEvidence);
  if (evidence.some((item) => !allowed.has(item))) {
    throw new Error("judge cited evidence outside the runtime-owned packet");
  }
  if (typeof materialProgress !== "boolean") {
    throw new Error("judge omitted material_progress");
  }
  if (verdict === "goal_blocked" && (!blockerKey || materialProgress)) {
    throw new Error("goal_blocked requires blocker_key and material_progress=false");
  }
  if ((verdict === "needs_input" || verdict === "approval_required") && !question) {
    throw new Error(`${verdict} requires one concrete question`);
  }
  return {
    verdict,
    reason,
    evidence,
    materialProgress,
    ...(blockerKey ? { blockerKey } : {}),
    ...(question ? { question } : {}),
  };
}

export async function runIndependentGoalEvaluator(params: {
  goal: SessionGoal;
  run: GoalEvaluatorRun;
  evidence: string[];
  workingTurnAborted?: boolean;
  deterministicApprovalPromptSent?: boolean;
}): Promise<GoalEvaluatorResult> {
  if (!params.goal.pendingEvaluation) {
    return { kind: "failed", reason: "goal has no pending evaluation claim" };
  }

  // Deterministic runtime facts outrank another model call. An aborted/error
  // turn cannot prove completion, and an already-issued approval prompt must
  // remain an approval gate rather than being reinterpreted by a grader.
  if (
    params.workingTurnAborted ||
    params.evidence.some((item) => item.startsWith("runtime_error:"))
  ) {
    return {
      kind: "evaluated",
      result: {
        verdict: "needs_revision",
        reason: "The working turn ended without reliable completion proof.",
        evidence: params.evidence.length > 0 ? params.evidence : ["working turn aborted"],
        materialProgress: false,
      },
    };
  }
  if (params.deterministicApprovalPromptSent) {
    return {
      kind: "evaluated",
      result: {
        verdict: "approval_required",
        reason: "The working turn reached an existing approval boundary.",
        evidence: ["runtime emitted a deterministic approval prompt"],
        materialProgress: false,
        question: "Do you approve the exact pending action described above?",
      },
    };
  }
  if (params.evidence.length === 0) {
    return {
      kind: "evaluated",
      result: {
        verdict: "needs_revision",
        reason: "No runtime-owned evidence was available to verify the claim.",
        evidence: ["evidence packet was empty"],
        materialProgress: false,
      },
    };
  }
  if (isCliProvider(params.run.provider, params.run.config)) {
    return { kind: "unsupported_provider", provider: params.run.provider };
  }

  const judgeId = crypto.randomUUID();
  // Use a private OS-created directory rather than interpolating identifiers
  // into the shared temp root. The judge remains isolated even if another
  // local process can observe or race entries in that root.
  const judgeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-goal-judge-"));
  const sessionFile = path.join(judgeDir, "session.jsonl");
  try {
    const result = await runEmbeddedPiAgent({
      sessionId: judgeId,
      sessionFile,
      workspaceDir: judgeDir,
      agentDir: params.run.agentDir,
      config: params.run.config,
      prompt: buildJudgePrompt({ goal: params.goal, evidence: params.evidence }),
      disableTools: true,
      disableHooks: true,
      bootstrapContextMode: "lightweight",
      provider: params.run.provider,
      model: params.run.model,
      authProfileId: params.run.authProfileId,
      authProfileIdSource: params.run.authProfileIdSource,
      timeoutMs: Math.min(params.run.timeoutMs, JUDGE_TIMEOUT_MS),
      runId: judgeId,
    });
    if (result.meta.aborted || result.meta.error) {
      return { kind: "failed", reason: "independent evaluator did not complete" };
    }
    const output = result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n");
    if (!output) {
      return { kind: "failed", reason: "independent evaluator returned no verdict" };
    }
    return { kind: "evaluated", result: parseJudgeResult(output, params.evidence) };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "independent evaluator failed",
    };
  } finally {
    // The judge is deliberately stateless. Removing its isolated transcript
    // prevents a later evaluation from inheriting context or authority.
    await fs.promises.rm(judgeDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function formatGoalRevisionPrompt(result: GoalEvaluatorVerdict): string {
  return [
    "The independent goal evaluator returned needs_revision.",
    `Reason: ${result.reason}`,
    `Evidence inspected: ${result.evidence.join("; ")}`,
    "Continue the same goal within existing authority. Gather concrete proof, then request evaluation again. Do not claim completion without evidence.",
  ].join("\n");
}
