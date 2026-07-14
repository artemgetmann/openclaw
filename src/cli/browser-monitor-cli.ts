import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerBrowserMonitorCli(program: Command) {
  const browserMonitor = program
    .command("browser-monitor")
    .description("Opt-in browser page reply observer")
    .action(() => browserMonitor.help({ error: true }));

  browserMonitor
    .command("observe")
    .description("Observe one approved selector in one selected browser tab")
    .requiredOption("--browser-profile <name>", "Browser profile name")
    .requiredOption("--target-id <id>", "Exact browser tab target id")
    .requiredOption("--url-pattern <url>", "Approved absolute URL; path globs are allowed")
    .requiredOption("--selector <selector>", "Exact DOM selector to read")
    .requiredOption("--match-mode <mode>", "Text match mode: exact|contains")
    .requiredOption("--match-value <value>", "Text that constitutes a reply")
    .requiredOption("--monitor-id <id>", "Existing durable monitor to wake")
    .requiredOption(
      "--hook-url <url>",
      "Loopback gateway /hooks/monitor-event URL (auth: OPENCLAW_HOOKS_TOKEN)",
    )
    .option("--browser-url <url>", "Browser control base URL")
    .option("--cursor-store <path>", "Durable hash-only cursor store path")
    .option("--watch", "Keep polling until interrupted", false)
    .option("--poll-interval-ms <ms>", "Delay between watch polls", "2000")
    .option("--max-runs <n>", "Stop watch mode after this many polls")
    .addHelpText(
      "after",
      "\nEnvironment:\n  OPENCLAW_HOOKS_TOKEN  Dedicated hooks.token bearer secret (never accepted as a CLI argument).\n",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { browserReplyObserveCommand } =
            await import("../browser/reply-monitor-command.js");
          // The root CLI reserves --profile for runtime isolation, so translate the
          // non-conflicting browser flag back to the observer's existing config field.
          const { browserProfile, ...observerOpts } = opts;
          await browserReplyObserveCommand(
            { ...observerOpts, profile: browserProfile },
            defaultRuntime,
          );
        },
        (err) => {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        },
      );
    });
}
