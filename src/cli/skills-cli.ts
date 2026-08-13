import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  getPersonalSkillVisibilityStatus,
  runWithTemporaryCodexSkill,
  setPersonalSkillVisibility,
  type PersonalSkillVisibility,
} from "../agents/skills/personal-skill-runtime.js";
import { syncBundledSkillsToSharedPersonalRoot } from "../agents/skills/shared-personal-mirror.js";
import { rollbackSharedPersonalSkillsManagedRoot } from "../commands/onboard-shared-skills-rollback.js";
import { ensureSharedPersonalSkillsManagedRoot } from "../commands/onboard-shared-skills-root.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
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

function personalRuntimePaths(config?: ReturnType<typeof loadConfig>) {
  const homeDir = process.env.HOME?.trim() || os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  return {
    homeDir,
    stateDir: resolveStateDir(process.env, () => homeDir),
    codexConfigPath: path.join(codexHome, "config.toml"),
    workspaceDir: config
      ? resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config))
      : undefined,
  };
}

function isPersonalSkillVisibility(value: string): value is PersonalSkillVisibility {
  return value === "shared" || value === "codex" || value === "jarvis";
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

  const personalRuntime = skills
    .command("runtime")
    .description("Manage personal skill visibility across Codex and Jarvis");

  personalRuntime
    .command("status")
    .description("Show whether one canonical personal skill is shared, Codex-only, or Jarvis-only")
    .argument("<name>", "Canonical personal skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const result = getPersonalSkillVisibilityStatus({
          name,
          config,
          ...personalRuntimePaths(config),
        });
        defaultRuntime.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : `${result.name}: ${result.visibility} (canonical: ${result.skillFile})`,
        );
      } catch (err) {
        defaultRuntime.error(`Personal skill visibility failed: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });

  personalRuntime
    .command("set")
    .description("Set one canonical personal skill to shared, Codex-only, or Jarvis-only")
    .argument("<name>", "Canonical personal skill name")
    .argument("<visibility>", "shared, codex, or jarvis")
    .option("--json", "Output as JSON", false)
    .action(async (name: string, visibility: string, opts: { json?: boolean }) => {
      try {
        if (!isPersonalSkillVisibility(visibility)) {
          throw new Error(`invalid visibility: ${visibility}`);
        }
        const config = loadConfig();
        const result = await setPersonalSkillVisibility(name, visibility, {
          config,
          writeJarvisConfig: writeConfigFile,
          ...personalRuntimePaths(config),
        });
        defaultRuntime.log(
          opts.json ? JSON.stringify(result, null, 2) : `${result.name}: ${result.visibility}`,
        );
      } catch (err) {
        defaultRuntime.error(`Personal skill visibility failed: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });

  personalRuntime
    .command("reconcile")
    .description("Adopt the canonical personal skill root and write a recovery receipt")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = ensureSharedPersonalSkillsManagedRoot(personalRuntimePaths());
        defaultRuntime.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : [
                `Personal skills root: ${result.status}`,
                result.message,
                result.receiptPath ? `Receipt: ${result.receiptPath}` : undefined,
              ]
                .filter((line): line is string => Boolean(line))
                .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(`Personal skill reconciliation failed: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });

  personalRuntime
    .command("rollback")
    .description("Restore a legacy managed root from one exact migration receipt")
    .argument("<receipt>", "Migration receipt path")
    .option("--json", "Output as JSON", false)
    .action(async (receipt: string, opts: { json?: boolean }) => {
      try {
        const result = rollbackSharedPersonalSkillsManagedRoot(receipt, personalRuntimePaths());
        defaultRuntime.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : `${result.status}: ${result.message ?? "legacy managed root restored"}`,
        );
      } catch (err) {
        defaultRuntime.error(`Personal skill rollback failed: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });

  personalRuntime
    .command("with")
    .description("Temporarily expose one personal skill to a child runtime")
    .argument("<runtime>", "Currently only codex")
    .argument("<name>", "Canonical personal skill name")
    .argument("[args...]", "Arguments passed to the child runtime")
    .allowUnknownOption(true)
    .action(async (runtime: string, name: string, args: string[]) => {
      try {
        if (runtime !== "codex") {
          throw new Error(`unsupported temporary runtime: ${runtime}`);
        }
        const config = loadConfig();
        const exitCode = runWithTemporaryCodexSkill({
          name,
          args,
          ...personalRuntimePaths(config),
        });
        if (exitCode !== 0) {
          defaultRuntime.exit(exitCode);
        }
      } catch (err) {
        defaultRuntime.error(`Temporary personal skill injection failed: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    await runSkillsAction((report) => formatSkillsList(report, {}));
  });
}
