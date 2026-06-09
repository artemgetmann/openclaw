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
