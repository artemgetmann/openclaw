import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function runMediaCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerMediaCli(program: Command) {
  const media = program
    .command("media")
    .description("Generic local media tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw media transcribe /tmp/voice.oga --json",
            "Transcribe a local audio file with the configured media audio provider.",
          ],
          [
            "openclaw media transcribe --file /tmp/voice.oga --json",
            "Agent-safe equivalent when the command policy guards path-like positionals.",
          ],
        ])}\n`,
    )
    .action(() => {
      media.help({ error: true });
    });

  media
    .command("transcribe")
    .description("Transcribe a local audio file with configured media audio models")
    .argument("[file]", "Audio file path")
    .option("--file <path>", "Audio file path; useful when positional paths are policy-guarded")
    .option("--mime <mime>", "Optional media MIME type hint")
    .option("--agent-dir <path>", "Agent directory for model auth lookup")
    .option("--json", "Output JSON", false)
    .action(async (file: string | undefined, opts) => {
      await runMediaCommand(async () => {
        const { mediaTranscribeCommand } = await import("../commands/media.js");
        await mediaTranscribeCommand(file, opts, defaultRuntime);
      });
    });
}
