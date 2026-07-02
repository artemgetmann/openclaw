import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { syncBundledSkillsToSharedPersonalRoot } from "../agents/skills/shared-personal-mirror.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;

async function loadSkillsStatusReport(): Promise<SkillStatusReport> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config });
}

async function runSkillsAction(render: (report: SkillStatusReport) => string): Promise<void> {
  try {
    const report = await loadSkillsStatusReport();
    defaultRuntime.log(render(report));
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

function formatSyncSharedResult(
  result: Awaited<ReturnType<typeof syncBundledSkillsToSharedPersonalRoot>>,
): string {
  const counts = new Map<string, number>();
  for (const entry of result.entries) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }
  const changed = result.entries.filter((entry) =>
    ["copied", "updated", "forced", "adopted", "removed"].includes(entry.status),
  );
  const conflicts = result.entries.filter((entry) => entry.status === "skipped-local");
  const failed = result.entries.filter(
    (entry) => entry.status === "failed" || entry.status === "missing-source",
  );

  const lines = [
    `Shared skills root: ${result.targetDir}`,
    result.sourceDir ? `Bundled skills root: ${result.sourceDir}` : undefined,
    `Synced bundled skills: ${changed.length} changed, ${counts.get("current") ?? 0} current, ${conflicts.length} local override(s), ${failed.length} failed.`,
  ].filter((line): line is string => Boolean(line));

  if (conflicts.length > 0) {
    lines.push(
      `Local overrides skipped: ${conflicts
        .slice(0, 10)
        .map((entry) => entry.name)
        .join(", ")}${conflicts.length > 10 ? ", ..." : ""}`,
    );
    lines.push(
      "To overwrite a skipped local override with the bundled copy, rerun with `openclaw skills sync-shared --force <skill-name>`.",
    );
  }
  if (failed.length > 0) {
    lines.push(
      `Failed: ${failed
        .slice(0, 10)
        .map((entry) => entry.name)
        .join(", ")}${failed.length > 10 ? ", ..." : ""}`,
    );
  }
  return lines.join("\n");
}

function collectForceSkillName(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsList(report, opts));
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts));
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts));
    });

  skills
    .command("sync-shared")
    .description("Mirror bundled skills into ~/.agents/skills for Codex/Jarvis sharing")
    .option("--json", "Output as JSON", false)
    .option(
      "--force <skill>",
      "Overwrite one named local override with the bundled skill mirror; repeat for multiple skills",
      collectForceSkillName,
      [],
    )
    .action(async (opts) => {
      try {
        const result = await syncBundledSkillsToSharedPersonalRoot({
          forceSkillNames: opts.force,
        });
        defaultRuntime.log(
          opts.json ? JSON.stringify(result, null, 2) : formatSyncSharedResult(result),
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
