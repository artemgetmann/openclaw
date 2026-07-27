import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const retentionScript = path.join(repoRoot, "scripts/disk-retention.sh");
const installerScript = path.join(repoRoot, "scripts/install-worktree-gc.sh");
const tempRoots: string[] = [];
const describePosix = process.platform === "win32" ? describe.skip : describe;

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-retention-"));
  tempRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, body: string) {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function makeRetentionFixtures(root: string) {
  const cleanupLog = path.join(root, "cleanup.log");
  const gcLog = path.join(root, "gc.log");
  const cleanup = path.join(root, "cleanup.sh");
  const gc = path.join(root, "gc.sh");

  writeExecutable(
    cleanup,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${cleanupLog}"
printf '{"fixture":"cleanup"}\\n'
`,
  );
  writeExecutable(
    gc,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${gcLog}"
printf 'fixture=gc\\n'
`,
  );

  return { cleanup, cleanupLog, gc, gcLog };
}

function runRetention(
  freeGiB: number,
  fixture: ReturnType<typeof makeRetentionFixtures>,
  args: string[] = [],
) {
  return spawnSync("/bin/bash", [retentionScript, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCLAW_DISK_RETENTION_AVAILABLE_KIB_OVERRIDE: String(freeGiB * 1024 * 1024),
      OPENCLAW_DISK_RETENTION_CLEANUP_SCRIPT: fixture.cleanup,
      OPENCLAW_DISK_RETENTION_GC_SCRIPT: fixture.gc,
    },
    encoding: "utf8",
  });
}

function makeLaunchctlFixture(root: string, mode: "healthy" | "disabled") {
  const launchctl = path.join(root, "launchctl");
  writeExecutable(
    launchctl,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  print)
    if [[ "${mode}" == "disabled" ]]; then
      exit 113
    fi
    printf 'state = waiting\\nlast exit code = 0\\n'
    ;;
  print-disabled)
    if [[ "${mode}" == "disabled" ]]; then
      printf '"ai.openclaw.worktree-gc" => disabled\\n'
    else
      printf 'disabled services = {}\\n'
    fi
    ;;
  *)
    exit 0
    ;;
esac
`,
  );
  return launchctl;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describePosix("disk retention coordinator", () => {
  it("keeps report mode non-destructive under disk pressure", () => {
    const root = makeTempRoot();
    const fixture = makeRetentionFixtures(root);
    const result = runRetention(40, fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("mode=report");
    expect(result.stdout).toContain("pressure_before=pressure");
    expect(result.stdout).toContain("artifact_action=report");
    expect(result.stdout).toContain("worktree_gc_action=report");
    expect(fs.readFileSync(fixture.cleanupLog, "utf8")).not.toContain("--apply");
    expect(fs.readFileSync(fixture.gcLog, "utf8")).not.toContain("--auto");
  });

  it("applies only the owning safe cleanup paths below the pressure threshold", () => {
    const root = makeTempRoot();
    const fixture = makeRetentionFixtures(root);
    const result = runRetention(40, fixture, ["--auto"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("mode=auto");
    expect(result.stdout).toContain("artifact_action=apply");
    expect(result.stdout).toContain("worktree_gc_action=apply");
    expect(fs.readFileSync(fixture.cleanupLog, "utf8")).toContain(
      "--worktrees --deps --build-cache --json --apply",
    );
    expect(fs.readFileSync(fixture.gcLog, "utf8")).toContain("--auto --base-branch main");
  });

  it("reports urgent pressure after safe cleanup without broadening scope", () => {
    const root = makeTempRoot();
    const fixture = makeRetentionFixtures(root);
    const result = runRetention(20, fixture, ["--auto"]);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain("status=urgent");
    expect(result.stdout).toContain("operator_action=stop heavy builds");
    expect(fs.readFileSync(fixture.cleanupLog, "utf8")).not.toContain("--runtime-instances");
  });

  it("does not apply artifact cleanup above the automatic threshold", () => {
    const root = makeTempRoot();
    const fixture = makeRetentionFixtures(root);
    const result = runRetention(60, fixture, ["--auto"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("pressure_before=warning");
    expect(result.stdout).toContain("artifact_action=report");
    expect(fs.readFileSync(fixture.cleanupLog, "utf8")).not.toContain("--apply");
    expect(fs.readFileSync(fixture.gcLog, "utf8")).toContain("--auto");
  });
});

describePosix("disk retention scheduler", () => {
  it("renders the pressure-aware coordinator instead of raw forced GC", () => {
    const root = makeTempRoot();
    const result = spawnSync("/bin/bash", [installerScript, "install", "--dry-run"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: root,
        OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Darwin",
        OPENCLAW_WORKTREE_GC_REPO_ROOT: repoRoot,
      },
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`${repoRoot}/scripts/disk-retention.sh`);
    expect(result.stdout).toContain("<string>--auto</string>");
    expect(result.stdout).toContain("<key>RunAtLoad</key>");
    expect(result.stdout).not.toContain(`${repoRoot}/scripts/gc-worktrees.sh`);
  });

  it("fails status when a plist exists but launchd is disabled and unloaded", () => {
    const root = makeTempRoot();
    const launchAgents = path.join(root, "Library/LaunchAgents");
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(path.join(launchAgents, "ai.openclaw.worktree-gc.plist"), "fixture\n");
    const launchctl = makeLaunchctlFixture(root, "disabled");

    const result = spawnSync("/bin/bash", [installerScript, "status"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: root,
        OPENCLAW_WORKTREE_GC_LAUNCHCTL_BIN: launchctl,
        OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Darwin",
        OPENCLAW_WORKTREE_GC_REPO_ROOT: repoRoot,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installed=yes");
    expect(result.stdout).toContain("loaded=no");
    expect(result.stdout).toContain("enabled=no");
  });

  it("reports healthy only when the plist is loaded and enabled", () => {
    const root = makeTempRoot();
    const launchAgents = path.join(root, "Library/LaunchAgents");
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(path.join(launchAgents, "ai.openclaw.worktree-gc.plist"), "fixture\n");
    const launchctl = makeLaunchctlFixture(root, "healthy");

    const result = spawnSync("/bin/bash", [installerScript, "status"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: root,
        OPENCLAW_WORKTREE_GC_LAUNCHCTL_BIN: launchctl,
        OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Darwin",
        OPENCLAW_WORKTREE_GC_REPO_ROOT: repoRoot,
      },
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("installed=yes");
    expect(result.stdout).toContain("loaded=yes");
    expect(result.stdout).toContain("enabled=yes");
    expect(result.stdout).toContain("last exit code = 0");
  });
});
