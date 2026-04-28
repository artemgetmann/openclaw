import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();

const initRemoteClone = (prefix: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remoteDir = path.join(root, "remote.git");
  const seedDir = path.join(root, "seed");
  const cloneDir = path.join(root, "clone");

  run(root, "git", ["init", "--bare", remoteDir]);
  run(root, "git", ["init", seedDir, "--initial-branch=main"]);
  run(seedDir, "git", ["config", "user.name", "Test User"]);
  run(seedDir, "git", ["config", "user.email", "test@example.com"]);
  writeFileSync(
    path.join(seedDir, "package.json"),
    '{"name":"fixture","packageManager":"pnpm@10.23.0"}\n',
  );
  run(seedDir, "git", ["add", "package.json"]);
  run(seedDir, "git", ["commit", "-m", "seed"]);
  run(seedDir, "git", ["remote", "add", "origin", remoteDir]);
  run(seedDir, "git", ["push", "-u", "origin", "main"]);
  run(root, "git", ["clone", remoteDir, cloneDir]);
  run(cloneDir, "git", ["config", "user.name", "Test User"]);
  run(cloneDir, "git", ["config", "user.email", "test@example.com"]);
  return { root, cloneDir };
};

const installFixture = (cloneDir: string) => {
  mkdirSync(path.join(cloneDir, "scripts", "lib"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "new-worktree.sh"),
    path.join(cloneDir, "scripts", "new-worktree.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "bootstrap-worktree-tester-baseline.sh"),
    path.join(cloneDir, "scripts", "bootstrap-worktree-tester-baseline.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "lib", "worktree-guards.sh"),
    path.join(cloneDir, "scripts", "lib", "worktree-guards.sh"),
  );
  symlinkSync(
    path.join(process.cwd(), "scripts", "lib", "worktree-tester-baseline.mjs"),
    path.join(cloneDir, "scripts", "lib", "worktree-tester-baseline.mjs"),
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "lib", "validated-node.sh"),
    `#!/usr/bin/env bash
openclaw_use_validated_node() {
  export OPENCLAW_NODE_BIN="$(command -v node)"
  export OPENCLAW_VALIDATED_NODE_BIN="$OPENCLAW_NODE_BIN"
  return 0
}
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "bootstrap-worktree-telegram.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "telegram-live-runtime.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "worktree-doctor.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "bootstrap-worktree-runtime.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
ROOT=""
SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --quiet) shift ;;
    *) shift ;;
  esac
done
mkdir -p "$ROOT/node_modules/.bin"
cat > "$ROOT/node_modules/.bin/vitest" <<'EOF'
#!/usr/bin/env bash
echo 4.1.0
EOF
chmod 755 "$ROOT/node_modules/.bin/vitest"
if [[ "$SKIP_BUILD" != "1" ]]; then
  mkdir -p "$ROOT/dist"
  printf 'export {}\\n' > "$ROOT/dist/index.js"
fi
`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    path.join(cloneDir, "scripts", "worktree-ready-check.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
ROOT=""
MODE="clean"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    *) shift ;;
  esac
done
test -x "$ROOT/node_modules/.bin/vitest"
if [[ "$MODE" == "clean" ]]; then
  test -f "$ROOT/dist/index.js"
fi
printf 'lane_ready=yes\\n'
`,
    { encoding: "utf8", mode: 0o755 },
  );
};

describe("new worktree tester baseline bootstrap", () => {
  it("inherits sanitized config and auth snapshots into a durable tester baseline", () => {
    const { cloneDir, root } = initRemoteClone("openclaw-new-worktree-baseline-");
    installFixture(cloneDir);

    const homeDir = path.join(root, "home");
    const sourceStateDir = path.join(homeDir, ".openclaw");
    const sourceConfigPath = path.join(sourceStateDir, "openclaw.json");
    const sourceAuthDir = path.join(sourceStateDir, "agents", "main", "agent");
    mkdirSync(sourceAuthDir, { recursive: true });

    const sourceConfig = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "prod-token",
          tokenFile: "/run/secrets/prod-telegram-token",
          accounts: {
            tester: {
              botToken: "test-account-token",
              tokenFile: "/run/secrets/tester-telegram-token",
              enabled: true,
            },
          },
        },
      },
      env: {
        OPENAI_API_KEY: "sk-live-env",
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "sk-consumer-env",
        vars: {
          OPENAI_API_KEY: "sk-vars-env",
          OPENCLAW_CONSUMER_OPENAI_API_KEY: "sk-vars-consumer",
        },
      },
      messages: {
        tts: {
          openai: {
            apiKey: "${OPENAI_API_KEY}",
          },
        },
      },
      tools: {
        media: {
          audio: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                apiKey: "${OPENCLAW_CONSUMER_OPENAI_API_KEY}",
              },
            ],
          },
        },
      },
      agents: {
        list: [{ id: "main" }],
      },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-main-provider" },
        },
      },
    };
    const sourceAuth = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
    };
    writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig, null, 2)}\n`);
    writeFileSync(
      path.join(sourceAuthDir, "auth-profiles.json"),
      `${JSON.stringify(sourceAuth, null, 2)}\n`,
    );

    run(cloneDir, "git", ["add", "."]);
    run(cloneDir, "git", ["commit", "-m", "fixture"]);
    run(cloneDir, "git", ["push", "origin", "main"]);

    const output = run(
      cloneDir,
      "bash",
      ["scripts/new-worktree.sh", "baseline-lane", "--base", "main"],
      {
        OPENCLAW_MAIN_HOME_CLONE: cloneDir,
        HOME: homeDir,
      },
    );

    const worktreePath = output.match(/^worktree=(.+)$/m)?.[1];
    const baselineStateDir = output.match(/^baseline_state_dir=(.+)$/m)?.[1];
    const baselineConfigPath = output.match(/^baseline_config_path=(.+)$/m)?.[1];
    const baselineMetaPath = output.match(/^baseline_meta_path=(.+)$/m)?.[1];
    expect(output).toContain("baseline_bootstrap=ok");
    expect(output).toContain("baseline_stripped_named_telegram_accounts=tester");
    expect(worktreePath).toBeTruthy();
    expect(baselineStateDir).toContain(path.join(homeDir, ".openclaw", "worktree-runtimes"));
    expect(baselineConfigPath).toBe(path.join(baselineStateDir!, "openclaw.json"));
    expect(baselineMetaPath).toBe(path.join(baselineStateDir!, "auth-sync.json"));

    const devEnv = readFileSync(path.join(worktreePath!, ".dev-launch.env"), "utf8");
    expect(devEnv).toContain(`OPENCLAW_STATE_DIR=${baselineStateDir}`);
    expect(devEnv).toContain(`OPENCLAW_CONFIG_PATH=${baselineConfigPath}`);

    const inheritedConfig = JSON.parse(readFileSync(baselineConfigPath!, "utf8"));
    expect(inheritedConfig.models.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(inheritedConfig.models.providers.openai.apiKey).toBeUndefined();
    expect(inheritedConfig.channels.telegram.botToken).toBeUndefined();
    expect(inheritedConfig.channels.telegram.tokenFile).toBeUndefined();
    expect(inheritedConfig.channels.telegram.accounts.tester.botToken).toBeUndefined();
    expect(inheritedConfig.channels.telegram.accounts.tester.tokenFile).toBeUndefined();
    expect(inheritedConfig.env.OPENAI_API_KEY).toBeUndefined();
    expect(inheritedConfig.env.OPENCLAW_CONSUMER_OPENAI_API_KEY).toBeUndefined();
    expect(inheritedConfig.env.vars.OPENAI_API_KEY).toBeUndefined();
    expect(inheritedConfig.env.vars.OPENCLAW_CONSUMER_OPENAI_API_KEY).toBeUndefined();
    expect(inheritedConfig.messages.tts.openai.apiKey).toBeUndefined();
    expect(inheritedConfig.tools.media.audio.models[0].apiKey).toBeUndefined();

    const inheritedAuthPath = path.join(
      baselineStateDir!,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    expect(JSON.parse(readFileSync(inheritedAuthPath, "utf8"))).toEqual(sourceAuth);

    const baselineMeta = JSON.parse(readFileSync(baselineMetaPath!, "utf8"));
    expect(baselineMeta.sanitization.strippedNamedTelegramAccounts).toEqual(["tester"]);
    expect(baselineMeta.sanitization.strippedTelegramCredentials).toEqual(
      expect.arrayContaining([
        { accountId: "default", accountKind: "default", sourceKind: "botToken" },
        { accountId: "default", accountKind: "default", sourceKind: "tokenFile" },
        { accountId: "tester", accountKind: "named", sourceKind: "botToken" },
        { accountId: "tester", accountKind: "named", sourceKind: "tokenFile" },
      ]),
    );
    expect(JSON.stringify(baselineMeta)).not.toContain("prod-token");
    expect(JSON.stringify(baselineMeta)).not.toContain("test-account-token");
    expect(JSON.stringify(baselineMeta)).not.toContain("/run/secrets/tester-telegram-token");

    expect(JSON.parse(readFileSync(sourceConfigPath, "utf8"))).toEqual(sourceConfig);
    expect(
      JSON.parse(readFileSync(path.join(sourceAuthDir, "auth-profiles.json"), "utf8")),
    ).toEqual(sourceAuth);
  });
});
