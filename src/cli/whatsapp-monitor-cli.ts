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
          [
            "openclaw whatsapp-monitor monitor-service install --db-path /tmp/wacli.db --hook-url http://127.0.0.1:18789/hooks/monitor-event",
            "Install the foreground WhatsApp monitor poller as an opt-in supervised service.",
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

  const monitorService = whatsappMonitor
    .command("monitor-service")
    .description("Install and manage the WhatsApp-as-me monitor poller service");

  monitorService
    .command("status")
    .description("Show WhatsApp monitor service status")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runWhatsAppMonitorCommand(async () => {
        const { runWhatsAppMonitorServiceStatus } = await import("./whatsapp-monitor-service.js");
        await runWhatsAppMonitorServiceStatus(opts);
      });
    });

  monitorService
    .command("install")
    .description("Install the WhatsApp monitor poller service (launchd/systemd)")
    .requiredOption("--db-path <path>", "Path to the local wacli.db SQLite database")
    .option("--cron-store <path>", "Cron store path; monitor/cursor stores default beside it")
    .option("--monitor-store <path>", "Monitor store path; overrides derivation from --cron-store")
    .option("--cursor-store <path>", "Cursor store path; overrides derivation from monitor store")
    .option("--hook-url <url>", "Gateway /hooks/monitor-event URL for dispatching matched events")
    .option("--poll-interval-ms <ms>", "Delay between poll runs", "1000")
    .option("--runtime <runtime>", "Service runtime (node|bun). Default: node")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runWhatsAppMonitorCommand(async () => {
        const { runWhatsAppMonitorServiceInstall } = await import("./whatsapp-monitor-service.js");
        await runWhatsAppMonitorServiceInstall(opts);
      });
    });

  monitorService
    .command("uninstall")
    .description("Uninstall the WhatsApp monitor poller service")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runWhatsAppMonitorCommand(async () => {
        const { runWhatsAppMonitorServiceUninstall } =
          await import("./whatsapp-monitor-service.js");
        await runWhatsAppMonitorServiceUninstall(opts);
      });
    });

  monitorService
    .command("stop")
    .description("Stop the WhatsApp monitor poller service")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runWhatsAppMonitorCommand(async () => {
        const { runWhatsAppMonitorServiceStop } = await import("./whatsapp-monitor-service.js");
        await runWhatsAppMonitorServiceStop(opts);
      });
    });

  monitorService
    .command("restart")
    .description("Restart the WhatsApp monitor poller service")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runWhatsAppMonitorCommand(async () => {
        const { runWhatsAppMonitorServiceRestart } = await import("./whatsapp-monitor-service.js");
        await runWhatsAppMonitorServiceRestart(opts);
      });
    });
}
