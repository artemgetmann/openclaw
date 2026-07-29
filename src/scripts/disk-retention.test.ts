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
exit "\${OPENCLAW_TEST_CLEANUP_STATUS:-0}"
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
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync("/bin/bash", [retentionScript, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCLAW_DISK_RETENTION_AVAILABLE_KIB_OVERRIDE: String(freeGiB * 1024 * 1024),
      OPENCLAW_DISK_RETENTION_CLEANUP_SCRIPT: fixture.cleanup,
      OPENCLAW_DISK_RETENTION_GC_SCRIPT: fixture.gc,
      ...env,
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
      printf '"ai.openclaw.worktree-gc" => true\\n'
    else
      printf '"ai.openclaw.worktree-gc" => false\\n'
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

function makeTransactionalLaunchctlFixture(root: string, failureStep: string) {
  const launchctl = path.join(root, "launchctl-transaction");
  const loaded = path.join(root, "launchctl.loaded");
  const disabled = path.join(root, "launchctl.disabled");
  const failure = path.join(root, `fail-${failureStep}`);
  fs.writeFileSync(loaded, "loaded\n");
  fs.writeFileSync(disabled, "disabled\n");
  fs.writeFileSync(failure, "fail once\n");

  writeExecutable(
    launchctl,
    `#!/usr/bin/env bash
set -euo pipefail
operation="\${1:-}"
if [[ "$operation" == "${failureStep}" && -f "${failure}" ]]; then
  rm -f "${failure}"
  exit 70
fi
case "$operation" in
  print)
    [[ -f "${loaded}" ]] || exit 113
    printf 'state = waiting\\n'
    ;;
  print-disabled)
    if [[ -f "${disabled}" ]]; then
      printf '"ai.openclaw.worktree-gc" => true\\n'
    else
      printf '"ai.openclaw.worktree-gc" => false\\n'
    fi
    ;;
  enable)
    rm -f "${disabled}"
    ;;
  disable)
    printf 'disabled\\n' > "${disabled}"
    ;;
  bootout)
    rm -f "${loaded}"
    ;;
  bootstrap)
    printf 'loaded\\n' > "${loaded}"
    ;;
  *)
    exit 64
    ;;
esac
`,
  );
  return { disabled, launchctl, loaded };
}

// Fail the first atomic plist replacement only. The second invocation is the
// rollback restore and must succeed so the fixture proves the transaction,
// rather than merely observing the initial failure.
function makeFailOnceMoveFixture(root: string) {
  const move = path.join(root, "mv-fail-once");
  const failure = path.join(root, "mv-fail-once.pending");
  fs.writeFileSync(failure, "fail once\n");
  writeExecutable(
    move,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -f "${failure}" ]]; then
  rm -f "${failure}"
  exit 70
fi
exec /bin/mv "$@"
`,
  );
  return move;
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

  it("propagates an explicit partial artifact report after still running report-only GC", () => {
    const root = makeTempRoot();
    const fixture = makeRetentionFixtures(root);
    const result = runRetention(60, fixture, [], {
      OPENCLAW_TEST_CLEANUP_STATUS: "4",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(4);
    expect(result.stdout).toContain("status=partial");
    expect(result.stdout).toContain("operator_action=review the lower-bound candidates");
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

  it("XML-escapes dynamic plist paths and arguments", () => {
    const root = makeTempRoot();
    const escapedRepo = path.join(root, "repo&<>'\"");
    fs.mkdirSync(escapedRepo);

    const result = spawnSync(
      "/bin/bash",
      [installerScript, "install", "--dry-run", "--base-branch", "topic&<>'\""],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: root,
          OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Darwin",
          OPENCLAW_WORKTREE_GC_REPO_ROOT: escapedRepo,
        },
        encoding: "utf8",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("repo&amp;&lt;&gt;&apos;&quot;");
    expect(result.stdout).toContain("topic&amp;&lt;&gt;&apos;&quot;");
    expect(result.stdout).not.toContain("<string>topic&<>'\"</string>");
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

  it("fails Linux status when the scheduler is not installed", () => {
    const root = makeTempRoot();
    const crontab = path.join(root, "crontab");
    writeExecutable(
      crontab,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "-l" ]] || exit 64
exit 1
`,
    );

    const result = spawnSync("/bin/bash", [installerScript, "status"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: root,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Linux",
        OPENCLAW_WORKTREE_GC_REPO_ROOT: repoRoot,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installed=no");
  });

  it.each(["enable", "bootout", "bootstrap", "plist-overwrite"])(
    "restores prior macOS plist, loaded state, and disabled state after %s failure",
    (failureStep) => {
      const root = makeTempRoot();
      const launchAgents = path.join(root, "Library/LaunchAgents");
      const plist = path.join(launchAgents, "ai.openclaw.worktree-gc.plist");
      fs.mkdirSync(launchAgents, { recursive: true });
      fs.writeFileSync(plist, "prior plist\n");
      const fixture = makeTransactionalLaunchctlFixture(root, failureStep);
      const move = failureStep === "plist-overwrite" ? makeFailOnceMoveFixture(root) : undefined;

      const result = spawnSync("/bin/bash", [installerScript, "install"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: root,
          OPENCLAW_WORKTREE_GC_LAUNCHCTL_BIN: fixture.launchctl,
          OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Darwin",
          OPENCLAW_WORKTREE_GC_REPO_ROOT: repoRoot,
          ...(move ? { OPENCLAW_WORKTREE_GC_MV_BIN: move } : {}),
        },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`install failed at ${failureStep}`);
      expect(fs.readFileSync(plist, "utf8")).toBe("prior plist\n");
      expect(fs.existsSync(fixture.loaded)).toBe(true);
      expect(fs.existsSync(fixture.disabled)).toBe(true);
    },
  );

  it("refuses install when prior launchd loaded state is indeterminate", () => {
    const root = makeTempRoot();
    const launchAgents = path.join(root, "Library/LaunchAgents");
    const plist = path.join(launchAgents, "ai.openclaw.worktree-gc.plist");
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(plist, "prior plist\n");
    const fixture = makeTransactionalLaunchctlFixture(root, "print");

    const result = spawnSync("/bin/bash", [installerScript, "install"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: root,
        OPENCLAW_WORKTREE_GC_LAUNCHCTL_BIN: fixture.launchctl,
        OPENCLAW_WORKTREE_GC_PLATFORM_OVERRIDE: "Darwin",
        OPENCLAW_WORKTREE_GC_REPO_ROOT: repoRoot,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unable to inspect launchd loaded state");
    expect(fs.readFileSync(plist, "utf8")).toBe("prior plist\n");
    expect(fs.existsSync(fixture.loaded)).toBe(true);
    expect(fs.existsSync(fixture.disabled)).toBe(true);
  });
});
