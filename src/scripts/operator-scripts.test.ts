import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-operator-scripts-"));
  tempRoots.push(dir);
  return dir;
}

function writeExecutable(filePath: string, body: string) {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      // Keep tests quick when a script intentionally polls.
      OPENCLAW_PR_REQUIRED_POLL_SECONDS: "0",
    },
    encoding: "utf8",
  });
}

function initMainRepo(root: string) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "test fixture"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function jarvisLaunchctlFixture(
  stateDir: string,
  options: {
    wrongRuntime?: boolean;
    prefixOnlyRuntime?: boolean;
    listUnavailable?: boolean;
    openclawLoadedOnPrint?: boolean;
    serviceLabel?: string;
  } = {},
) {
  const serviceLabel = options.serviceLabel ?? "ai.jarvis.gateway";
  const jarvisHome = path.dirname(stateDir);
  const nodeBin = options.wrongRuntime
    ? "/tmp/wrong-openclaw/node"
    : options.prefixOnlyRuntime
      ? `${path.join(stateDir, "tools", "node", "bin", "node")}.old`
      : path.join(stateDir, "tools", "node", "bin", "node");
  const entrypoint = options.wrongRuntime
    ? "/tmp/wrong-openclaw/dist/index.js"
    : options.prefixOnlyRuntime
      ? `${path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js")}.old`
      : path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
  const runtimeRoot = options.wrongRuntime
    ? "/tmp/wrong-openclaw"
    : options.prefixOnlyRuntime
      ? `${path.join(stateDir, "lib", "openclaw-bundled")}-backup`
      : path.join(stateDir, "lib", "openclaw-bundled");
  const home = path.resolve(jarvisHome, "..", "..", "..");

  return `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  list)
    ${options.listUnavailable ? "exit 1" : `printf '%s\\n' '85294 0 ${serviceLabel}'`}
    ;;
  print)
    case "\${2:-}" in
      *ai.openclaw.gateway)
        ${
          options.openclawLoadedOnPrint
            ? "printf '%s\\n' 'gui/501/ai.openclaw.gateway = {' '  state = running' '  pid = 11111' '}'"
            : "exit 113"
        }
        ;;
      *${serviceLabel}) ;;
      *) exit 113 ;;
    esac
    cat <<'EOF'
gui/501/${serviceLabel} = {
  state = running
  program = ${nodeBin}
  arguments = {
    ${nodeBin}
    ${entrypoint}
    gateway
    --port
    18789
  }
  working directory = ${runtimeRoot}
  environment = {
    HOME => ${home}
    OPENCLAW_HOME => ${jarvisHome}
    OPENCLAW_STATE_DIR => ${stateDir}
    OPENCLAW_CONFIG_PATH => ${stateDir}/openclaw.json
    OPENCLAW_LOG_DIR => ${stateDir}/logs
    OPENCLAW_LAUNCHD_LABEL => ${serviceLabel}
    OPENCLAW_PROFILE => consumer
    OPENCLAW_GATEWAY_PORT => 18789
  }
  pid = 85294
}
EOF
    ;;
  *)
    exit 9
    ;;
esac
`;
}

function writeJarvisRuntimeLog(
  stateDir: string,
  options: {
    commit?: string;
    omitCommit?: boolean;
    serviceLabel?: string;
    runtimeSource?: string;
  } = {},
) {
  const logDir = path.join(stateDir, "logs");
  const fields = [
    `branch=unknown`,
    `worktree=${path.join(stateDir, "lib", "openclaw-bundled")}`,
    `stateDir=${stateDir}`,
    `configPath=${path.join(stateDir, "openclaw.json")}`,
    `serviceLabel=${options.serviceLabel ?? "ai.jarvis.gateway"}`,
    `launchServiceVersion=2026.6.28`,
    `runtimePackageVersion=2026.6.28`,
  ];

  if (!options.omitCommit) {
    fields.push(`runtimeCommit=${options.commit ?? "389c0513cf"}`);
  }

  fields.push(`runtimeSource=${options.runtimeSource ?? "jarvis-managed-bundle"}`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, ".consumer-bundled-runtime.json"),
    JSON.stringify({
      format: 1,
      bundleVersion: "300",
      gitCommit: options.commit ?? "389c0513cf",
    }),
  );
  fs.writeFileSync(
    path.join(logDir, "gateway.log"),
    `2026-06-29T17:24:27.009+08:00 [gateway] runtime identity: ${fields.join(" ")}\n`,
  );
}

function writeJarvisProofFixture(
  options: {
    commit?: string;
    manifestCommit?: string;
    runtimeSource?: "jarvis-managed-bundle" | "jarvis-break-glass-hotfix";
    statusRuntimeSource?: "jarvis-managed-bundle" | "jarvis-break-glass-hotfix";
    serviceLabel?: string;
    protection?: {
      protectedRuntimeGitCommit: string;
      compatibilityManifestGitCommit: string;
      compatibilityManifestBundleVersion: string;
      backupCommit?: string;
    };
    launchctl?: Parameters<typeof jarvisLaunchctlFixture>[1];
  } = {},
) {
  const root = makeTempRoot();
  const home = path.join(root, "home");
  const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
  const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
  const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
  const appPath = path.join(root, "Applications", "Jarvis.app");
  const appManifest = path.join(
    appPath,
    "Contents",
    "Resources",
    "OpenClawRuntime",
    "manifest.json",
  );
  const binDir = path.join(root, "bin");
  const commit = options.commit ?? "389c0513cf";
  const runtimeSource = options.runtimeSource ?? "jarvis-managed-bundle";
  const serviceLabel = options.serviceLabel ?? "ai.jarvis.gateway";
  fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(appManifest), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(entrypoint, "fixture\n");
  writeExecutable(
    nodeBin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"${serviceLabel}","runtimeSource":"${options.statusRuntimeSource ?? runtimeSource}","runtimeCommit":"${commit}","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
  );
  writeExecutable(
    path.join(binDir, "launchctl"),
    jarvisLaunchctlFixture(stateDir, { ...options.launchctl, serviceLabel }),
  );
  writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
  writeJarvisRuntimeLog(stateDir, { commit, runtimeSource, serviceLabel });
  fs.writeFileSync(
    path.join(stateDir, ".consumer-bundled-runtime.json"),
    JSON.stringify({
      format: 1,
      bundleVersion: "300",
      gitCommit: options.manifestCommit ?? commit,
    }),
  );
  fs.writeFileSync(
    appManifest,
    JSON.stringify({
      format: 1,
      bundleVersion: "300",
      gitCommit: options.manifestCommit ?? commit,
    }),
  );
  if (options.protection) {
    const backupPath = path.join(stateDir, ".consumer-bundled-runtime.json.backup.fixture");
    fs.writeFileSync(
      backupPath,
      JSON.stringify({
        format: 1,
        bundleVersion: "301",
        gitCommit: options.protection.backupCommit ?? commit,
      }),
    );
    fs.writeFileSync(
      path.join(stateDir, ".consumer-bundled-runtime.protection.json"),
      JSON.stringify({
        format: 1,
        ...options.protection,
        compatibilityManifestSource: appPath,
        backupPath,
      }),
    );
  }
  return { home, stateDir, binDir, appPath };
}

function jarvisLsofFixture(stateDir: string, options: { includeGatewayLog?: boolean } = {}) {
  const gatewayLog = path.join(stateDir, "logs", "gateway.log");
  const includeGatewayLog = options.includeGatewayLog ?? true;

  return `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "-nP -iTCP:18789 -sTCP:LISTEN")
    printf '%s\\n' 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'
    printf '%s\\n' 'node    85294 user   15u  IPv4  0x1      0t0  TCP 127.0.0.1:18789 (LISTEN)'
    ;;
  "-nP -p 85294")
    printf '%s\\n' 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'
    ${includeGatewayLog ? `printf '%s\\n' 'node    85294 user    1w   REG    1,4      1000 123 ${gatewayLog}'` : ":"}
    ;;
  *)
    exit 9
    ;;
esac
`;
}

function jarvisPlistBuddyFixture(stateDir: string) {
  const jarvisHome = path.dirname(stateDir);
  const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
  const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
  const runtimeRoot = path.join(stateDir, "lib", "openclaw-bundled");

  return `#!/usr/bin/env bash
set -euo pipefail
key="\${2#Print :}"
case "$key" in
  ProgramArguments:0) printf '%s\\n' '${nodeBin}' ;;
  ProgramArguments:1) printf '%s\\n' '${entrypoint}' ;;
  ProgramArguments:2) printf '%s\\n' 'gateway' ;;
  ProgramArguments:3) printf '%s\\n' '--port' ;;
  ProgramArguments:4) printf '%s\\n' '18789' ;;
  WorkingDirectory) printf '%s\\n' '${runtimeRoot}' ;;
  EnvironmentVariables:OPENCLAW_HOME) printf '%s\\n' '${jarvisHome}' ;;
  EnvironmentVariables:OPENCLAW_STATE_DIR) printf '%s\\n' '${stateDir}' ;;
  EnvironmentVariables:OPENCLAW_CONFIG_PATH) printf '%s\\n' '${stateDir}/openclaw.json' ;;
  EnvironmentVariables:OPENCLAW_LOG_DIR) printf '%s\\n' '${stateDir}/logs' ;;
  EnvironmentVariables:OPENCLAW_LAUNCHD_LABEL) printf '%s\\n' 'ai.jarvis.gateway' ;;
  EnvironmentVariables:OPENCLAW_PROFILE) printf '%s\\n' 'consumer' ;;
  EnvironmentVariables:OPENCLAW_GATEWAY_PORT) printf '%s\\n' '18789' ;;
  *) exit 1 ;;
esac
`;
}

function writeJarvisUnlockProofFixture(
  options: {
    wrongRuntime?: boolean;
    missingNoAutoLeaseSupport?: boolean;
    runtimeSource?: string;
  } = {},
) {
  const root = makeTempRoot();
  const home = path.join(root, "home");
  const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
  const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
  const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
  const workspaceBin = path.join(stateDir, "workspace", "bin");
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const tccDir = path.join(home, "Library", "Application Support", "com.apple.TCC");
  const binDir = path.join(root, "bin");

  fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(workspaceBin, { recursive: true });
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.mkdirSync(tccDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(entrypoint, "fixture\n");
  fs.writeFileSync(path.join(launchAgents, "ai.jarvis.gateway.plist"), "<plist/>\n");
  fs.writeFileSync(path.join(tccDir, "TCC.db"), "fixture\n");

  writeExecutable(
    nodeBin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"${options.runtimeSource ?? "jarvis-managed-bundle"}","runtimeCommit":"389c0513cf","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
  );
  writeExecutable(
    path.join(workspaceBin, "openclaw-mac-unlock-session.sh"),
    options.missingNoAutoLeaseSupport
      ? '#!/usr/bin/env bash\ncase "${1:-status}" in status) echo active=false ;; *) exit 0 ;; esac\n'
      : '#!/usr/bin/env bash\n# supports --no-auto-lease and auto_lock=armed phase=auto_relock\ncase "${1:-status}" in status) echo active=false ;; *) exit 0 ;; esac\n',
  );
  writeExecutable(path.join(workspaceBin, "openclaw-unlock.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    path.join(workspaceBin, "openclaw-gui-lease.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir, options));
  writeExecutable(path.join(binDir, "plistbuddy"), jarvisPlistBuddyFixture(stateDir));
  writeExecutable(path.join(binDir, "sqlite3"), "#!/usr/bin/env bash\nprintf '%s\\n' 2\n");

  return { root, home, stateDir, binDir };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("operator shell scripts", () => {
  it("reports green pr-required checks quietly", () => {
    const root = makeTempRoot();
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "pr checks 123 --required --json name,bucket,state,workflow" ]]; then
  printf '%s\\n' '[{"name":"pr-required","bucket":"pass","state":"SUCCESS"},{"name":"check","bucket":"pass","state":"SUCCESS"}]'
  exit 0
fi
exit 9
`,
    );

    const result = runScript("scripts/pr-required-status.sh", ["--pr", "123"], {
      OPENCLAW_GH_BIN: gh,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pr-required=pass required_checks=2");
    expect(result.stdout).not.toContain("check [");
  });

  it("prints failed checks only before returning failure", () => {
    const root = makeTempRoot();
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '[{"name":"pr-required","bucket":"fail","state":"FAILURE"},{"name":"check","bucket":"pass","state":"SUCCESS"},{"name":"tests","bucket":"fail","state":"FAILURE"}]'
`,
    );

    const result = runScript("scripts/pr-required-status.sh", ["--pr", "123"], {
      OPENCLAW_GH_BIN: gh,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("failed required check");
    expect(result.stdout).toContain("pr-required [FAILURE]");
    expect(result.stdout).toContain("tests [FAILURE]");
    expect(result.stdout).not.toContain("check [SUCCESS]");
  });

  it("returns pending when pr-required is still running", () => {
    const root = makeTempRoot();
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '[{"name":"pr-required","bucket":"pending","state":"IN_PROGRESS"}]'
`,
    );

    const result = runScript("scripts/pr-required-status.sh", ["--pr", "123"], {
      OPENCLAW_GH_BIN: gh,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("still-running required check");
    expect(result.stdout).toContain("pr-required [IN_PROGRESS]");
  });

  it("ship wrapper refuses non-main PR targets", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    initMainRepo(mainRepo);
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "pr view 77 --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,title,url" ]]; then
  printf '%s\\n' '{"number":77,"state":"OPEN","isDraft":false,"baseRefName":"consumer","headRefName":"x","headRefOid":"abc","title":"Nope","url":"https://example.test/pr/77"}'
  exit 0
fi
exit 9
`,
    );

    const result = runScript("scripts/ship-main-gateway-fix.sh", ["--pr", "77", "--dry-run"], {
      OPENCLAW_GH_BIN: gh,
      OPENCLAW_MAIN_REPO: mainRepo,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("baseRefName=consumer, expected main");
  });

  it("ship wrapper dry-run prints planned deploy and closeout fields", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    initMainRepo(mainRepo);
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "pr view 88 --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,title,url")
    printf '%s\\n' '{"number":88,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefName":"x","headRefOid":"abc","title":"Fix gateway","url":"https://example.test/pr/88"}'
    ;;
  "pr view 88 --json files --jq .files[].path")
    printf '%s\\n' 'scripts/example.sh'
    ;;
  *)
    exit 9
    ;;
esac
`,
    );

    const result = runScript("scripts/ship-main-gateway-fix.sh", ["--pr", "88", "--dry-run"], {
      OPENCLAW_GH_BIN: gh,
      OPENCLAW_MAIN_REPO: mainRepo,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("+ cd");
    expect(result.stdout).toContain("scripts/build-shared-runtime.sh");
    expect(result.stdout).toContain("PR: https://example.test/pr/88");
    expect(result.stdout).toContain("Live proof: skipped");
    expect(result.stdout).toContain("Rollback:");
  });

  it("ship wrapper checks redundant PR ancestry from sacred main, not caller worktree", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    const callerRepo = path.join(root, "caller");
    initMainRepo(mainRepo);
    initMainRepo(callerRepo);
    const originRepo = path.join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", originRepo]);
    execFileSync("git", ["remote", "add", "origin", originRepo], { cwd: mainRepo });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: mainRepo });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: mainRepo,
      encoding: "utf8",
    }).trim();
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "pr view 92 --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,title,url" ]]; then
  printf '%s\\n' '{"number":92,"state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"x","headRefOid":"${headSha}","title":"Already there","url":"https://example.test/pr/92"}'
  exit 0
fi
exit 9
`,
    );

    const result = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-main-gateway-fix.sh"), "--pr", "92", "--dry-run"],
      {
        cwd: callerRepo,
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: gh,
          OPENCLAW_MAIN_REPO: mainRepo,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already reachable from origin/main");
    expect(result.stderr).not.toContain("not a git repository");
  });

  it("ship wrapper dry-run has an explicit read-only Jarvis runtime scope", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    initMainRepo(mainRepo);
    const gh = path.join(root, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "pr view 90 --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,title,url")
    printf '%s\\n' '{"number":90,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefName":"x","headRefOid":"abc","title":"Fix Jarvis","url":"https://example.test/pr/90"}'
    ;;
  "pr view 90 --json files --jq .files[].path")
    printf '%s\\n' 'scripts/prove-jarvis-runtime.sh'
    ;;
  *)
    exit 9
    ;;
esac
`,
    );

    const result = runScript(
      "scripts/ship-main-gateway-fix.sh",
      ["--pr", "90", "--runtime-scope", "jarvis", "--dry-run"],
      {
        OPENCLAW_GH_BIN: gh,
        OPENCLAW_MAIN_REPO: mainRepo,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("scripts/prove-jarvis-runtime.sh --expected-commit");
    expect(result.stdout).toContain("Runtime scope: jarvis");
    expect(result.stdout).toContain("read-only Jarvis proof only");
    expect(result.stdout).not.toContain("ai.openclaw.gateway");
    expect(result.stdout).not.toContain("scripts/build-shared-runtime.sh");
    expect(result.stdout).not.toContain("scripts/gateway-recover-main.sh");
  });

  it("ship wrapper refuses OpenClaw restart smoke in Jarvis runtime scope", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    initMainRepo(mainRepo);
    const gh = path.join(root, "gh");
    writeExecutable(gh, "#!/usr/bin/env bash\nexit 9\n");

    const result = runScript(
      "scripts/ship-main-gateway-fix.sh",
      ["--pr", "91", "--runtime-scope", "jarvis", "--live-telegram-restart", "--dry-run"],
      {
        OPENCLAW_GH_BIN: gh,
        OPENCLAW_MAIN_REPO: mainRepo,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not ai.jarvis.gateway");
  });

  it("Jarvis hotfix dry-run prints the fail-closed ship plan without invoking mutations", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    const stateDir = path.join(root, "home", "Library", "Application Support", "Jarvis", ".jarvis");
    const callsLog = path.join(root, "calls.log");
    const normalBuildLog = path.join(root, "normal-build.log");
    const installedAppManifest = path.join(root, "installed-app-manifest.json");
    const prStateFile = path.join(root, "pr-state");
    const releaseLockPath = path.join(root, "dry-run-release.lock");
    const mergedSha = "feedfacefeedfacefeedfacefeedfacefeedface";
    const binDir = path.join(root, "bin");
    initMainRepo(mainRepo);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(stateDir, ".consumer-bundled-runtime.json"),
      JSON.stringify({ format: 1, bundleVersion: "300", gitCommit: "389c0513cf" }),
    );
    fs.writeFileSync(
      installedAppManifest,
      JSON.stringify({ format: 1, bundleVersion: "299", gitCommit: "a1b2c3d4e5" }),
    );
    fs.writeFileSync(prStateFile, "merged\n");

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: mainRepo,
      encoding: "utf8",
    }).trim();
    const gh = path.join(binDir, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "pr view 123 --json number,state,isDraft,baseRefName,headRefOid,mergeCommit,title,url" ]]; then
  if [[ "$(cat '${prStateFile}')" == "open" ]]; then
    printf '%s\\n' '{"number":123,"state":"OPEN","isDraft":false,"baseRefName":"main","headRefOid":"abcdef1234567890abcdef1234567890abcdef12","mergeCommit":null,"title":"Fix Jarvis","url":"https://example.test/pr/123"}'
  else
    printf '%s\\n' '{"number":123,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"${headSha}","mergeCommit":{"oid":"${mergedSha}"},"title":"Fix Jarvis","url":"https://example.test/pr/123"}'
  fi
  exit 0
fi
exit 9
`,
    );
    const mutationStub = path.join(binDir, "mutation-stub");
    writeExecutable(
      mutationStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${callsLog}'
exit 91
`,
    );
    const canonicalBuildNode = path.join(binDir, "canonical-build-node");
    writeExecutable(
      canonicalBuildNode,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${normalBuildLog}'
printf '%s\\n' '250'
`,
    );

    const dryRunEnv = {
      ...process.env,
      OPENCLAW_GH_BIN: gh,
      OPENCLAW_MAIN_REPO: mainRepo,
      OPENCLAW_EXPECTED_MAIN_REPO: mainRepo,
      OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE: "1",
      OPENCLAW_SHIP_INSTALLED_MANIFEST: path.join(stateDir, ".consumer-bundled-runtime.json"),
      OPENCLAW_SHIP_INSTALLED_APP_MANIFEST: installedAppManifest,
      OPENCLAW_JARVIS_STATE_DIR: stateDir,
      OPENCLAW_SHIP_INSTALLED_APP_VERSION: "2026.7.14.1",
      OPENCLAW_NODE_BIN: canonicalBuildNode,
      OPENCLAW_SHIP_PR_REQUIRED_SCRIPT: mutationStub,
      OPENCLAW_SHIP_PACKAGE_SCRIPT: mutationStub,
      OPENCLAW_SHIP_OPEN_APP_SCRIPT: mutationStub,
      OPENCLAW_SHIP_PROTECT_SCRIPT: mutationStub,
      OPENCLAW_SHIP_PROVE_RUNTIME_SCRIPT: mutationStub,
      OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE: releaseLockPath,
    };
    const result = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "123", "--dry-run"],
      {
        cwd: mainRepo,
        env: dryRunEnv,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--wait --timeout 1800");
    expect(result.stdout).toContain(
      "already merged; required checks still remain part of ship proof",
    );
    expect(result.stdout).not.toContain("pr merge 123 --squash");
    expect(result.stdout).toContain("pull --ff-only origin main");
    expect(result.stdout).toContain(`MERGED PR dry-run models remote merge commit ${mergedSha}`);
    expect(result.stdout).toContain(`commit=${mergedSha}`);
    expect(result.stdout).toContain("APP_BUILD=301");
    expect(result.stdout).toContain("APP_VERSION=2026.7.14.1");
    expect(result.stdout).toContain("ALLOW_SINGLE_ARCH_CONSUMER_SMOKE=1");
    expect(result.stdout).toContain("SKIP_PNPM_INSTALL=0");
    expect(result.stdout).toContain("SKIP_TSC=0");
    expect(result.stdout).toContain("dist/Jarvis.app");
    expect(result.stdout).toContain("kickstart -k");
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).toContain("no merge, pull, package, app launch, gateway restart");
    expect(fs.readFileSync(normalBuildLog, "utf8")).toContain("canonical-build 2026.7.14.1");
    expect(fs.existsSync(callsLog)).toBe(false);
    expect(fs.existsSync(releaseLockPath)).toBe(false);

    fs.writeFileSync(
      installedAppManifest,
      JSON.stringify({ format: 1, bundleVersion: "301", gitCommit: mergedSha }),
    );
    const sameCommitResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "123", "--dry-run"],
      { cwd: mainRepo, env: dryRunEnv, encoding: "utf8" },
    );
    expect(sameCommitResult.status).toBe(1);
    expect(sameCommitResult.stderr).toContain("installed Jarvis app already contains commit");
    expect(sameCommitResult.stderr).toContain("use scripts/prove-jarvis-runtime.sh");
    expect(sameCommitResult.stdout).not.toContain("APP_VERSION=");

    fs.writeFileSync(prStateFile, "open\n");
    const openProspectiveResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "123", "--dry-run"],
      { cwd: mainRepo, env: dryRunEnv, encoding: "utf8" },
    );
    expect(openProspectiveResult.status).toBe(0);
    expect(openProspectiveResult.stdout).toContain("pr merge 123 --squash --delete-branch");
    expect(openProspectiveResult.stdout).toContain(
      "OPEN PR dry-run uses prospective commit <post-merge-main>",
    );
    expect(openProspectiveResult.stdout).toContain("real commit resolves after merge and git pull");
    expect(openProspectiveResult.stdout).toContain("commit=<post-merge-main>");
    expect(openProspectiveResult.stdout).toContain("APP_VERSION=2026.7.14.1");
    expect(openProspectiveResult.stdout).toContain("APP_BUILD=301");
    expect(fs.existsSync(callsLog)).toBe(false);
  });

  it("Jarvis hotfix wrapper refuses a dirty sacred main before querying GitHub", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    const binDir = path.join(root, "bin");
    const ghCalls = path.join(root, "gh-calls.log");
    initMainRepo(mainRepo);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(mainRepo, "dirty.txt"), "operator state\n");
    const gh = path.join(binDir, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${ghCalls}'
exit 9
`,
    );
    const helper = path.join(binDir, "helper");
    writeExecutable(helper, "#!/usr/bin/env bash\nexit 0\n");

    const result = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "123", "--dry-run"],
      {
        cwd: mainRepo,
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: gh,
          OPENCLAW_MAIN_REPO: mainRepo,
          OPENCLAW_EXPECTED_MAIN_REPO: mainRepo,
          OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE: "1",
          OPENCLAW_SHIP_PR_REQUIRED_SCRIPT: helper,
          OPENCLAW_SHIP_PACKAGE_SCRIPT: helper,
          OPENCLAW_SHIP_OPEN_APP_SCRIPT: helper,
          OPENCLAW_SHIP_PROTECT_SCRIPT: helper,
          OPENCLAW_SHIP_PROVE_RUNTIME_SCRIPT: helper,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sacred main has local changes");
    expect(fs.existsSync(ghCalls)).toBe(false);
  });

  it("protects and verifies an exact offline seeded Jarvis payload", () => {
    const root = makeTempRoot();
    const appPath = path.join(root, "Applications", "Jarvis.app");
    const appManifest = path.join(
      appPath,
      "Contents",
      "Resources",
      "OpenClawRuntime",
      "manifest.json",
    );
    const stateDir = path.join(root, "Jarvis", ".jarvis");
    const installedManifest = path.join(stateDir, ".consumer-bundled-runtime.json");
    const markerPath = path.join(stateDir, ".consumer-bundled-runtime.protection.json");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    fs.mkdirSync(path.dirname(appManifest), { recursive: true });
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(
      appManifest,
      JSON.stringify({ format: 1, bundleVersion: "299", gitCommit: "not-a-sha" }),
    );
    fs.writeFileSync(
      installedManifest,
      JSON.stringify({ format: 1, bundleVersion: "301", gitCommit: "389c0513cf" }),
    );
    writeExecutable(nodeBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(entrypoint, "fixture\n");

    const baseArgs = [
      "--expected-live-commit",
      "389c0513cf",
      "--app",
      appPath,
      "--state-dir",
      stateDir,
      "--offline-seeded-fallback",
    ];
    const malformedAppResult = runScript("scripts/protect-jarvis-runtime-from-app-reseed.sh", [
      ...baseArgs,
      "--apply",
    ]);
    expect(malformedAppResult.status).toBe(1);
    expect(malformedAppResult.stderr).toContain("app manifest gitCommit is missing or invalid");
    expect(JSON.parse(fs.readFileSync(installedManifest, "utf8")).gitCommit).toBe("389c0513cf");
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.writeFileSync(
      appManifest,
      JSON.stringify({ format: 1, bundleVersion: "299", gitCommit: "a1b2c3d4e5" }),
    );
    const applyResult = runScript("scripts/protect-jarvis-runtime-from-app-reseed.sh", [
      ...baseArgs,
      "--apply",
    ]);
    expect(applyResult.status, applyResult.stderr).toBe(0);
    expect(applyResult.stdout).toContain("offline_seeded_fallback_applied=true");
    expect(applyResult.stdout).toContain("offline_seeded_fallback_verified=true");
    expect(JSON.parse(fs.readFileSync(installedManifest, "utf8"))).toMatchObject({
      bundleVersion: "299",
      gitCommit: "a1b2c3d4e5",
    });
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(marker).toMatchObject({
      protectedRuntimeGitCommit: "389c0513cf",
      compatibilityManifestGitCommit: "a1b2c3d4e5",
      compatibilityManifestBundleVersion: "299",
    });
    expect(JSON.parse(fs.readFileSync(marker.backupPath, "utf8"))).toMatchObject({
      bundleVersion: "301",
      gitCommit: "389c0513cf",
    });

    const verifyResult = runScript("scripts/protect-jarvis-runtime-from-app-reseed.sh", [
      ...baseArgs,
      "--verify",
    ]);
    expect(verifyResult.status, verifyResult.stderr).toBe(0);
    expect(verifyResult.stdout).toContain("offline_seeded_fallback_verified=true");

    // Simulate interruption after the compatibility manifest landed but its
    // marker disappeared. Recovery may reuse only the expected-seed backup.
    fs.rmSync(markerPath);
    fs.writeFileSync(
      marker.backupPath,
      JSON.stringify({ format: 1, bundleVersion: "301", gitCommit: "bad" }),
    );
    const malformedBackupResult = runScript("scripts/protect-jarvis-runtime-from-app-reseed.sh", [
      ...baseArgs,
      "--apply",
    ]);
    expect(malformedBackupResult.status).toBe(1);
    expect(malformedBackupResult.stderr).toContain(
      "compatibility manifest exists without a verified backup",
    );
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.writeFileSync(
      marker.backupPath,
      JSON.stringify({ format: 1, bundleVersion: "301", gitCommit: "389c0513cf" }),
    );
    const recoveryResult = runScript("scripts/protect-jarvis-runtime-from-app-reseed.sh", [
      ...baseArgs,
      "--apply",
    ]);
    expect(recoveryResult.status, recoveryResult.stderr).toBe(0);
    expect(recoveryResult.stdout).toContain("offline_seeded_fallback_applied=true");
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      protectedRuntimeGitCommit: "389c0513cf",
      compatibilityManifestGitCommit: "a1b2c3d4e5",
    });
  });

  it("Jarvis hotfix waits for the replacement gateway RPC before protecting and prints redacted proof", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    const originRepo = path.join(root, "origin.git");
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const manifest = path.join(stateDir, ".consumer-bundled-runtime.json");
    const marker = path.join(stateDir, ".consumer-bundled-runtime.protection.json");
    const configPath = path.join(stateDir, "openclaw.json");
    const installedAppManifest = path.join(root, "installed-app-manifest.json");
    const logDir = path.join(stateDir, "logs");
    const callsLog = path.join(root, "calls.log");
    const launchctlCount = path.join(root, "launchctl-count");
    const statusCount = path.join(root, "status-count");
    const forceStatusFailure = path.join(root, "force-status-failure");
    const forceOpenFailure = path.join(root, "force-open-failure");
    const forcePostLaunchFailure = path.join(root, "force-post-launch-failure");
    const forceMalformedAppCommit = path.join(root, "force-malformed-app-commit");
    const forceAdvancedMain = path.join(root, "force-advanced-main");
    const kicked = path.join(root, "kicked");
    const releaseLockPath = path.join(root, "jarvis-release.lock");
    const binDir = path.join(root, "bin");
    const token = "123456789:super-secret-token-value";
    initMainRepo(mainRepo);
    const requestedAncestorSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: mainRepo,
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(path.join(mainRepo, "NEWER.md"), "unrelated newer main commit\n");
    execFileSync("git", ["add", "NEWER.md"], { cwd: mainRepo });
    execFileSync("git", ["commit", "-q", "-m", "newer main fixture"], {
      cwd: mainRepo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    execFileSync("git", ["init", "-q", "--bare", originRepo]);
    execFileSync("git", ["remote", "add", "origin", originRepo], { cwd: mainRepo });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: mainRepo });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: mainRepo,
      encoding: "utf8",
    }).trim();

    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(binDir);
    fs.writeFileSync(entrypoint, "fixture\n");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ format: 1, bundleVersion: "300", gitCommit: "389c0513cf" }),
    );
    fs.writeFileSync(
      installedAppManifest,
      JSON.stringify({ format: 1, bundleVersion: "299", gitCommit: "a1b2c3d4e5" }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ channels: { telegram: { accounts: { default: { botToken: token } } } } }),
    );
    fs.writeFileSync(
      path.join(logDir, "gateway.log"),
      "2026-07-15T00:00:00Z [telegram] [default] connected @jarvis_test_bot\n",
    );

    const gh = path.join(binDir, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "pr view 124 --json number,state,isDraft,baseRefName,headRefOid,mergeCommit,title,url" ]]; then
  merge_commit='${headSha}'
  if [[ -f '${forceAdvancedMain}' ]]; then merge_commit='${requestedAncestorSha}'; fi
  printf '%s\\n' '{"number":124,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefOid":"${headSha}","mergeCommit":{"oid":"'"$merge_commit"'"},"title":"Fix Jarvis","url":"https://example.test/pr/124"}'
  exit 0
fi
exit 9
`,
    );
    const noOp = path.join(binDir, "no-op");
    writeExecutable(
      noOp,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "pr-required $*" >> '${callsLog}'
`,
    );
    const packageScript = path.join(binDir, "package");
    writeExecutable(
      packageScript,
      `#!/usr/bin/env bash
set -euo pipefail
app='${mainRepo}/dist/Jarvis.app'
mkdir -p "$app/Contents/Resources/OpenClawRuntime/openclaw"
commit='${headSha}'
if [[ -f '${forceMalformedAppCommit}' ]]; then commit='bad'; fi
printf '%s\\n' '{"gitCommit":"'"$commit"'","bundleVersion":"301"}' > "$app/Contents/Resources/OpenClawRuntime/manifest.json"
printf '%s\\n' '{"version":"'"$APP_VERSION"'"}' > "$app/Contents/Resources/OpenClawRuntime/openclaw/package.json"
printf '%s\\n' 'fixture plist' > "$app/Contents/Info.plist"
printf '%s\\n' "package APP_VERSION=$APP_VERSION APP_BUILD=$APP_BUILD BUILD_ARCHS=$BUILD_ARCHS SKIP_PNPM_INSTALL=$SKIP_PNPM_INSTALL SKIP_TSC=$SKIP_TSC" >> '${callsLog}'
`,
    );
    const openScript = path.join(binDir, "open-app");
    writeExecutable(
      openScript,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ -f '${forceOpenFailure}' ]]; then exit 1; fi
if [[ -n "\${OPENCLAW_APP_LAUNCH_RECEIPT:-}" ]]; then
  printf '%s\\n' "$2" > "\${OPENCLAW_APP_LAUNCH_RECEIPT}.tmp"
  mv "\${OPENCLAW_APP_LAUNCH_RECEIPT}.tmp" "\${OPENCLAW_APP_LAUNCH_RECEIPT}"
fi
printf '%s\\n' '{"format":1,"bundleVersion":"301","gitCommit":"${headSha}"}' > '${manifest}'
printf '%s\\n' 'open-app' >> '${callsLog}'
if [[ -f '${forcePostLaunchFailure}' ]]; then exit 17; fi
`,
    );
    const protectScript = path.join(binDir, "protect");
    writeExecutable(
      protectScript,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --offline-seeded-fallback "* && " $* " == *" --verify "* ]]; then
  jq -e --arg commit '${headSha}' '.protectedRuntimeGitCommit == $commit' '${marker}' >/dev/null
  printf '%s\\n' 'offline verify' >> '${callsLog}'
elif [[ " $* " == *" --offline-seeded-fallback "* && " $* " == *" --apply "* ]]; then
  backup='${manifest}.backup.transaction'
  cp '${manifest}' "$backup"
  printf '%s\\n' '{"format":1,"protectedRuntimeGitCommit":"${headSha}","compatibilityManifestGitCommit":"a1b2c3d4e5","compatibilityManifestBundleVersion":"299","backupPath":"'"$backup"'"}' > '${marker}'
  printf '%s\\n' '{"format":1,"bundleVersion":"299","gitCommit":"a1b2c3d4e5"}' > '${manifest}'
  printf '%s\\n' 'offline apply' >> '${callsLog}'
elif [[ " $* " == *" --apply "* ]]; then
  printf '%s\\n' 'protect apply' >> '${callsLog}'
else
  printf '%s\\n' 'protect dry-run' >> '${callsLog}'
fi
`,
    );
    const proveRuntimeScript = path.join(binDir, "prove-runtime");
    writeExecutable(
      proveRuntimeScript,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "status proof $*" >> '${callsLog}'
printf '%s\n' "status proof label=\${OPENCLAW_JARVIS_GATEWAY_LABEL:-missing}" >> '${callsLog}'
printf '%s\n' \
  '[prove-jarvis-runtime] jarvis_runtime_proof=true' \
  '[prove-jarvis-runtime] runtime_source=jarvis-break-glass-hotfix' \
  '[prove-jarvis-runtime] runtime_commit=${headSha}' \
  '[prove-jarvis-runtime] runtime_package_version=2026.7.14.1' \
  '[prove-jarvis-runtime] pid=200' \
  '[prove-jarvis-runtime] listener=127.0.0.1:18789' \
  '[prove-jarvis-runtime] rpc=ok' \
  '[prove-jarvis-runtime] health=healthy'
`,
    );
    const plistBuddy = path.join(binDir, "PlistBuddy");
    writeExecutable(
      plistBuddy,
      `#!/usr/bin/env bash
case "$2" in
  "Print :CFBundleVersion") printf '%s\\n' '301' ;;
  "Print :CFBundleShortVersionString") printf '%s\\n' '2026.7.14.1' ;;
  *) exit 9 ;;
esac
`,
    );
    const launchctl = path.join(binDir, "launchctl");
    writeExecutable(
      launchctl,
      `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  kickstart)
    : > '${kicked}'
    printf '%s\\n' 'kickstart' >> '${callsLog}'
    ;;
  print)
    count=0
    [[ ! -f '${launchctlCount}' ]] || count=$(cat '${launchctlCount}')
    count=$((count + 1))
    printf '%s' "$count" > '${launchctlCount}'
    pid=100
    if [[ -f '${kicked}' && "$count" -ge 3 ]]; then pid=200; fi
    cat <<EOF
gui/501/ai.jarvis.gateway = {
  state = running
  program = ${nodeBin}
  arguments = {
    ${nodeBin}
    ${entrypoint}
    gateway
    --port
    18789
  }
  pid = $pid
}
EOF
    ;;
  *) exit 9 ;;
esac
`,
    );
    const lsof = path.join(binDir, "lsof");
    writeExecutable(
      lsof,
      `#!/usr/bin/env bash
printf '%s\\n' 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'
printf '%s\\n' 'node 200 user 15u IPv4 0x1 0t0 TCP 127.0.0.1:18789 (LISTEN)'
`,
    );
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f '${statusCount}' ]] || count=$(cat '${statusCount}')
count=$((count + 1))
printf '%s' "$count" > '${statusCount}'
printf 'status %s\\n' "$count" >> '${callsLog}'
if [[ -f '${forceStatusFailure}' ]]; then exit 1; fi
if [[ "$count" == "1" ]]; then exit 1; fi
source='jarvis-managed-bundle'
[[ ! -f '${marker}' ]] || source='jarvis-break-glass-hotfix'
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"'"$source"'","runtimeCommit":"${headSha}","runtimePackageVersion":"2026.7.14.1","stateDir":"${stateDir}","configPath":"${configPath}"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
    );

    const liveEnv = {
      ...process.env,
      OPENCLAW_GH_BIN: gh,
      OPENCLAW_MAIN_REPO: mainRepo,
      OPENCLAW_EXPECTED_MAIN_REPO: mainRepo,
      OPENCLAW_SHIP_JARVIS_HOTFIX_TEST_MODE: "1",
      OPENCLAW_SHIP_NORMAL_PACKAGE_BUILD: "250",
      OPENCLAW_SHIP_INSTALLED_APP_VERSION: "2026.7.14.1",
      OPENCLAW_SHIP_PR_REQUIRED_SCRIPT: noOp,
      OPENCLAW_SHIP_PACKAGE_SCRIPT: packageScript,
      OPENCLAW_SHIP_OPEN_APP_SCRIPT: openScript,
      OPENCLAW_SHIP_PROTECT_SCRIPT: protectScript,
      OPENCLAW_SHIP_PROVE_RUNTIME_SCRIPT: proveRuntimeScript,
      OPENCLAW_SHIP_INSTALLED_MANIFEST: manifest,
      OPENCLAW_SHIP_INSTALLED_APP_MANIFEST: installedAppManifest,
      OPENCLAW_SHIP_PROTECTION_MARKER: marker,
      OPENCLAW_JARVIS_HOME: path.dirname(stateDir),
      OPENCLAW_JARVIS_STATE_DIR: stateDir,
      OPENCLAW_JARVIS_CONFIG_PATH: configPath,
      OPENCLAW_JARVIS_LOG_DIR: logDir,
      OPENCLAW_JARVIS_NODE_BIN: nodeBin,
      OPENCLAW_JARVIS_ENTRYPOINT: entrypoint,
      OPENCLAW_LAUNCHCTL_BIN: launchctl,
      OPENCLAW_LSOF_BIN: lsof,
      OPENCLAW_PLISTBUDDY_BIN: plistBuddy,
      OPENCLAW_SHIP_SEED_POLL_SECONDS: "0",
      OPENCLAW_SHIP_GATEWAY_READY_POLL_SECONDS: "0",
      OPENCLAW_SHIP_GATEWAY_READY_TIMEOUT_SECONDS: "5",
      OPENCLAW_JARVIS_RELEASE_LOCK_PATH_OVERRIDE: releaseLockPath,
    };

    // A live canonical release owner must block this wrapper before required
    // checks, package writes, app launch, or any shared runtime mutation.
    const ownerStart = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    })
      .trim()
      .replace(/\s+/g, " ");
    fs.mkdirSync(releaseLockPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(releaseLockPath, "owner"),
      `pid=${process.pid}\ntoken=test-owner\nprocess_start=${ownerStart}\ncontext=fixture-holder\n`,
    );
    const contentionResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      { cwd: mainRepo, env: liveEnv, encoding: "utf8" },
    );
    expect(contentionResult.status).toBe(1);
    expect(contentionResult.stderr).toContain("another Jarvis release owner is active");
    expect(fs.existsSync(callsLog)).toBe(false);
    fs.rmSync(path.join(releaseLockPath, "owner"));
    fs.rmdirSync(releaseLockPath);

    // The requested PR is a real ancestor of local main. Shipping must still
    // stop before package because "contains PR" is weaker than "is PR".
    expect(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", requestedAncestorSha, headSha], {
        cwd: mainRepo,
      }),
    ).not.toThrow();
    fs.writeFileSync(forceAdvancedMain, "1\n");
    const advancedMainResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      { cwd: mainRepo, env: liveEnv, encoding: "utf8" },
    );
    expect(advancedMainResult.status).toBe(1);
    expect(advancedMainResult.stderr).toContain("sacred main advanced beyond requested PR merge");
    expect(advancedMainResult.stderr).toContain("Refusing to package unrelated newer commits");
    const advancedCalls = fs.readFileSync(callsLog, "utf8");
    expect(advancedCalls).toContain("pr-required --pr 124 --wait --timeout 1800");
    expect(advancedCalls).not.toContain("package APP_VERSION=");
    expect(advancedCalls).not.toContain("open-app");
    expect(fs.existsSync(releaseLockPath)).toBe(false);
    fs.rmSync(forceAdvancedMain);
    fs.writeFileSync(callsLog, "");

    // A malformed packaged commit must fail after package verification but
    // before app launch. EXIT cleanup must also release the canonical lock.
    fs.writeFileSync(forceMalformedAppCommit, "1\n");
    const malformedPackageResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      { cwd: mainRepo, env: liveEnv, encoding: "utf8" },
    );
    expect(malformedPackageResult.status).toBe(1);
    expect(malformedPackageResult.stderr).toContain(
      "built Jarvis manifest gitCommit is missing or invalid: bad",
    );
    const malformedCalls = fs.readFileSync(callsLog, "utf8");
    expect(malformedCalls).toContain("package APP_VERSION=");
    expect(malformedCalls).not.toContain("open-app");
    expect(malformedCalls).not.toContain("protect apply");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(releaseLockPath)).toBe(false);
    fs.rmSync(forceMalformedAppCommit);
    fs.rmSync(path.join(mainRepo, "dist"), { recursive: true, force: true });
    fs.writeFileSync(callsLog, "");

    const result = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      {
        cwd: mainRepo,
        env: liveEnv,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "gateway restart ready pid=200 port=18789 version=2026.7.14.1 rpc=true",
    );
    expect(result.stdout).toContain(`installed_runtime_commit=${headSha}`);
    expect(result.stdout).toContain("runtime_package_version=2026.7.14.1");
    expect(result.stdout).toContain("runtime_pid=200");
    expect(result.stdout).toContain("runtime_port=18789");
    expect(result.stdout).toContain("runtime_rpc=true");
    expect(result.stdout).toContain("runtime_source=jarvis-break-glass-hotfix");
    expect(result.stdout).toContain("telegram_default_bot=@jarvis_test_bot");
    expect(result.stdout).toContain(
      `telegram_token_fingerprint=${createHash("sha256").update(token).digest("hex").slice(0, 12)}`,
    );
    expect(result.stdout).toContain("applications_jarvis_app=untouched");
    expect(result.stdout).toContain("public_release=false");
    expect(result.stdout).toContain(
      `post_deploy_telegram_canary=bash scripts/prove-jarvis-telegram-runtime.sh --dry-run --runtime-source jarvis-break-glass-hotfix --expected-commit ${headSha}`,
    );
    expect(result.stdout).not.toContain(token);
    const calls = fs.readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls).toContain("pr-required --pr 124 --wait --timeout 1800");
    expect(calls).toContain("status proof label=ai.jarvis.gateway");
    expect(calls).toContain(
      `package APP_VERSION=2026.7.14.1 APP_BUILD=301 BUILD_ARCHS=${process.arch === "arm64" ? "arm64" : "x86_64"} SKIP_PNPM_INSTALL=0 SKIP_TSC=0`,
    );
    expect(calls.filter((line) => line.startsWith("status ")).length).toBeGreaterThanOrEqual(3);
    expect(calls.indexOf("protect dry-run")).toBeGreaterThan(calls.indexOf("status 2"));
    expect(calls.indexOf("protect apply")).toBeGreaterThan(calls.indexOf("protect dry-run"));

    // Inject a permanent post-seed readiness failure. The wrapper must leave
    // the new payload protected and prove that state before returning nonzero.
    fs.rmSync(path.join(mainRepo, "dist"), { recursive: true, force: true });
    fs.writeFileSync(
      manifest,
      JSON.stringify({ format: 1, bundleVersion: "300", gitCommit: "389c0513cf" }),
    );
    fs.rmSync(marker, { force: true });
    fs.rmSync(launchctlCount, { force: true });
    fs.rmSync(statusCount, { force: true });
    fs.rmSync(kicked, { force: true });
    fs.writeFileSync(forceStatusFailure, "1\n");
    fs.writeFileSync(callsLog, "");
    const failureResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      {
        cwd: mainRepo,
        env: {
          ...liveEnv,
          OPENCLAW_SHIP_GATEWAY_READY_TIMEOUT_SECONDS: "0",
        },
        encoding: "utf8",
      },
    );
    expect(failureResult.status).toBe(1);
    expect(failureResult.stdout).toContain(
      "transaction_recovery=protection-verified-before-nonzero-exit",
    );
    expect(JSON.parse(fs.readFileSync(manifest, "utf8"))).toMatchObject({
      gitCommit: "a1b2c3d4e5",
      bundleVersion: "299",
    });
    const failureMarker = JSON.parse(fs.readFileSync(marker, "utf8"));
    expect(failureMarker.protectedRuntimeGitCommit).toBe(headSha);
    expect(JSON.parse(fs.readFileSync(failureMarker.backupPath, "utf8")).gitCommit).toBe(headSha);
    expect(fs.readFileSync(callsLog, "utf8").trim().split("\n").at(-1)).toBe("offline verify");

    // A launcher failure occurs before a seed is possible, so the recovery
    // transaction must remain unarmed and preserve the launcher's exit code.
    fs.rmSync(forceStatusFailure, { force: true });
    fs.writeFileSync(forceOpenFailure, "1\n");
    fs.writeFileSync(callsLog, "");
    const launchFailureResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      { cwd: mainRepo, env: liveEnv, encoding: "utf8" },
    );
    expect(launchFailureResult.status).toBe(1);
    expect(launchFailureResult.stdout).not.toContain("transaction_recovery=");
    expect(launchFailureResult.stderr).not.toContain("CRITICAL:");
    expect(fs.readFileSync(callsLog, "utf8")).not.toContain("offline verify");

    // `/usr/bin/open` can succeed before activation setup fails. The receipt,
    // not the helper's nonzero status, must arm protection for the async seed.
    fs.rmSync(forceOpenFailure, { force: true });
    fs.rmSync(path.join(mainRepo, "dist"), { recursive: true, force: true });
    fs.writeFileSync(forcePostLaunchFailure, "1\n");
    fs.writeFileSync(
      manifest,
      JSON.stringify({ format: 1, bundleVersion: "300", gitCommit: "389c0513cf" }),
    );
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(callsLog, "");
    const postLaunchFailureResult = spawnSync(
      "bash",
      [path.join(repoRoot, "scripts/ship-jarvis-hotfix.sh"), "--pr", "124"],
      { cwd: mainRepo, env: liveEnv, encoding: "utf8" },
    );
    expect(
      postLaunchFailureResult.status,
      `${postLaunchFailureResult.stdout}\n${postLaunchFailureResult.stderr}`,
    ).toBe(17);
    expect(postLaunchFailureResult.stdout).toContain(
      "transaction_recovery=protection-verified-before-nonzero-exit",
    );
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).protectedRuntimeGitCommit).toBe(headSha);
  });

  it("proves the loaded Jarvis runtime without using ai.openclaw.gateway", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","runtimeCommit":"389c0513cf","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
    );
    writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir));
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
    writeJarvisRuntimeLog(stateDir);

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jarvis_runtime_proof=true");
    expect(result.stdout).toContain("service_label=ai.jarvis.gateway");
    expect(result.stdout).toContain("runtime_commit=389c0513cf");
    expect(result.stdout).not.toContain("openclaw_shared_gateway_loaded");
    expect(result.stdout).not.toContain("ai.openclaw.gateway");
    expect(result.stdout).toContain("applications_jarvis_app=untouched");
  });

  it("falls back to direct launchctl print when list is unavailable", () => {
    const fixture = writeJarvisProofFixture({ launchctl: { listUnavailable: true } });

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jarvis_runtime_proof=true");
    expect(result.stdout).toContain("pid=85294");
  });

  it("keeps the shared-gateway ambiguity guard in direct-print fallback", () => {
    const fixture = writeJarvisProofFixture({
      launchctl: { listUnavailable: true, openclawLoadedOnPrint: true },
    });

    const result = runScript("scripts/prove-jarvis-runtime.sh", [], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("both ai.jarvis.gateway");
    expect(result.stderr).toContain("ai.openclaw.gateway");
  });

  it("rejects protected source hotfix drift as packaged Jarvis proof", () => {
    const fixture = writeJarvisProofFixture({
      commit: "dd8a89b",
      manifestCommit: "ce3ed18",
      runtimeSource: "jarvis-break-glass-hotfix",
      protection: {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
      },
    });

    const result = runScript("scripts/prove-jarvis-runtime.sh", [], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtimeSource=jarvis-break-glass-hotfix");
    expect(result.stderr).toContain("packaged Jarvis proof refused");
  });

  it("accepts only a fully protected source hotfix when explicitly selected", () => {
    const fixture = writeJarvisProofFixture({
      commit: "dd8a89b",
      manifestCommit: "ce3ed18",
      runtimeSource: "jarvis-break-glass-hotfix",
      protection: {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
      },
    });

    const result = runScript(
      "scripts/prove-jarvis-runtime.sh",
      ["--runtime-source", "jarvis-break-glass-hotfix", "--expected-commit", "dd8a89b"],
      {
        HOME: fixture.home,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_INSTALLED_JARVIS_APP_PATH: fixture.appPath,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("runtime_source=jarvis-break-glass-hotfix");
    expect(result.stdout).toContain("runtime_commit=dd8a89b");
    expect(result.stdout).toContain("rpc=ok");
  });

  it("honors an explicitly configured Jarvis launchd label", () => {
    const serviceLabel = "ai.jarvis.gateway.fixture";
    const fixture = writeJarvisProofFixture({ serviceLabel });
    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_JARVIS_GATEWAY_LABEL: serviceLabel,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`service_label=${serviceLabel}`);
  });

  it.each([
    ["missing marker", undefined, "marker is not readable"],
    [
      "wrong protected commit",
      {
        protectedRuntimeGitCommit: "badc0de",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
      },
      "marker commit=badc0de",
    ],
    [
      "wrong compatibility commit",
      {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "badc0de",
        compatibilityManifestBundleVersion: "300",
      },
      "compatibility commit=badc0de",
    ],
    [
      "wrong compatibility version",
      {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "999",
      },
      "compatibility version=999",
    ],
    [
      "wrong backup receipt",
      {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
        backupCommit: "badc0de",
      },
      "backup commit=badc0de",
    ],
    [
      "malformed protected commit",
      {
        protectedRuntimeGitCommit: "dd8a89b-not-a-commit",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
      },
      "invalid protectedRuntimeGitCommit",
    ],
    [
      "malformed compatibility commit",
      {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18-not-a-commit",
        compatibilityManifestBundleVersion: "300",
      },
      "invalid compatibilityManifestGitCommit",
    ],
    [
      "malformed backup receipt",
      {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
        backupCommit: "dd8a89b-not-a-commit",
      },
      "backup receipt has missing or invalid gitCommit",
    ],
  ] as const)("rejects protected-hotfix proof with %s", (_label, protection, reason) => {
    const fixture = writeJarvisProofFixture({
      commit: "dd8a89b",
      manifestCommit: "ce3ed18",
      runtimeSource: "jarvis-break-glass-hotfix",
      ...(protection ? { protection } : {}),
    });
    const result = runScript(
      "scripts/prove-jarvis-runtime.sh",
      ["--runtime-source", "jarvis-break-glass-hotfix", "--expected-commit", "dd8a89b"],
      {
        HOME: fixture.home,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_INSTALLED_JARVIS_APP_PATH: fixture.appPath,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain("runtime_source_observed=jarvis-break-glass-hotfix");
  });

  it("rejects a managed source when protected-hotfix proof is explicitly selected", () => {
    const fixture = writeJarvisProofFixture();
    const result = runScript(
      "scripts/prove-jarvis-runtime.sh",
      ["--runtime-source", "jarvis-break-glass-hotfix", "--expected-commit", "389c051"],
      {
        HOME: fixture.home,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_INSTALLED_JARVIS_APP_PATH: fixture.appPath,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "runtimeSource=jarvis-managed-bundle, expected jarvis-break-glass-hotfix",
    );
  });

  it("rejects protected-hotfix proof when the installed app no longer matches compatibility", () => {
    const fixture = writeJarvisProofFixture({
      commit: "dd8a89b",
      manifestCommit: "ce3ed18",
      runtimeSource: "jarvis-break-glass-hotfix",
      protection: {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
      },
    });
    fs.writeFileSync(
      path.join(fixture.appPath, "Contents", "Resources", "OpenClawRuntime", "manifest.json"),
      JSON.stringify({ format: 1, bundleVersion: "300", gitCommit: "badc0de" }),
    );

    const result = runScript(
      "scripts/prove-jarvis-runtime.sh",
      ["--runtime-source", "jarvis-break-glass-hotfix", "--expected-commit", "dd8a89b"],
      {
        HOME: fixture.home,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_INSTALLED_JARVIS_APP_PATH: fixture.appPath,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed Jarvis app commit=badc0de");
  });

  it("rejects a malformed installed-app commit in protected-hotfix proof", () => {
    const fixture = writeJarvisProofFixture({
      commit: "dd8a89b",
      manifestCommit: "ce3ed18",
      runtimeSource: "jarvis-break-glass-hotfix",
      protection: {
        protectedRuntimeGitCommit: "dd8a89b",
        compatibilityManifestGitCommit: "ce3ed18",
        compatibilityManifestBundleVersion: "300",
      },
    });
    fs.writeFileSync(
      path.join(fixture.appPath, "Contents", "Resources", "OpenClawRuntime", "manifest.json"),
      JSON.stringify({ format: 1, bundleVersion: "300", gitCommit: "ce3ed18-not-a-commit" }),
    );

    const result = runScript(
      "scripts/prove-jarvis-runtime.sh",
      ["--runtime-source", "jarvis-break-glass-hotfix", "--expected-commit", "dd8a89b"],
      {
        HOME: fixture.home,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_INSTALLED_JARVIS_APP_PATH: fixture.appPath,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "installed Jarvis app manifest has missing or invalid gitCommit",
    );
  });

  it("accepts target-level rpc and health fields in Jarvis status JSON", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","runtimeCommit":"389c0513cf","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"targets":[{"id":"localLoopback","kind":"localLoopback","url":"ws://127.0.0.1:18789","connect":{"rpcOk":true},"health":true}]}'
`,
    );
    writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir));
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
    writeJarvisRuntimeLog(stateDir);

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jarvis_runtime_proof=true");
    expect(result.stdout).toContain("runtime_commit=389c0513cf");
  });

  it("rejects Jarvis proof when only a remote target is RPC healthy", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","runtimeCommit":"389c0513cf","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"targets":[{"id":"configRemote","kind":"configRemote","url":"wss://remote.example/gateway","connect":{"rpcOk":true},"health":true},{"id":"localLoopback","kind":"localLoopback","url":"ws://127.0.0.1:18789","connect":{"rpcOk":false},"health":false}]}'
`,
    );
    writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir));
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
    writeJarvisRuntimeLog(stateDir);

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RPC probe is not ok");
  });

  it("extracts Jarvis status JSON when warnings precede it", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' 'Config warnings:'
printf '%s\\n' '- providers.tts.apiKey: missing env var'
cat <<'JSON'
{
  "runtimeFingerprint": {
    "serviceLabel": "ai.jarvis.gateway",
    "runtimeSource": "jarvis-managed-bundle",
    "runtimeCommit": "389c0513cf",
    "runtimePackageVersion": "2026.6.28",
    "launchServiceVersion": "2026.6.28",
    "stateDir": "${stateDir}",
    "configPath": "${stateDir}/openclaw.json"
  },
  "rpc": {
    "ok": true
  },
  "health": {
    "healthy": true
  }
}
JSON
`,
    );
    writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir));
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
    writeJarvisRuntimeLog(stateDir);

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jarvis_runtime_proof=true");
    expect(result.stdout).toContain("runtime_commit=389c0513cf");
  });

  it("rejects Jarvis proof when the loaded job points at a non-Jarvis runtime", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","runtimeCommit":"389c0513cf","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
    );
    writeExecutable(
      path.join(binDir, "launchctl"),
      jarvisLaunchctlFixture(stateDir, { wrongRuntime: true }),
    );
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("launchctl program does not prove Jarvis runtime ownership");
  });

  it("rejects Jarvis proof when launchctl paths only prefix-match the Jarvis runtime", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","runtimeCommit":"389c0513cf","runtimePackageVersion":"2026.6.28","launchServiceVersion":"2026.6.28","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
    );
    writeExecutable(
      path.join(binDir, "launchctl"),
      jarvisLaunchctlFixture(stateDir, { prefixOnlyRuntime: true }),
    );
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("launchctl program does not prove Jarvis runtime ownership");
  });

  it("rejects Jarvis runtime proof when ai.openclaw.gateway is also loaded", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(nodeBin, "#!/usr/bin/env bash\nexit 9\n");
    writeExecutable(
      path.join(binDir, "launchctl"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  printf '%s\\n' '85294	0	ai.jarvis.gateway'
  printf '%s\\n' '11111	0	ai.openclaw.gateway'
  exit 0
fi
exit 9
`,
    );
    writeExecutable(path.join(binDir, "lsof"), "#!/usr/bin/env bash\nexit 9\n");

    const result = runScript("scripts/prove-jarvis-runtime.sh", [], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("both ai.jarvis.gateway");
    expect(result.stderr).toContain("refuse ambiguous Jarvis proof");
  });

  it("proves Jarvis unlock preflight without live unlock or LaunchAgent mutation", () => {
    const fixture = writeJarvisUnlockProofFixture();

    const result = runScript("scripts/prove-jarvis-unlock-runtime.sh", [], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_PLISTBUDDY_BIN: path.join(fixture.binDir, "plistbuddy"),
      OPENCLAW_SQLITE3_BIN: path.join(fixture.binDir, "sqlite3"),
      OPENCLAW_ID_BIN: "id",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jarvis_unlock_preflight=true");
    expect(result.stdout).toContain("launchagent_plist_valid=true");
    expect(result.stdout).toContain("launchagent_active_matches_plist=true");
    expect(result.stdout).toContain("tcc_accessibility_preflight=granted");
    expect(result.stdout).toContain("unlock_wrapper_no_auto_lease=supported");
    expect(result.stdout).toContain("unlock_wrapper_no_auto_lease_auto_lock=supported");
    expect(result.stdout).toContain("lease_cleanup=ok");
    expect(result.stdout).toContain("gateway_rpc_health=ok");
    expect(result.stdout).toContain("runtime_mutation=none");
    expect(result.stdout).toContain("lock_unlock_mutation=none");
  });

  it("accepts an explicit break-glass Jarvis runtime for unrelated unlock preflight", () => {
    const fixture = writeJarvisUnlockProofFixture({
      runtimeSource: "jarvis-break-glass-hotfix",
    });

    const result = runScript("scripts/prove-jarvis-unlock-runtime.sh", [], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_PLISTBUDDY_BIN: path.join(fixture.binDir, "plistbuddy"),
      OPENCLAW_SQLITE3_BIN: path.join(fixture.binDir, "sqlite3"),
      OPENCLAW_ID_BIN: "id",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("launchagent_active_matches_plist=true");
    expect(result.stdout).toContain("gateway_rpc_health=ok");
    expect(result.stdout).toContain("runtime_mutation=none");
    expect(result.stdout).toContain("lock_unlock_mutation=none");
  });

  it("rejects Jarvis unlock preflight when launchd cached a source-checkout runtime", () => {
    const fixture = writeJarvisUnlockProofFixture({ wrongRuntime: true });

    const result = runScript("scripts/prove-jarvis-unlock-runtime.sh", [], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_PLISTBUDDY_BIN: path.join(fixture.binDir, "plistbuddy"),
      OPENCLAW_SQLITE3_BIN: path.join(fixture.binDir, "sqlite3"),
      OPENCLAW_ID_BIN: "id",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("launchagent_plist_valid=true");
    expect(result.stdout).toContain("launchagent_active_matches_plist=false");
    expect(result.stderr).toContain("active launchd cached service does not match");
  });

  it("reports missing explicit no-auto-lease support in the unlock session wrapper", () => {
    const fixture = writeJarvisUnlockProofFixture({ missingNoAutoLeaseSupport: true });

    const result = runScript("scripts/prove-jarvis-unlock-runtime.sh", [], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_PLISTBUDDY_BIN: path.join(fixture.binDir, "plistbuddy"),
      OPENCLAW_SQLITE3_BIN: path.join(fixture.binDir, "sqlite3"),
      OPENCLAW_ID_BIN: "id",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unlock_wrapper_no_auto_lease=missing");
    expect(result.stdout).toContain("unlock_wrapper_no_auto_lease_auto_lock=missing");
    expect(result.stdout).toContain("skip session-level lease when requested");
  });

  it("rejects stale Jarvis runtime commits", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","runtimeCommit":"389c0513cf","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
    );
    writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir));
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
    writeJarvisRuntimeLog(stateDir, { commit: "81435ae" });

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtimeCommit=81435ae, expected 389c051");
  });

  it("rejects missing Jarvis runtime commit metadata when a commit is expected", () => {
    const root = makeTempRoot();
    const home = path.join(root, "home");
    const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
    const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
    const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(entrypoint, "fixture\n");
    writeExecutable(
      nodeBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"runtimeFingerprint":{"serviceLabel":"ai.jarvis.gateway","runtimeSource":"jarvis-managed-bundle","stateDir":"${stateDir}","configPath":"${stateDir}/openclaw.json"},"rpc":{"ok":true},"health":{"healthy":true}}'
`,
    );
    writeExecutable(path.join(binDir, "launchctl"), jarvisLaunchctlFixture(stateDir));
    writeExecutable(path.join(binDir, "lsof"), jarvisLsofFixture(stateDir));
    writeJarvisRuntimeLog(stateDir, { omitCommit: true });

    const result = runScript("scripts/prove-jarvis-runtime.sh", ["--expected-commit", "389c051"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtimeCommit=missing, expected 389c051");
  });

  it("ship wrapper extracts gateway status JSON when warnings precede it", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    initMainRepo(mainRepo);
    const originRepo = path.join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", originRepo]);
    execFileSync("git", ["remote", "add", "origin", originRepo], { cwd: mainRepo });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: mainRepo });
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    const gh = path.join(binDir, "gh");
    writeExecutable(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "pr view 89 --json number,state,isDraft,baseRefName,headRefName,headRefOid,mergeCommit,title,url")
    printf '%s\\n' '{"number":89,"state":"MERGED","isDraft":false,"baseRefName":"main","headRefName":"x","headRefOid":"abc","title":"Fix gateway","url":"https://example.test/pr/89"}'
    ;;
  "pr view 89 --json files --jq .files[].path")
    printf '%s\\n' 'scripts/ship-main-gateway-fix.sh'
    ;;
  *)
    exit 9
    ;;
esac
`,
    );
    writeExecutable(
      path.join(binDir, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "openclaw:local gateway status --deep --require-rpc --json" ]]; then
  printf '%s\\n' 'Config warnings:\\n- plugins.entries.voice-call: plugin disabled'
  printf '%s\\n' '{"ok":true,"runtimeFingerprint":{"branch":"main","worktree":"${mainRepo}"},"service":{"runtime":{"status":"running","pid":4242}},"rpc":{"ok":true}}'
  exit 0
fi
exit 0
`,
    );
    fs.mkdirSync(path.join(mainRepo, "scripts"));
    writeExecutable(
      path.join(mainRepo, "scripts", "build-shared-runtime.sh"),
      "#!/usr/bin/env bash\nset -euo pipefail\n",
    );
    writeExecutable(
      path.join(mainRepo, "scripts", "gateway-recover-main.sh"),
      "#!/usr/bin/env bash\nset -euo pipefail\n",
    );
    execFileSync(
      "git",
      ["add", "scripts/build-shared-runtime.sh", "scripts/gateway-recover-main.sh"],
      {
        cwd: mainRepo,
      },
    );
    execFileSync("git", ["commit", "-q", "-m", "add ship fixtures"], {
      cwd: mainRepo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    execFileSync("git", ["push", "-q"], { cwd: mainRepo });

    const result = runScript("scripts/ship-main-gateway-fix.sh", ["--pr", "89", "--skip-live"], {
      OPENCLAW_GH_BIN: gh,
      OPENCLAW_MAIN_REPO: mainRepo,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR: https://example.test/pr/89");
    expect(result.stdout).toContain('status={"ok":true,"branch":"main","worktree":"' + mainRepo);
    expect(result.stdout).toContain('"pid":4242,"rpc":true}');
    expect(result.stdout).toContain("Live proof: skipped by --skip-live");
  });

  it("smoke restart dry-run validates preflight and emits proof JSON", () => {
    const root = makeTempRoot();
    const mainRepo = path.join(root, "main");
    initMainRepo(mainRepo);
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    writeExecutable(
      path.join(binDir, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "openclaw:local gateway status --deep --require-rpc --json" ]]; then
  printf '%s\\n' '{"ok":true,"runtimeFingerprint":{"branch":"main","worktree":"${mainRepo}"},"service":{"runtime":{"status":"running","pid":4242}},"rpc":{"ok":true}}'
  exit 0
fi
exit 9
`,
    );

    const result = runScript("scripts/smoke-main-gateway-restart.sh", ["--dry-run"], {
      OPENCLAW_MAIN_REPO: mainRepo,
      OPENCLAW_MAIN_GATEWAY_SMOKE_CHAT: "@jarvis_lab",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("preflight branch=main");
    const jsonLine = result.stdout.trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(jsonLine)).toMatchObject({
      ok: true,
      dry_run: true,
      mode: "confirm",
      chat: "@jarvis_lab",
      main_repo: mainRepo,
    });
  });
});
