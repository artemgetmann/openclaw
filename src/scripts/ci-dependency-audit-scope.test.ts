import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const moduleUrl = new URL("../../scripts/ci-dependency-audit-scope.mjs", import.meta.url).href;
const { packageJsonHasAuditRelevantChange, shouldRunAuditForChangedPaths } = (await import(
  moduleUrl
)) as unknown as {
  packageJsonHasAuditRelevantChange: (
    beforePackage: Record<string, unknown>,
    afterPackage: Record<string, unknown>,
  ) => boolean;
  shouldRunAuditForChangedPaths: (
    changedPaths: string[],
    refs?: { base?: string; head?: string },
  ) => { shouldRun: boolean; reason: string };
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function runGit(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "ci@example.invalid",
      GIT_AUTHOR_NAME: "CI Test",
      GIT_COMMITTER_EMAIL: "ci@example.invalid",
      GIT_COMMITTER_NAME: "CI Test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ci-audit-scope-"));
  tempRoots.push(root);
  runGit(root, ["init", "-q", "-b", "main"]);
  writeJson(path.join(root, "package.json"), {
    name: "fixture",
    scripts: { test: "vitest" },
    dependencies: { express: "1.0.0" },
  });
  runGit(root, ["add", "package.json"]);
  runGit(root, ["commit", "-q", "-m", "base"]);
  const base = runGit(root, ["rev-parse", "HEAD"]);
  return { root, base };
}

describe("packageJsonHasAuditRelevantChange", () => {
  it("ignores script-only changes", () => {
    expect(
      packageJsonHasAuditRelevantChange(
        { scripts: { test: "vitest" }, dependencies: { express: "1.0.0" } },
        {
          scripts: { "cleanup:report": "bash scripts/cleanup-build-artifacts.sh" },
          dependencies: { express: "1.0.0" },
        },
      ),
    ).toBe(false);
  });

  it("detects dependency and package-manager changes", () => {
    expect(
      packageJsonHasAuditRelevantChange(
        { dependencies: { express: "1.0.0" } },
        { dependencies: { express: "2.0.0" } },
      ),
    ).toBe(true);
    expect(
      packageJsonHasAuditRelevantChange(
        { packageManager: "pnpm@10.0.0" },
        { packageManager: "pnpm@10.1.0" },
      ),
    ).toBe(true);
  });
});

describe("shouldRunAuditForChangedPaths", () => {
  it("skips script-only package.json edits", () => {
    const { root, base } = createRepo();
    writeJson(path.join(root, "package.json"), {
      name: "fixture",
      scripts: {
        "cleanup:report": "bash scripts/cleanup-build-artifacts.sh",
        test: "vitest",
      },
      dependencies: { express: "1.0.0" },
    });
    runGit(root, ["add", "package.json"]);
    runGit(root, ["commit", "-q", "-m", "script only"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(shouldRunAuditForChangedPaths(["package.json"], { base, head: "HEAD" })).toEqual({
        shouldRun: false,
        reason: "package.json changes are script or metadata only",
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("runs for package dependency changes", () => {
    const { root, base } = createRepo();
    writeJson(path.join(root, "package.json"), {
      name: "fixture",
      scripts: { test: "vitest" },
      dependencies: { express: "2.0.0" },
    });
    runGit(root, ["add", "package.json"]);
    runGit(root, ["commit", "-q", "-m", "dependency"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(shouldRunAuditForChangedPaths(["package.json"], { base, head: "HEAD" })).toMatchObject(
        {
          shouldRun: true,
          reason: "package.json changed dependency-relevant fields",
        },
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it("always runs for lockfile and workspace changes", () => {
    expect(shouldRunAuditForChangedPaths(["pnpm-lock.yaml"])).toMatchObject({
      shouldRun: true,
      reason: "pnpm-lock.yaml changed",
    });
    expect(shouldRunAuditForChangedPaths(["pnpm-workspace.yaml"])).toMatchObject({
      shouldRun: true,
      reason: "pnpm-workspace.yaml changed",
    });
  });

  it("fails closed when a package manifest is added or removed", () => {
    const { root, base } = createRepo();
    fs.rmSync(path.join(root, "package.json"));
    runGit(root, ["add", "package.json"]);
    runGit(root, ["commit", "-q", "-m", "delete package"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(shouldRunAuditForChangedPaths(["package.json"], { base, head: "HEAD" })).toMatchObject(
        {
          shouldRun: true,
          reason: "package.json was added or removed",
        },
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it("ignores unrelated paths", () => {
    expect(shouldRunAuditForChangedPaths(["scripts/cleanup-build-artifacts.sh"])).toEqual({
      shouldRun: false,
      reason: "no dependency audit scope paths changed",
    });
  });
});
