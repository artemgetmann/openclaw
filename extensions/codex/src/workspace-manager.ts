import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodexTaskMode = "analysis" | "implementation";
export type CodexWorkspaceMode = "direct" | "isolated";

export type PrepareWorkspaceRequest = {
  taskMode: CodexTaskMode;
  projectDir?: string;
  workspaceDir?: string;
  workspaceMode?: CodexWorkspaceMode;
  featureName?: string;
};

export type PreparedCodexWorkspace = {
  taskMode: CodexTaskMode;
  workspaceMode: CodexWorkspaceMode;
  projectDir: string;
  workspaceDir: string;
  worktreeCreated: boolean;
  baseSha?: string;
  branch?: string;
  featureName?: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

export type WorkspaceCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

type CodexWorkspaceManagerOptions = {
  defaultWorkspaceDir: string;
  worktreesRoot?: string;
  protectedWorkspaceDirs?: string[];
  run?: WorkspaceCommandRunner;
};

/**
 * Prepares the filesystem boundary for a native Codex thread.
 *
 * Analysis stays on the selected project and remains read-only at the App
 * Server layer. Implementation defaults to a fresh-branch linked worktree so the
 * worker can inspect the repository's own policy before choosing its branch,
 * bootstrap, and PR workflow. Direct implementation is deliberately explicit
 * and rejects protected roots before Codex receives write permission.
 */
export class CodexWorkspaceManager {
  private readonly run: WorkspaceCommandRunner;
  private readonly worktreesRoot: string;
  private readonly protectedWorkspaceDirs: string[];

  constructor(private readonly options: CodexWorkspaceManagerOptions) {
    this.run = options.run ?? runCommand;
    this.worktreesRoot = options.worktreesRoot ?? path.join(os.homedir(), ".codex", "worktrees");
    this.protectedWorkspaceDirs = [
      path.join(os.homedir(), "Programming_Projects", "openclaw"),
      path.join(os.homedir(), "Programming_Projects", "openclaw-consumer"),
      ...(options.protectedWorkspaceDirs ?? []),
    ];
  }

  async prepare(request: PrepareWorkspaceRequest): Promise<PreparedCodexWorkspace> {
    const taskMode = request.taskMode;
    const requestedRoot =
      request.projectDir?.trim() ||
      request.workspaceDir?.trim() ||
      this.options.defaultWorkspaceDir;
    const projectDir = await resolveDirectory(requestedRoot, "project directory");

    // Analysis is intentionally boring: no Git metadata changes, no branch
    // creation, and no hidden workspace migration. The App Server receives the
    // same directory with a read-only sandbox in the service layer.
    if (taskMode === "analysis") {
      return {
        taskMode,
        workspaceMode: "direct",
        projectDir,
        workspaceDir: projectDir,
        worktreeCreated: false,
      };
    }

    const workspaceMode = request.workspaceMode ?? "isolated";
    if (workspaceMode === "direct") {
      await this.assertSafeDirectWorkspace(projectDir);
      return {
        taskMode,
        workspaceMode,
        projectDir,
        workspaceDir: projectDir,
        worktreeCreated: false,
        featureName: normalizeFeatureName(request.featureName),
      };
    }

    return await this.createIsolatedWorktree(projectDir, request.featureName);
  }

  /**
   * Reclaims only a worktree created for a delegation that never reached a
   * native thread. This is deliberately narrower than general worktree GC:
   * a started task belongs to its Codex thread and must remain inspectable.
   */
  async discard(prepared: PreparedCodexWorkspace): Promise<void> {
    if (!prepared.worktreeCreated || prepared.workspaceMode !== "isolated") {
      return;
    }
    const relativeWorkspace = path.relative(this.worktreesRoot, prepared.workspaceDir);
    if (
      !relativeWorkspace ||
      relativeWorkspace.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeWorkspace)
    ) {
      throw new Error("refusing to discard a Codex worktree outside the configured root");
    }
    await this.git(prepared.projectDir, ["worktree", "remove", "--force", prepared.workspaceDir]);
    // Git removes the worktree itself but leaves the invocation-specific task
    // parent. It is safe to remove because the manager always created it with
    // mkdtemp and the worktree was its only child.
    await rm(path.dirname(prepared.workspaceDir), { recursive: true, force: true });
  }

  private async assertSafeDirectWorkspace(projectDir: string): Promise<void> {
    const gitRoot = await this.gitRoot(projectDir);
    if (await this.isProtected(gitRoot)) {
      throw new Error(
        `refusing direct Codex writes in protected checkout: ${gitRoot}. Use an isolated worktree.`,
      );
    }

    // Direct write mode is an expert override. Requiring a named branch and a
    // clean tree prevents it from silently mixing Codex edits with detached or
    // pre-existing human work.
    const branch = (await this.git(gitRoot, ["branch", "--show-current"])).trim();
    if (!branch) {
      throw new Error("refusing direct Codex writes on a detached HEAD");
    }
    await this.assertClean(gitRoot, "direct workspace");
  }

  private async createIsolatedWorktree(
    requestedProjectDir: string,
    featureName?: string,
  ): Promise<PreparedCodexWorkspace> {
    const projectDir = await this.gitRoot(requestedProjectDir);
    await this.assertClean(projectDir, "source project");

    const baseSha = (await this.git(projectDir, ["rev-parse", "HEAD"])).trim();
    const normalizedFeature = normalizeFeatureName(featureName) ?? "codex-task";
    const uniqueFeature = `${normalizedFeature}-${randomUUID().slice(0, 8)}`;
    const branch = `codex/${uniqueFeature}`;
    await mkdir(this.worktreesRoot, { recursive: true });

    // mkdtemp supplies collision resistance without requiring a shared registry.
    // Keep the repository basename as the final component so Codex and humans
    // can still identify the project in thread/fleet metadata.
    const taskRoot = await mkdtemp(path.join(this.worktreesRoot, `jarvis-${uniqueFeature}-`));
    const workspaceDir = path.join(taskRoot, path.basename(projectDir));
    try {
      await this.git(projectDir, ["worktree", "add", "-b", branch, workspaceDir, baseSha]);
    } catch (error) {
      // Only remove the directory created by this invocation. Git worktree
      // metadata is not registered when `worktree add` fails, so this cannot
      // delete an existing lane.
      await rm(taskRoot, { recursive: true, force: true });
      throw new Error(`failed to create isolated Codex worktree: ${formatError(error)}`);
    }

    return {
      taskMode: "implementation",
      workspaceMode: "isolated",
      projectDir,
      workspaceDir,
      worktreeCreated: true,
      baseSha,
      branch,
      featureName: uniqueFeature,
    };
  }

  private async assertClean(projectDir: string, label: string): Promise<void> {
    const status = await this.git(projectDir, ["status", "--porcelain"]);
    if (status.trim()) {
      throw new Error(`refusing Codex handoff because the ${label} has local changes`);
    }
  }

  private async gitRoot(projectDir: string): Promise<string> {
    const root = (await this.git(projectDir, ["rev-parse", "--show-toplevel"])).trim();
    return await resolveDirectory(root, "Git project root");
  }

  private async git(projectDir: string, args: string[]): Promise<string> {
    try {
      return (await this.run("git", ["-C", projectDir, ...args])).stdout;
    } catch (error) {
      throw new Error(`Git ${args[0] ?? "command"} failed: ${formatError(error)}`);
    }
  }

  private async isProtected(projectDir: string): Promise<boolean> {
    for (const configuredDir of this.protectedWorkspaceDirs) {
      try {
        if ((await realpath(configuredDir)) === projectDir) {
          return true;
        }
      } catch {
        // A configured protection path that does not exist cannot match the
        // resolved project. Other configured roots still need checking.
      }
    }
    return false;
  }
}

async function resolveDirectory(value: string, label: string): Promise<string> {
  const candidate = value.trim();
  if (!candidate) {
    throw new Error(`${label} is required`);
  }
  try {
    const resolved = await realpath(candidate);
    await access(resolved);
    return resolved;
  } catch {
    throw new Error(`${label} is not an accessible directory: ${candidate}`);
  }
}

function normalizeFeatureName(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || undefined;
}

async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string }).stderr?.trim();
    return stderr || error.message;
  }
  return String(error);
}
