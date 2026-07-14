import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];
const describePosix = process.platform === "win32" ? describe.skip : describe;

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gc-worktrees-"));
  tempRoots.push(root);
  return root;
}

function writeExecutable(filePath: string, body: string) {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function initRepoWithMergedWorktree(root: string) {
  const main = path.join(root, "main");
  const lane = path.join(root, "merged-lane");
  fs.mkdirSync(main, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  fs.writeFileSync(path.join(main, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: main });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], {
    cwd: main,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  execFileSync("git", ["worktree", "add", "-q", "-b", "merged-lane", lane], {
    cwd: main,
  });
  return { main, lane };
}

/**
 * The production script reads plists through PlistBuddy. Tests use a tiny
 * tab-separated fixture format so they exercise GC's safety decisions without
 * depending on macOS or touching the developer's real LaunchAgents directory.
 */
function writePlistFixture(filePath: string, fields: Record<string, string>) {
  fs.writeFileSync(
    filePath,
    Object.entries(fields)
      .map(([key, value]) => `${key}\t${value}`)
      .join("\n") + "\n",
  );
}

function makeToolFixtures(root: string) {
  const binDir = path.join(root, "bin");
  const launchctlLog = path.join(root, "launchctl.log");
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  fs.mkdirSync(binDir, { recursive: true });

  const plistBuddy = path.join(binDir, "plistbuddy");
  writeExecutable(
    plistBuddy,
    `#!/usr/bin/env bash
set -euo pipefail
command="\${2}"
file="\${3}"
if [[ -n "\${OPENCLAW_TEST_PLISTBUDDY_FATAL_PATH:-}" && "$file" == "$OPENCLAW_TEST_PLISTBUDDY_FATAL_PATH" ]]; then
  exit 65
fi
if [[ "$command" == "Print" ]]; then
  exit 0
fi
key="\${command#Print :}"
/usr/bin/awk -F '\\t' -v key="$key" '
  $1 == key {
    sub(/^[^\\t]*\\t/, "")
    print
    found = 1
    exit
  }
  END { if (!found) exit 1 }
' "$file"
`,
  );

  const find = path.join(binDir, "find");
  writeExecutable(
    find,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${OPENCLAW_TEST_FIND_FAIL:-0}" == "1" ]]; then
  exit 74
fi
exec /usr/bin/find "$@"
`,
  );

  const launchctl = path.join(binDir, "launchctl");
  writeExecutable(
    launchctl,
    `#!/usr/bin/env bash
set -euo pipefail
label="\${2##*/}"
source_present=0
while IFS= read -r -d '' plist; do
  if /usr/bin/awk -F '\\t' -v label="$label" '$1 == "Label" && $2 == label { found = 1 } END { exit !found }' "$plist"; then
    source_present=1
    break
  fi
done < <(find "$OPENCLAW_WORKTREE_GC_LAUNCH_AGENTS_DIR" -maxdepth 1 -type f -name '*.plist' -print0)
printf 'source_present=%s %s\\n' "$source_present" "$*" >> "${launchctlLog}"
if [[ "$1" == "print" ]]; then
  case "\${OPENCLAW_TEST_LAUNCHCTL_PRINT_MODE:-loaded}" in
    absent)
      printf 'Bad request.\\nCould not find service "%s" in domain for user gui\\n' "$label" >&2
      exit 113
      ;;
    ambiguous-error)
      printf 'Could not access domain for user gui: transient failure\\n' >&2
      exit 1
      ;;
    second-ambiguous)
      if [[ "$label" == "ai.openclaw.consumer.second-lane.gateway" ]]; then
        printf 'Could not access domain for user gui: transient failure\\n' >&2
        exit 1
      fi
      exit 0
      ;;
    loaded)
      exit 0
      ;;
  esac
fi
if [[ "$1" == "bootout" && "\${OPENCLAW_TEST_LAUNCHCTL_BOOTOUT_FAIL:-0}" == "1" ]]; then
  exit 1
fi
if [[ "$1" == "bootstrap" && ! -f "\${3:-}" ]]; then
  exit 1
fi
`,
  );

  // Delegate every Git operation except the one failure injected by the
  // rollback test. This keeps the fixture behavior identical to real Git.
  const git = path.join(binDir, "git");
  writeExecutable(
    git,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${OPENCLAW_TEST_GIT_REMOVE_FAIL:-0}" == "1" && "\${1:-}" == "worktree" && "\${2:-}" == "remove" ]]; then
  exit 71
fi
exec "${realGit}" "$@"
`,
  );

  return { binDir, find, launchctl, launchctlLog, plistBuddy };
}

function runGc(
  main: string,
  env: {
    home: string;
    launchAgents: string;
    launchctl: string;
    plistBuddy: string;
    quarantine: string;
    launchctlBootoutFails?: boolean;
    launchctlPrintMode?: "loaded" | "absent" | "ambiguous-error" | "second-ambiguous";
    gitRemoveFails?: boolean;
    findFails?: boolean;
    plistBuddyFatalPath?: string;
  },
) {
  // The macOS scheduler invokes /bin/bash (Apple Bash 3.2). Pin the integration
  // fixture to that shell so Homebrew Bash cannot hide nounset/array regressions.
  return spawnSync("/bin/bash", [path.join(repoRoot, "scripts/gc-worktrees.sh"), "--auto"], {
    cwd: main,
    env: {
      ...process.env,
      HOME: env.home,
      TMPDIR: env.home,
      PATH: `${path.dirname(env.launchctl)}:${process.env.PATH ?? ""}`,
      OPENCLAW_FIND_BIN: path.join(path.dirname(env.launchctl), "find"),
      OPENCLAW_LAUNCHCTL_BIN: env.launchctl,
      OPENCLAW_PLISTBUDDY_BIN: env.plistBuddy,
      OPENCLAW_WORKTREE_GC_LAUNCH_AGENTS_DIR: env.launchAgents,
      OPENCLAW_WORKTREE_GC_QUARANTINE_DIR: env.quarantine,
      OPENCLAW_TEST_LAUNCHCTL_BOOTOUT_FAIL: env.launchctlBootoutFails ? "1" : "0",
      OPENCLAW_TEST_LAUNCHCTL_PRINT_MODE: env.launchctlPrintMode ?? "loaded",
      OPENCLAW_TEST_GIT_REMOVE_FAIL: env.gitRemoveFails ? "1" : "0",
      OPENCLAW_TEST_FIND_FAIL: env.findFails ? "1" : "0",
      OPENCLAW_TEST_PLISTBUDDY_FATAL_PATH: env.plistBuddyFatalPath ?? "",
    },
    encoding: "utf8",
  });
}

function ownedConsumerGatewayFields(label: string, lane: string, instanceId = "merged-lane") {
  return {
    Label: label,
    "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL": label,
    "EnvironmentVariables:OPENCLAW_CONSUMER_INSTANCE_ID": instanceId,
    "EnvironmentVariables:OPENCLAW_PROFILE": `consumer-${instanceId}`,
    "ProgramArguments:0": "/usr/bin/node",
    "ProgramArguments:1": path.join(lane, "dist/index.js"),
    "ProgramArguments:2": "gateway",
    "ProgramArguments:3": "--port",
    "ProgramArguments:4": "18842",
    WorkingDirectory: lane,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describePosix("gc-worktrees LaunchAgent retirement", () => {
  it("removes a merged worktree under /bin/bash when LaunchAgent inventory is empty", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
  });

  it("preserves a locked missing worktree and its owned LaunchAgent", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });
    const registeredLane = fs.realpathSync(lane);

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    execFileSync("git", ["worktree", "lock", "--reason", "temporarily unavailable", lane], {
      cwd: main,
    });
    fs.rmSync(lane, { recursive: true, force: true });

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    const registrations = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: main,
      encoding: "utf8",
    });
    expect(registrations).toContain(`worktree ${registeredLane}`);
    expect(registrations).toContain("locked temporarily unavailable");
    expect(result.stdout).toContain("locked");
    expect(result.stdout).toContain(registeredLane);
  });

  it("quarantines and boots out an exact-owned symlinked plist before worktree removal", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const plistTarget = path.join(root, "owned-target.plist");
    const ownedPlist = path.join(launchAgents, "owned-link.plist");
    writePlistFixture(
      plistTarget,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.symlinkSync(plistTarget, ownedPlist);

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    const quarantinedPlist = path.join(quarantine, path.basename(ownedPlist));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.existsSync(ownedPlist)).toBe(false);
    expect(fs.lstatSync(quarantinedPlist).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(plistTarget)).toBe(true);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toContain("bootout");
  });

  it("rejects an owned plist symlink whose target would be deleted with the worktree", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const plistTarget = path.join(lane, "owned-target.plist");
    const ownedPlist = path.join(launchAgents, "owned-link.plist");
    writePlistFixture(
      plistTarget,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.symlinkSync(plistTarget, ownedPlist);

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.lstatSync(ownedPlist).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(plistTarget)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("symlink target is inside the worktree");
    expect(result.stderr).toContain("LaunchAgent retirement failed");
  });

  it("rejects a relative owned plist symlink before quarantine changes its meaning", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const plistTarget = path.join(root, "relative-target.plist");
    const ownedPlist = path.join(launchAgents, "owned-relative.plist");
    writePlistFixture(
      plistTarget,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.symlinkSync(path.relative(launchAgents, plistTarget), ownedPlist);

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.lstatSync(ownedPlist).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(plistTarget)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("relative LaunchAgent plist symlink");
  });

  it("rejects a multi-hop owned plist symlink before worktree removal", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const plistTarget = path.join(root, "multi-hop-target.plist");
    const intermediateLink = path.join(root, "intermediate.plist");
    const ownedPlist = path.join(launchAgents, "owned-multi-hop.plist");
    writePlistFixture(
      plistTarget,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.symlinkSync(plistTarget, intermediateLink);
    fs.symlinkSync(intermediateLink, ownedPlist);

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.lstatSync(ownedPlist).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(intermediateLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(plistTarget)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("multi-hop LaunchAgent plist symlink");
  });

  it("fails closed on a broken plist symlink before worktree removal", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const brokenPlist = path.join(launchAgents, "broken.plist");
    fs.symlinkSync(path.join(root, "missing-target.plist"), brokenPlist);

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.lstatSync(brokenPlist).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("broken or unreadable LaunchAgent plist symlink");
    expect(result.stderr).toContain("LaunchAgent retirement failed");
  });

  it("retires an owned agent before pruning a registered worktree whose directory is gone", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });
    const registeredLane = fs.realpathSync(lane);

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.rmSync(lane, { recursive: true, force: true });

    // Prove the stale registration exists before GC; this is the ownership
    // record the old eager-prune ordering discarded before LaunchAgent cleanup.
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: main, encoding: "utf8" }),
    ).toContain(`worktree ${registeredLane}`);

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(ownedPlist)).toBe(false);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(true);
    const launchctlLog = fs.readFileSync(tools.launchctlLog, "utf8");
    expect(launchctlLog).toContain("source_present=0 bootout");
    expect(launchctlLog).not.toContain("bootstrap");
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: main, encoding: "utf8" }),
    ).not.toContain(`worktree ${registeredLane}`);
    expect(result.stdout).toContain("GC complete: 1 prunable, 0 merged (1 removed)");
  });

  it("keeps missing-lane metadata and quarantine on ambiguous retirement failure", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });
    const registeredLane = fs.realpathSync(lane);

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.rmSync(lane, { recursive: true, force: true });

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "ambiguous-error",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(ownedPlist)).toBe(false);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(true);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).not.toContain("bootstrap");
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: main, encoding: "utf8" }),
    ).toContain(`worktree ${registeredLane}`);
    expect(result.stderr).toContain("worktree entrypoint is missing");
    expect(result.stderr).toContain("skipped Git metadata prune");

    const firstLaunchctlLog = fs.readFileSync(tools.launchctlLog, "utf8");
    const retry = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "absent",
    });

    expect(retry.status).toBe(1);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toBe(firstLaunchctlLog);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: main, encoding: "utf8" }),
    ).toContain(`worktree ${registeredLane}`);
    expect(retry.stderr).toContain("already quarantined");
    expect(retry.stderr).toContain("skipped Git metadata prune");
  });

  it("resumes a partial prunable batch from durable successful-retirement evidence", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const secondLane = path.join(root, "second-lane");
    execFileSync("git", ["worktree", "add", "-q", "-b", "second-lane", secondLane], {
      cwd: main,
    });
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });
    const registeredLane = fs.realpathSync(lane);
    const registeredSecondLane = fs.realpathSync(secondLane);

    const firstPlist = path.join(launchAgents, "a-first.plist");
    const secondPlist = path.join(launchAgents, "b-second.plist");
    writePlistFixture(
      firstPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    writePlistFixture(
      secondPlist,
      ownedConsumerGatewayFields(
        "ai.openclaw.consumer.second-lane.gateway",
        secondLane,
        "second-lane",
      ),
    );
    fs.rmSync(lane, { recursive: true, force: true });
    fs.rmSync(secondLane, { recursive: true, force: true });

    const first = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "second-ambiguous",
    });

    const quarantinedFirst = path.join(quarantine, path.basename(firstPlist));
    const quarantinedSecond = path.join(quarantine, path.basename(secondPlist));
    expect(first.status).toBe(1);
    expect(fs.existsSync(quarantinedFirst)).toBe(true);
    expect(fs.existsSync(`${quarantinedFirst}.retired-success`)).toBe(true);
    expect(fs.existsSync(quarantinedSecond)).toBe(true);
    expect(fs.existsSync(`${quarantinedSecond}.retired-success`)).toBe(false);
    const firstLaunchctlLog = fs.readFileSync(tools.launchctlLog, "utf8");
    const firstLabelOccurrences = firstLaunchctlLog.match(
      /ai\.openclaw\.consumer\.merged-lane\.gateway/g,
    )?.length;

    // Manual resolution makes only the ambiguous second plist active again.
    // The first lane must resume from its durable success receipt without a
    // second launchctl operation.
    fs.renameSync(quarantinedSecond, secondPlist);
    const retry = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "absent",
    });

    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(fs.existsSync(`${quarantinedSecond}.retired-success`)).toBe(true);
    const retryLaunchctlLog = fs.readFileSync(tools.launchctlLog, "utf8");
    expect(retryLaunchctlLog.match(/ai\.openclaw\.consumer\.merged-lane\.gateway/g)?.length).toBe(
      firstLabelOccurrences,
    );
    const registrations = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: main,
      encoding: "utf8",
    });
    expect(registrations).not.toContain(`worktree ${registeredLane}`);
    expect(registrations).not.toContain(`worktree ${registeredSecondLane}`);
    expect(retry.stdout).toContain("Confirmed prior LaunchAgent retirement");
    expect(retry.stdout).toContain("GC complete: 2 prunable, 0 merged (2 removed)");
  });

  it("keeps external quarantine evidence visible across an ambiguous missing-lane retry", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(root, "external-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });
    const registeredLane = fs.realpathSync(lane);

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.rmSync(lane, { recursive: true, force: true });

    const first = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "ambiguous-error",
    });

    expect(first.status).toBe(1);
    expect(fs.existsSync(ownedPlist)).toBe(false);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(true);
    const firstLaunchctlLog = fs.readFileSync(tools.launchctlLog, "utf8");

    const retry = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "absent",
    });

    expect(retry.status).toBe(1);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toBe(firstLaunchctlLog);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: main, encoding: "utf8" }),
    ).toContain(`worktree ${registeredLane}`);
    expect(retry.stderr).toContain("already quarantined");
    expect(retry.stderr).toContain("skipped Git metadata prune");
  });

  it("fails closed before mutation when LaunchAgent enumeration fails", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      findFails: true,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(
      fs.readdirSync(home).some((entry) => entry.startsWith("openclaw-worktree-gc-launchagents.")),
    ).toBe(false);
    expect(result.stderr).toContain("LaunchAgent inventory failed");
    expect(result.stderr).toContain("LaunchAgent retirement failed");
  });

  it("fails closed before mutation when PlistBuddy cannot parse an inventoried plist", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    // Inject a fatal root-read failure for a regular file. This is deliberately
    // different from a missing optional key, which plist_value may ignore.
    const invalidPlist = path.join(launchAgents, "invalid.plist");
    fs.writeFileSync(invalidPlist, "not a parseable plist\n");

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      plistBuddyFatalPath: invalidPlist,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(invalidPlist)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("LaunchAgent plist is unreadable or invalid");
    expect(result.stderr).toContain("LaunchAgent retirement failed");
  });

  it("quarantines only an explicitly owned consumer gateway before deleting its worktree", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const ownedPlist = path.join(launchAgents, "unexpected-file-name.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    // Non-referencing canonical services stay untouched. A canonical service
    // that references this lane is covered separately and blocks deletion.
    const jarvisPlist = path.join(launchAgents, "ai.jarvis.gateway.plist");
    writePlistFixture(
      jarvisPlist,
      ownedConsumerGatewayFields("ai.jarvis.gateway", path.join(root, "other-runtime")),
    );

    // A prefix collision is not ownership: /lane-old must not be claimed by
    // /lane. This proves the path check has a directory boundary.
    const siblingPlist = path.join(launchAgents, "sibling.plist");
    writePlistFixture(
      siblingPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.sibling.gateway", `${lane}-old`, "sibling"),
    );

    // A non-referencing custom service is outside this cleanup scope.
    const customPlist = path.join(launchAgents, "custom.plist");
    writePlistFixture(customPlist, {
      ...ownedConsumerGatewayFields("com.example.gateway", path.join(root, "custom-runtime")),
      "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL": "com.example.gateway",
    });

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.existsSync(ownedPlist), `${result.stdout}\n${result.stderr}`).toBe(false);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(true);
    expect(fs.existsSync(jarvisPlist)).toBe(true);
    expect(fs.existsSync(siblingPlist)).toBe(true);
    expect(fs.existsSync(customPlist)).toBe(true);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toContain("source_present=0 bootout");
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toContain(
      "ai.openclaw.consumer.merged-lane.gateway",
    );
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).not.toContain("ai.jarvis.gateway");
    expect(result.stdout).toContain("Quarantined worktree LaunchAgent");
  });

  it.each(["canonical", "custom", "malformed"] as const)(
    "blocks deletion when a %s LaunchAgent references the worktree without retirement authority",
    (kind) => {
      const root = makeTempRoot();
      const { main, lane } = initRepoWithMergedWorktree(root);
      const home = path.join(root, "home");
      const launchAgents = path.join(home, "Library/LaunchAgents");
      const quarantine = path.join(launchAgents, "gc-quarantine");
      const tools = makeToolFixtures(root);
      fs.mkdirSync(launchAgents, { recursive: true });

      const blockingPlist = path.join(launchAgents, `${kind}.plist`);
      let fields: Record<string, string>;
      if (kind === "canonical") {
        fields = ownedConsumerGatewayFields("ai.jarvis.gateway", lane);
      } else if (kind === "custom") {
        fields = {
          ...ownedConsumerGatewayFields("com.example.gateway", lane),
          "EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL": "com.example.gateway",
        };
      } else {
        fields = {
          Label: "ai.openclaw.consumer.malformed.gateway",
          "ProgramArguments:0": "/usr/bin/node",
          "ProgramArguments:1": path.join(lane, "dist/index.js"),
          "ProgramArguments:2": "gateway",
          WorkingDirectory: lane,
        };
      }
      writePlistFixture(blockingPlist, fields);

      const result = runGc(main, {
        home,
        launchAgents,
        launchctl: tools.launchctl,
        plistBuddy: tools.plistBuddy,
        quarantine,
      });

      expect(result.status).toBe(1);
      expect(fs.existsSync(lane)).toBe(true);
      expect(fs.existsSync(blockingPlist)).toBe(true);
      expect(fs.existsSync(quarantine)).toBe(false);
      expect(fs.existsSync(tools.launchctlLog)).toBe(false);
      expect(result.stderr).toContain(
        "LaunchAgent references worktree without authorized consumer gateway identity",
      );
      expect(result.stderr).toContain("LaunchAgent retirement failed");
    },
  );

  it("preserves the worktree when its owned LaunchAgent cannot be quarantined", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(root, "quarantine-blocker");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(quarantine, "not a directory\n");

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("preserving worktree");
    expect(result.stderr).toContain("LaunchAgent retirement failed");
  });

  it("refuses to overwrite an existing quarantine artifact", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(quarantine, { recursive: true });

    const ownedPlist = path.join(launchAgents, "owned.plist");
    const oldQuarantine = path.join(quarantine, path.basename(ownedPlist));
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );
    fs.writeFileSync(oldQuarantine, "older reversible artifact\n");

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.readFileSync(oldQuarantine, "utf8")).toBe("older reversible artifact\n");
    expect(fs.existsSync(tools.launchctlLog)).toBe(false);
    expect(result.stderr).toContain("quarantine destination already exists");
  });

  it("restores the plist and preserves the worktree when a loaded job cannot boot out", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlBootoutFails: true,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(false);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toContain("source_present=0 bootout");
    expect(result.stderr).toContain("restored plist and preserved worktree");
  });

  it("accepts explicit service-not-found evidence without attempting bootout", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "absent",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(lane)).toBe(false);
    expect(fs.existsSync(ownedPlist)).toBe(false);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(true);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toContain("source_present=0 print");
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).not.toContain("bootout");
  });

  it("restores the plist and preserves the worktree on ambiguous launchctl print failure", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      launchctlPrintMode: "ambiguous-error",
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(false);
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).toContain("source_present=0 print");
    expect(fs.readFileSync(tools.launchctlLog, "utf8")).not.toContain("bootout");
    expect(result.stderr).toContain(
      "launchctl print failed without service-not-found confirmation",
    );
    expect(result.stderr).toContain("restored plist and preserved worktree");
  });

  it("rolls back retirement and fails when Git cannot remove the worktree", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(launchAgents, { recursive: true });

    const ownedPlist = path.join(launchAgents, "owned.plist");
    writePlistFixture(
      ownedPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.merged-lane.gateway", lane),
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
      gitRemoveFails: true,
    });

    expect(result.status).toBe(1);
    expect(fs.existsSync(lane)).toBe(true);
    expect(fs.existsSync(ownedPlist)).toBe(true);
    expect(fs.existsSync(path.join(quarantine, path.basename(ownedPlist)))).toBe(false);
    const launchctlLog = fs.readFileSync(tools.launchctlLog, "utf8");
    expect(launchctlLog).toContain("source_present=0 bootout");
    expect(launchctlLog).toContain("bootstrap");
    expect(result.stderr).toContain("git worktree remove failed");
    expect(result.stderr).toContain("Rolled back retired LaunchAgents");
    expect(result.stderr).toContain("preserved because Git removal failed");
  });

  it("still releases a claimed Telegram tester token before removing the worktree", () => {
    const root = makeTempRoot();
    const { main, lane } = initRepoWithMergedWorktree(root);
    const home = path.join(root, "home");
    const launchAgents = path.join(home, "Library/LaunchAgents");
    const quarantine = path.join(launchAgents, "gc-quarantine");
    const releaseLog = path.join(root, "release.log");
    const tools = makeToolFixtures(root);
    fs.mkdirSync(path.join(lane, "scripts"), { recursive: true });
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(path.join(lane, ".env.local"), "TELEGRAM_BOT_TOKEN=1234:test-token\n");
    fs.writeFileSync(
      path.join(lane, "scripts/telegram-live-runtime.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${releaseLog}"\n`,
    );

    const result = runGc(main, {
      home,
      launchAgents,
      launchctl: tools.launchctl,
      plistBuddy: tools.plistBuddy,
      quarantine,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(releaseLog, "utf8")).toBe("release\n");
    expect(fs.existsSync(lane)).toBe(false);
  });
});
