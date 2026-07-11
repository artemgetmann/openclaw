import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

const moduleUrl = new URL("../../scripts/ci-dependency-audit-scope.mjs", import.meta.url).href;
const {
  compareProductionLockfileAuditView,
  packageJsonHasAuditRelevantChange,
  shouldRunAuditForChangedPaths,
} = (await import(moduleUrl)) as unknown as {
  compareProductionLockfileAuditView: (
    beforeRaw: string,
    afterRaw: string,
  ) =>
    | { comparable: false; reason: string }
    | { comparable: true; inventoryChanged: boolean; normalizedLockfileChanged: boolean };
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

type LockfileFixture = {
  lockfileVersion: string;
  settings: Record<string, boolean>;
  importers: Record<
    string,
    { dependencies?: Record<string, { specifier: string; version: string }> }
  >;
  packages: Record<string, Record<string, unknown>>;
  snapshots: Record<string, { dependencies?: Record<string, string> }>;
  patchedDependencies?: Record<string, { hash: string; path: string }>;
};

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

function writeYaml(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(value), "utf8");
}

function createBaseLockfile(): LockfileFixture {
  return {
    lockfileVersion: "9.0",
    settings: {
      autoInstallPeers: true,
      excludeLinksFromLockfile: false,
    },
    importers: {
      ".": {
        dependencies: {
          pkg: {
            specifier: "1.0.0",
            version: "1.0.0(peer@1.0.0)",
          },
        },
      },
      "packages/worker": {
        dependencies: {
          "local-app": {
            specifier: "workspace:*",
            version: "link:../..",
          },
        },
      },
    },
    packages: {
      "pkg@1.0.0": {
        resolution: { integrity: "sha512-pkg" },
      },
      "peer@1.0.0": {
        resolution: { integrity: "sha512-peer" },
      },
      "sub@1.0.0": {
        resolution: { integrity: "sha512-sub" },
      },
    },
    snapshots: {
      "pkg@1.0.0(peer@1.0.0)": {
        dependencies: {
          peer: "1.0.0",
          sub: "1.0.0",
        },
      },
      "peer@1.0.0": {},
      "sub@1.0.0": {},
    },
  };
}

function createPatchedLockfile(patchHash = "abc123") {
  const lockfile = createBaseLockfile();
  lockfile.patchedDependencies = {
    pkg: {
      hash: patchHash,
      path: "patches/pkg.patch",
    },
  };
  const packageEntry = lockfile.importers["."]?.dependencies?.pkg;
  if (!packageEntry) {
    throw new Error("fixture package entry is missing");
  }
  packageEntry.version = `1.0.0(patch_hash=${patchHash})(peer@1.0.0)`;
  lockfile.snapshots = {
    [`pkg@1.0.0(patch_hash=${patchHash})(peer@1.0.0)`]: {
      dependencies: {
        peer: "1.0.0",
        sub: "1.0.0",
      },
    },
    "peer@1.0.0": {},
    "sub@1.0.0": {},
  };
  return lockfile;
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
  writeYaml(path.join(root, "pnpm-lock.yaml"), createBaseLockfile());
  runGit(root, ["add", "package.json"]);
  runGit(root, ["add", "pnpm-lock.yaml"]);
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

  it("skips patch-hash-only lockfile changes", () => {
    const { root, base } = createRepo();
    writeJson(path.join(root, "package.json"), {
      name: "fixture",
      scripts: { test: "vitest" },
      dependencies: { express: "1.0.0" },
      pnpm: {
        patchedDependencies: {
          "pkg@1.0.0": "patches/pkg.patch",
        },
      },
    });
    writeYaml(path.join(root, "pnpm-lock.yaml"), createPatchedLockfile("20f328"));
    runGit(root, ["add", "package.json", "pnpm-lock.yaml"]);
    runGit(root, ["commit", "-q", "-m", "patch only"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(
        shouldRunAuditForChangedPaths(["package.json", "pnpm-lock.yaml"], {
          base,
          head: "HEAD",
        }),
      ).toEqual({
        shouldRun: false,
        reason:
          "pnpm-lock.yaml changed patch metadata only and the resolved production package inventory is unchanged",
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("runs for lockfile version bumps", () => {
    const { root, base } = createRepo();
    writeYaml(path.join(root, "pnpm-lock.yaml"), {
      ...createBaseLockfile(),
      importers: {
        ".": {
          dependencies: {
            pkg: {
              specifier: "2.0.0",
              version: "2.0.0(peer@1.0.0)",
            },
          },
        },
        "packages/worker": {
          dependencies: {
            "local-app": {
              specifier: "workspace:*",
              version: "link:../..",
            },
          },
        },
      },
      packages: {
        "pkg@2.0.0": {
          resolution: { integrity: "sha512-pkg-2" },
        },
        "peer@1.0.0": {
          resolution: { integrity: "sha512-peer" },
        },
        "sub@1.0.0": {
          resolution: { integrity: "sha512-sub" },
        },
      },
      snapshots: {
        "pkg@2.0.0(peer@1.0.0)": {
          dependencies: {
            peer: "1.0.0",
            sub: "1.0.0",
          },
        },
        "peer@1.0.0": {},
        "sub@1.0.0": {},
      },
    });
    runGit(root, ["add", "pnpm-lock.yaml"]);
    runGit(root, ["commit", "-q", "-m", "version bump"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(shouldRunAuditForChangedPaths(["pnpm-lock.yaml"], { base, head: "HEAD" })).toEqual({
        shouldRun: true,
        reason: "pnpm-lock.yaml changed the resolved production package inventory",
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("runs for added production packages in the lockfile graph", () => {
    const { root, base } = createRepo();
    const lockfile = createBaseLockfile();
    lockfile.packages["extra@1.0.0"] = {
      resolution: { integrity: "sha512-extra" },
    };
    lockfile.snapshots["extra@1.0.0"] = {};
    lockfile.snapshots["pkg@1.0.0(peer@1.0.0)"] = {
      dependencies: {
        extra: "1.0.0",
        peer: "1.0.0",
        sub: "1.0.0",
      },
    };
    writeYaml(path.join(root, "pnpm-lock.yaml"), lockfile);
    runGit(root, ["add", "pnpm-lock.yaml"]);
    runGit(root, ["commit", "-q", "-m", "extra package"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(shouldRunAuditForChangedPaths(["pnpm-lock.yaml"], { base, head: "HEAD" })).toEqual({
        shouldRun: true,
        reason: "pnpm-lock.yaml changed the resolved production package inventory",
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("fails closed for malformed lockfile changes", () => {
    const { root, base } = createRepo();
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "not: [valid\n", "utf8");
    runGit(root, ["add", "pnpm-lock.yaml"]);
    runGit(root, ["commit", "-q", "-m", "malformed lock"]);

    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(shouldRunAuditForChangedPaths(["pnpm-lock.yaml"], { base, head: "HEAD" })).toEqual({
        shouldRun: true,
        reason: "pnpm-lock.yaml could not be parsed",
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("always runs for workspace changes", () => {
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

describe("compareProductionLockfileAuditView", () => {
  it("normalizes patch-only lockfile churn", () => {
    const before = stringifyYaml(createBaseLockfile());
    const after = stringifyYaml(createPatchedLockfile("hash-1"));
    expect(compareProductionLockfileAuditView(before, after)).toEqual({
      comparable: true,
      inventoryChanged: false,
      normalizedLockfileChanged: false,
    });
  });
});
