import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CodexWorkspaceManager } from "./workspace-manager.js";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("CodexWorkspaceManager", () => {
  it("keeps analysis in the selected project without changing Git state", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "codex-analysis-"));
    cleanupRoots.push(fixture);
    const manager = new CodexWorkspaceManager({
      defaultWorkspaceDir: fixture,
      worktreesRoot: path.join(fixture, "worktrees"),
      protectedWorkspaceDirs: [],
    });
    const resolvedFixture = await realpath(fixture);

    await expect(
      manager.prepare({
        taskMode: "analysis",
        projectDir: fixture,
      }),
    ).resolves.toEqual({
      taskMode: "analysis",
      workspaceMode: "direct",
      projectDir: resolvedFixture,
      workspaceDir: resolvedFixture,
      worktreeCreated: false,
    });
  });

  it("creates a fresh-branch generic linked worktree for implementation", async () => {
    const fixture = await createGitFixture();
    const worktreesRoot = path.join(fixture.root, "worktrees");
    const manager = new CodexWorkspaceManager({
      defaultWorkspaceDir: fixture.repo,
      worktreesRoot,
      protectedWorkspaceDirs: [],
    });

    const prepared = await manager.prepare({
      taskMode: "implementation",
      projectDir: fixture.repo,
      featureName: "Fix browser login",
    });
    const resolvedRepo = await realpath(fixture.repo);

    expect(prepared).toMatchObject({
      taskMode: "implementation",
      workspaceMode: "isolated",
      projectDir: resolvedRepo,
      worktreeCreated: true,
      baseSha: fixture.head,
      featureName: expect.stringMatching(/^fix-browser-login-[0-9a-f]{8}$/),
      branch: expect.stringMatching(/^codex\/fix-browser-login-[0-9a-f]{8}$/),
    });
    await expect(git(prepared.workspaceDir, ["rev-parse", "HEAD"])).resolves.toBe(
      `${fixture.head}\n`,
    );
    await expect(git(prepared.workspaceDir, ["branch", "--show-current"])).resolves.toBe(
      `${prepared.branch}\n`,
    );
  });

  it("fails closed when isolated handoff would ignore local source changes", async () => {
    const fixture = await createGitFixture();
    await writeFile(path.join(fixture.repo, "README.md"), "dirty\n");
    const manager = new CodexWorkspaceManager({
      defaultWorkspaceDir: fixture.repo,
      worktreesRoot: path.join(fixture.root, "worktrees"),
      protectedWorkspaceDirs: [],
    });

    await expect(
      manager.prepare({
        taskMode: "implementation",
        projectDir: fixture.repo,
      }),
    ).rejects.toThrow("source project has local changes");
  });

  it("discards only its just-created isolated worktree", async () => {
    const fixture = await createGitFixture();
    const manager = new CodexWorkspaceManager({
      defaultWorkspaceDir: fixture.repo,
      worktreesRoot: path.join(fixture.root, "worktrees"),
      protectedWorkspaceDirs: [],
    });
    const prepared = await manager.prepare({
      taskMode: "implementation",
      projectDir: fixture.repo,
    });

    await manager.discard(prepared);

    await expect(git(fixture.repo, ["worktree", "list", "--porcelain"])).resolves.not.toContain(
      prepared.workspaceDir,
    );
  });

  it("allows an explicit clean direct workspace but rejects protected checkouts", async () => {
    const fixture = await createGitFixture();
    const directManager = new CodexWorkspaceManager({
      defaultWorkspaceDir: fixture.repo,
      protectedWorkspaceDirs: [],
    });
    const resolvedRepo = await realpath(fixture.repo);

    await expect(
      directManager.prepare({
        taskMode: "implementation",
        projectDir: fixture.repo,
        workspaceMode: "direct",
      }),
    ).resolves.toMatchObject({
      workspaceMode: "direct",
      workspaceDir: resolvedRepo,
      worktreeCreated: false,
    });

    const protectedManager = new CodexWorkspaceManager({
      defaultWorkspaceDir: fixture.repo,
      protectedWorkspaceDirs: [fixture.repo],
    });
    await expect(
      protectedManager.prepare({
        taskMode: "implementation",
        projectDir: fixture.repo,
        workspaceMode: "direct",
      }),
    ).rejects.toThrow("refusing direct Codex writes in protected checkout");
  });
});

async function createGitFixture(): Promise<{ root: string; repo: string; head: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-worktree-manager-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Codex Test"]);
  await git(repo, ["config", "user.email", "codex-test@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "test: seed fixture"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { root, repo, head };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return result.stdout;
}
