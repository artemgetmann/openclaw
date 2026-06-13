import type { Command } from "commander";
import { runGuiBenchmarkRepeat } from "../gui-control/benchmark-repeat.js";
import { runGuiBenchmark, type GuiBenchmarkTask } from "../gui-control/benchmark.js";
import type { GuiRuntimeName } from "../gui-control/types.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

function parseRuntime(value: string): GuiRuntimeName {
  if (value === "agent-desktop" || value === "open-computer-use") {
    return value;
  }
  throw new Error(`Unsupported GUI runtime: ${value}`);
}

function parseTask(value: string): GuiBenchmarkTask {
  if (value === "x-to-claude" || value === "safari-notes-claude") {
    return value;
  }
  throw new Error(`Unsupported GUI benchmark task: ${value}`);
}

function parsePositiveIntegerOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return Math.trunc(parsed);
}

export function registerGuiBenchmarkCli(program: Command) {
  program
    .command("gui-benchmark")
    .description("Experimental dev-only Jarvis GUI-control benchmark harness")
    .requiredOption("--runtime <runtime>", "Runtime adapter: agent-desktop, open-computer-use")
    .requiredOption("--task <task>", "Benchmark task: x-to-claude, safari-notes-claude")
    .option("--dry-run", "Simulate the benchmark without touching real apps", false)
    .option("--write-report", "Write structured JSON report under artifacts/gui-benchmark", false)
    .option("--report-dir <path>", "Directory for --write-report output")
    .option("--json", "Print structured JSON instead of markdown", false)
    .option(
      "--approve-claude-send",
      "Allow the labelled benchmark message to be sent to Claude",
      false,
    )
    .option(
      "--approve-notes-write",
      "Allow the labelled benchmark content to be written to Apple Notes",
      false,
    )
    .option(
      "--open-x-home",
      "Open https://x.com/home in Safari before resolving the exact benchmark window",
      false,
    )
    .option(
      "--require-codex-parity",
      "Exit nonzero unless the benchmark passes the Codex Computer Use parity gate",
      false,
    )
    .option("--no-clipboard-fallback", "Disable clipboard-based Claude reply extraction fallback")
    .option("--repeat <count>", "Run the benchmark repeatedly and print an aggregate report")
    .option("--claude-input-ref <ref>", "Claude composer element ref from a fresh snapshot")
    .option("--reply-extraction-timeout-ms <ms>", "How long to wait for Claude reply extraction")
    .option("--reply-extraction-interval-ms <ms>", "Polling interval for Claude reply extraction")
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const benchmarkOptions = {
          runtime: parseRuntime(String(opts.runtime)),
          task: parseTask(String(opts.task)),
          dryRun: Boolean(opts.dryRun),
          writeReport: Boolean(opts.writeReport),
          reportDir: typeof opts.reportDir === "string" ? opts.reportDir : undefined,
          approveClaudeSend: Boolean(opts.approveClaudeSend),
          approveNotesWrite: Boolean(opts.approveNotesWrite),
          openXHome: Boolean(opts.openXHome),
          allowClipboardFallback: opts.requireCodexParity
            ? false
            : opts.clipboardFallback !== false,
          claudeInputRef: typeof opts.claudeInputRef === "string" ? opts.claudeInputRef : undefined,
          replyExtractionTimeoutMs: parsePositiveIntegerOption(
            opts.replyExtractionTimeoutMs,
            "--reply-extraction-timeout-ms",
          ),
          replyExtractionIntervalMs: parsePositiveIntegerOption(
            opts.replyExtractionIntervalMs,
            "--reply-extraction-interval-ms",
          ),
          progress: (message: string) => defaultRuntime.error(message),
        };
        const repeat = parsePositiveIntegerOption(opts.repeat, "--repeat") ?? 1;
        if (repeat < 1) {
          throw new Error(`Invalid --repeat value: ${opts.repeat}`);
        }
        if (repeat > 1) {
          const result = await runGuiBenchmarkRepeat({ ...benchmarkOptions, repeat });
          defaultRuntime.log(opts.json ? JSON.stringify(result, null, 2) : JSON.stringify(result));
          const passed = opts.requireCodexParity
            ? result.parityPassedRuns === result.totalRuns
            : result.ok;
          defaultRuntime.exit(passed ? 0 : 1);
          return;
        }

        const result = await runGuiBenchmark(benchmarkOptions);
        defaultRuntime.log(opts.json ? JSON.stringify(result, null, 2) : result.markdownSummary);
        const passed = opts.requireCodexParity
          ? result.qualityGate.onParWithCodexComputerUse === true
          : result.ok;
        defaultRuntime.exit(passed ? 0 : 1);
      });
    });
}
