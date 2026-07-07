import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

function runWhatsAppMonitorCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerWhatsAppMonitorCli(program: Command) {
  const whatsappMonitor = program
    .command("whatsapp-monitor")
    .description("WhatsApp-as-me durable monitor polling tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw whatsapp-monitor poll --db-path /tmp/wacli.db --cron-store /tmp/cron.json --hook-url http://127.0.0.1:18789/hooks/monitor-event --json",
            "Poll durable goal-bound WhatsApp monitors once and dispatch matched replies through the generic monitor hook.",
          ],
          [
            "openclaw whatsapp-monitor poll --watch --max-runs 3 --db-path /tmp/wacli.db --cron-store /tmp/cron.json --commit-without-dispatch --json",
            "Run a bounded foreground smoke poll while explicitly committing cursors without gateway dispatch.",
          ],
        ])}\n`,
    )
    .action(() => {
      whatsappMonitor.help({ error: true });
    });

  whatsappMonitor
    .command("poll")
    .description("Poll durable goal-bound WhatsApp-as-me monitor cursors once")
    .requiredOption("--db-path <path>", "Path to the local wacli.db SQLite database")
    .option("--cron-store <path>", "Cron store path; monitor/cursor stores default beside it")
    .option("--monitor-store <path>", "Monitor store path; overrides derivation from --cron-store")
    .option("--cursor-store <path>", "Cursor store path; overrides derivation from monitor store")
    .option("--hook-url <url>", "Full local gateway /hooks/monitor-event URL for dispatch")
    .option("--hook-token <token>", "Bearer token for --hook-url")
    .option("--watch", "Keep polling in the foreground until interrupted", false)
    .option("--poll-interval-ms <ms>", "Delay between --watch polls", "1000")
    .option("--max-runs <n>", "Stop --watch after this many polls; intended for smoke tests")
    .option(
      "--commit-without-dispatch",
      "Advance event cursors without dispatching; intended for explicit observe-only maintenance",
      false,
    )
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runWhatsAppMonitorCommand(async () => {
        const { whatsappMonitorPollCommand } = await import("../commands/whatsapp-monitor.js");
        await whatsappMonitorPollCommand(opts, defaultRuntime);
      });
    });
}
