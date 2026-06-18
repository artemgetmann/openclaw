import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuiBenchmarkRepeat } from "./benchmark-repeat.js";

describe("runGuiBenchmarkRepeat", () => {
  it("runs a dry benchmark repeatedly and writes one report per run", async () => {
    const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gui-repeat-"));

    try {
      const result = await runGuiBenchmarkRepeat({
        runtime: "agent-desktop",
        task: "x-to-claude",
        dryRun: true,
        repeat: 3,
        writeReport: true,
        reportDir,
      });

      expect(result.ok).toBe(true);
      expect(result.totalRuns).toBe(3);
      expect(result.passedRuns).toBe(3);
      expect(result.failedRuns).toBe(0);
      expect(result.parityPassedRuns).toBe(0);
      expect(result.elapsedSecondsRange.max).toBeGreaterThanOrEqual(result.elapsedSecondsRange.min);
      expect(result.actionCountRange).toEqual({ min: 2, max: 2 });
      expect(result.blockers).toEqual([
        "Dry-run does not measure real desktop latency, focus, pointer, or reply UI.",
      ]);
      expect(result.runs).toHaveLength(3);
      expect(new Set(result.runs.map((run) => run.reportPath)).size).toBe(3);
      expect(result.runs.map((run) => run.codexComputerUseParity)).toEqual([
        "not-measured",
        "not-measured",
        "not-measured",
      ]);

      for (const run of result.runs) {
        expect(run.ok).toBe(true);
        expect(run.replyTextExtracted).toBe(true);
        expect(run.usedClipboard).toBe(false);
        expect(run.reportPath).toBeTruthy();
        const stat = await fs.stat(run.reportPath ?? "");
        expect(stat.isFile()).toBe(true);
      }
    } finally {
      await fs.rm(reportDir, { recursive: true, force: true });
    }
  });
});
