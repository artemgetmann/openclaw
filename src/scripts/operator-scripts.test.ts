import { execFileSync, spawnSync } from "node:child_process";
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
  options: { wrongRuntime?: boolean; prefixOnlyRuntime?: boolean } = {},
) {
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
    printf '%s\\n' '85294	0	ai.jarvis.gateway'
    ;;
  print)
    cat <<'EOF'
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
  working directory = ${runtimeRoot}
  environment = {
    HOME => ${home}
    OPENCLAW_HOME => ${jarvisHome}
    OPENCLAW_STATE_DIR => ${stateDir}
    OPENCLAW_CONFIG_PATH => ${stateDir}/openclaw.json
    OPENCLAW_LOG_DIR => ${stateDir}/logs
    OPENCLAW_LAUNCHD_LABEL => ai.jarvis.gateway
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
    path.join(logDir, "gateway.log"),
    `2026-06-29T17:24:27.009+08:00 [gateway] runtime identity: ${fields.join(" ")}\n`,
  );
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
    expect(result.stdout).toContain("openclaw_shared_gateway_loaded=false");
    expect(result.stdout).toContain("applications_jarvis_app=untouched");
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
