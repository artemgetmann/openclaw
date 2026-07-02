import type { Command } from "commander";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";
import {
  registerScreenRecordCallOptions,
  runScreenRecordCommand,
  type ScreenRecordCliOpts,
} from "./screen-record.js";

export function registerScreenCli(program: Command) {
  const screen = program
    .command("screen")
    .description("Capture target-aware screen recordings")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw screen record --app Telegram --duration 60s", "Record the Telegram window."],
          [
            "openclaw screen record --bundle com.google.Chrome --duration 90s --out .artifacts/browser.mp4",
            "Record the Chrome window to a review artifact.",
          ],
          [
            'openclaw screen record --display 0 --reason "workflow switches apps"',
            "Record a full display only when window targeting cannot prove the flow.",
          ],
        ])}\n`,
    );

  registerScreenRecordCallOptions(
    screen
      .command("record")
      .description("Capture a short MP4 recording from a target app, window, or display")
      .option(
        "--node <idOrNameOrIp>",
        "Node id, name, or IP (defaults to the only connected Mac node)",
      )
      .option("--app <name>", "Record the best visible window owned by this app name")
      .option("--bundle <id>", "Record the best visible window owned by this bundle id")
      .option("--window-id <id>", "Record a specific CoreGraphics window id")
      .option("--display <index>", "Record a full display; requires --reason")
      .option("--reason <text>", "Why full-display capture is necessary")
      .option("--duration <ms|10s>", "Clip duration", "30000")
      .option("--fps <fps>", "Frames per second", "12")
      .option("--audio", "Include microphone audio", false)
      .option("--out <path>", "Output path")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 180000)", "180000")
      .action(async (opts: ScreenRecordCliOpts) => {
        await runScreenRecordCommand("record", opts, {
          requireTarget: true,
          requireDisplayReason: true,
        });
      }),
  );
}
