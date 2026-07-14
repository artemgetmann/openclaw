import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];

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
  fs.mkdirSync(binDir, { recursive: true });

  const plistBuddy = path.join(binDir, "plistbuddy");
  writeExecutable(
    plistBuddy,
    `#!/usr/bin/env bash
set -euo pipefail
key="\${2#Print :}"
file="\${3}"
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
if [[ "$1" == "bootout" && "\${OPENCLAW_TEST_LAUNCHCTL_BOOTOUT_FAIL:-0}" == "1" ]]; then
  exit 1
fi
`,
  );

  return { launchctl, launchctlLog, plistBuddy };
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
  },
) {
  return spawnSync("bash", [path.join(repoRoot, "scripts/gc-worktrees.sh"), "--auto"], {
    cwd: main,
    env: {
      ...process.env,
      HOME: env.home,
      OPENCLAW_LAUNCHCTL_BIN: env.launchctl,
      OPENCLAW_PLISTBUDDY_BIN: env.plistBuddy,
      OPENCLAW_WORKTREE_GC_LAUNCH_AGENTS_DIR: env.launchAgents,
      OPENCLAW_WORKTREE_GC_QUARANTINE_DIR: env.quarantine,
      OPENCLAW_TEST_LAUNCHCTL_BOOTOUT_FAIL: env.launchctlBootoutFails ? "1" : "0",
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

describe("gc-worktrees LaunchAgent retirement", () => {
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

    // Canonical services stay protected even when every other metadata field is
    // hostile or stale. GC must never turn malformed canonical state into an
    // authority grant to unload the daily Jarvis runtime.
    const jarvisPlist = path.join(launchAgents, "ai.jarvis.gateway.plist");
    writePlistFixture(jarvisPlist, ownedConsumerGatewayFields("ai.jarvis.gateway", lane));

    // A prefix collision is not ownership: /lane-old must not be claimed by
    // /lane. This proves the path check has a directory boundary.
    const siblingPlist = path.join(launchAgents, "sibling.plist");
    writePlistFixture(
      siblingPlist,
      ownedConsumerGatewayFields("ai.openclaw.consumer.sibling.gateway", `${lane}-old`, "sibling"),
    );

    // Even complete consumer-looking metadata is insufficient when the label
    // is custom. Only the generated per-instance identity contract is within
    // GC's authority.
    const customPlist = path.join(launchAgents, "custom.plist");
    writePlistFixture(customPlist, {
      ...ownedConsumerGatewayFields("com.example.gateway", lane),
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
