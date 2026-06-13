import { randomUUID } from "node:crypto";
import path from "node:path";
import { runGuiBenchmark, type GuiBenchmarkOptions, type GuiBenchmarkResult } from "./benchmark.js";

export type GuiBenchmarkRepeatRun = {
  index: number;
  ok: boolean;
  elapsedSeconds: number;
  actionCount: number;
  reportPath?: string;
  replyTextExtracted: boolean;
  usedClipboard: boolean;
  movedFocus: boolean;
  pointerEvidencePresent: boolean | null;
  pointerEvidencePath?: string;
  codexComputerUseParity: GuiBenchmarkResult["qualityGate"]["codexComputerUseParity"];
  blockers: string[];
};

export type GuiBenchmarkRepeatResult = {
  ok: boolean;
  runtime: GuiBenchmarkOptions["runtime"];
  task: GuiBenchmarkOptions["task"];
  dryRun: boolean;
  totalRuns: number;
  passedRuns: number;
  parityPassedRuns: number;
  failedRuns: number;
  elapsedSecondsRange: { min: number; max: number };
  actionCountRange: { min: number; max: number };
  pointerEvidence: Array<{
    index: number;
    present: boolean | null;
    evidencePath?: string;
  }>;
  blockers: string[];
  runs: GuiBenchmarkRepeatRun[];
};

export type GuiBenchmarkRepeatOptions = GuiBenchmarkOptions & {
  repeat: number;
};

function boundedRepeatCount(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Invalid GUI benchmark repeat count: ${String(value)}`);
  }
  return Math.min(20, Math.trunc(value));
}

function range(values: number[]): { min: number; max: number } {
  if (values.length === 0) {
    return { min: 0, max: 0 };
  }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function repeatReportDir(options: GuiBenchmarkRepeatOptions, repeatId: string, index: number) {
  if (!options.writeReport) {
    return options.reportDir;
  }
  const root = options.reportDir ?? path.join(process.cwd(), "artifacts", "gui-benchmark");
  return path.join(root, `repeat-${repeatId}`, `run-${String(index).padStart(2, "0")}`);
}

function summarizeRun(index: number, result: GuiBenchmarkResult): GuiBenchmarkRepeatRun {
  return {
    index,
    ok: result.ok,
    elapsedSeconds: result.elapsedSeconds,
    actionCount: result.actionCount,
    reportPath: result.reportPath,
    replyTextExtracted: result.replyTextExtracted,
    usedClipboard: result.usedClipboard,
    movedFocus: result.movedFocus,
    pointerEvidencePresent: result.virtualPointer.present,
    pointerEvidencePath: result.virtualPointer.evidencePath,
    codexComputerUseParity: result.qualityGate.codexComputerUseParity,
    blockers: result.qualityGate.blockers,
  };
}

export async function runGuiBenchmarkRepeat(
  options: GuiBenchmarkRepeatOptions,
): Promise<GuiBenchmarkRepeatResult> {
  const repeat = boundedRepeatCount(options.repeat);
  const repeatId = randomUUID().replaceAll("-", "").slice(0, 12);
  const runs: GuiBenchmarkRepeatRun[] = [];

  for (let index = 1; index <= repeat; index += 1) {
    const result = await runGuiBenchmark({
      ...options,
      reportDir: repeatReportDir(options, repeatId, index),
    });
    runs.push(summarizeRun(index, result));
  }

  const passedRuns = runs.filter((run) => run.ok).length;
  const parityPassedRuns = runs.filter((run) => run.codexComputerUseParity === "pass").length;
  const blockers = Array.from(new Set(runs.flatMap((run) => run.blockers)));
  return {
    ok: passedRuns === repeat,
    runtime: options.runtime,
    task: options.task,
    dryRun: Boolean(options.dryRun),
    totalRuns: repeat,
    passedRuns,
    parityPassedRuns,
    failedRuns: repeat - passedRuns,
    elapsedSecondsRange: range(runs.map((run) => run.elapsedSeconds)),
    actionCountRange: range(runs.map((run) => run.actionCount)),
    pointerEvidence: runs.map((run) => ({
      index: run.index,
      present: run.pointerEvidencePresent,
      ...(run.pointerEvidencePath ? { evidencePath: run.pointerEvidencePath } : {}),
    })),
    blockers,
    runs,
  };
}
