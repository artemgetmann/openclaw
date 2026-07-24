import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(repoRoot, "scripts", "prove-jarvis-telegram-runtime.sh");
const roots: string[] = [];

function fixture(
  options: {
    gateFails?: boolean;
    gateFailureMessage?: string;
    gateRuntimeSource?: "jarvis-managed-bundle" | "jarvis-break-glass-hotfix";
    gateRuntimeCommit?: string;
    gatePid?: number;
    gateListener?: string;
    gateRpc?: "ok" | "failed";
    sessionMode?: "zero" | "one" | "multiple";
    waitFails?: boolean;
    missingTransportGeneration?: boolean;
    missingWatchdog?: boolean;
    invalidTopicIds?: boolean;
    wrongTopicChat?: boolean;
    topicCreateFails?: boolean;
    hostileBackendMeta?: boolean;
    inexactReply?: boolean;
    lockOwnerWriteFailure?: "empty" | "partial";
    precheckSessionSource?: "env-file" | "machine-default" | "monitor-binding" | "state-default";
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-managed-proof-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  const stateDir = path.join(home, "Library", "Application Support", "Jarvis", ".jarvis");
  const nodeBin = path.join(stateDir, "tools", "node", "bin", "node");
  const entrypoint = path.join(stateDir, "lib", "openclaw-bundled", "dist", "index.js");
  const logPath = path.join(stateDir, "logs", "gateway.log");
  const gate = path.join(root, "gate.sh");
  const gateArgs = path.join(root, "gate-args.txt");
  const launchctl = path.join(root, "launchctl");
  const calls = path.join(root, "calls.jsonl");
  const runtimeState = path.join(root, "runtime-state.json");
  const lock = path.join(root, "machine-lock");
  const packagedSession = path.join(stateDir, "telegram-user", "userbot.session");
  const packagedEnvFile = path.join(stateDir, "telegram-user", ".env.local");
  const staleLegacySession = path.join(home, ".openclaw", "telegram-user", "userbot.session");
  fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(path.dirname(packagedSession), { recursive: true });
  fs.mkdirSync(path.dirname(staleLegacySession), { recursive: true });
  fs.symlinkSync(process.execPath, nodeBin);
  fs.writeFileSync(logPath, "fixture-start\n");
  // The harness must follow the packaged binding even when a stale legacy
  // session exists. These files are inert fixtures; no credential bytes exist.
  fs.writeFileSync(packagedSession, "ready-packaged-fixture\n");
  fs.writeFileSync(packagedEnvFile, "TELEGRAM_API_ID=123\n");
  fs.writeFileSync(staleLegacySession, "needs-reauth-legacy-fixture\n");
  fs.writeFileSync(
    runtimeState,
    JSON.stringify({ statusCalls: 0, topicDeleted: false, sessionDeleted: false }),
  );
  fs.writeFileSync(
    gate,
    `#!/usr/bin/env bash
printf '%s\n' "$*" > ${JSON.stringify(gateArgs)}
${
  options.gateFails
    ? `${options.gateFailureMessage ? `printf '%s\\n' ${JSON.stringify(options.gateFailureMessage)} >&2\n` : ""}exit 9`
    : `[[ -z "$OPENCLAW_GATEWAY_URL" && -z "$CLAWDBOT_GATEWAY_URL" ]] || exit 31
[[ -z "$OPENCLAW_GATEWAY_TOKEN" && -z "$CLAWDBOT_GATEWAY_TOKEN" ]] || exit 32
[[ -z "$OPENCLAW_GATEWAY_PASSWORD" && -z "$CLAWDBOT_GATEWAY_PASSWORD" ]] || exit 33
[[ -z "$CLAWDBOT_GATEWAY_PORT" && "$OPENCLAW_GATEWAY_PORT" == "18789" ]] || exit 34
[[ "$OPENCLAW_CONFIG_PATH" == "${stateDir}/openclaw.json" ]] || exit 35
[[ "$OPENCLAW_JARVIS_GATEWAY_LABEL" == "ai.jarvis.gateway" ]] || exit 40
[[ "$OPENCLAW_JARVIS_INSTALLED_MANIFEST" == "${stateDir}/.consumer-bundled-runtime.json" ]] || exit 36
[[ "$OPENCLAW_JARVIS_PROTECTION_MARKER" == "${stateDir}/.consumer-bundled-runtime.protection.json" ]] || exit 37
[[ "$OPENCLAW_INSTALLED_JARVIS_APP_PATH" == "/Applications/Jarvis.app" ]] || exit 38
[[ "$OPENCLAW_JARVIS_APP_MANIFEST" == "/Applications/Jarvis.app/Contents/Resources/OpenClawRuntime/manifest.json" ]] || exit 39
cat <<'EOF'
[prove-jarvis-runtime] jarvis_runtime_proof=true
[prove-jarvis-runtime] service_label=ai.jarvis.gateway
[prove-jarvis-runtime] runtime_source=${options.gateRuntimeSource ?? "jarvis-managed-bundle"}
[prove-jarvis-runtime] runtime_commit=${options.gateRuntimeCommit ?? "389c0513cf"}
[prove-jarvis-runtime] runtime_package_version=2026.7.19
[prove-jarvis-runtime] launch_service_version=2026.7.19
[prove-jarvis-runtime] state_dir=${stateDir}
[prove-jarvis-runtime] config_path=${stateDir}/openclaw.json
[prove-jarvis-runtime] pid=${options.gatePid ?? 4242}
[prove-jarvis-runtime] listener=${options.gateListener ?? "127.0.0.1:18789"}
[prove-jarvis-runtime] rpc=${options.gateRpc ?? "ok"}
[prove-jarvis-runtime] health=healthy
EOF`
}
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    launchctl,
    "#!/usr/bin/env bash\nprintf '%s\\n' 'gui/501/ai.jarvis.gateway = {' '  pid = 4242' '}'\n",
    { mode: 0o755 },
  );

  // The fake installed entrypoint models only the command contract consumed by
  // the proof. It records every invocation so ordering and cleanup are asserted
  // without any Telegram, gateway, network, or real runtime access.
  fs.writeFileSync(
    entrypoint,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const calls = ${JSON.stringify(calls)};
const statePath = ${JSON.stringify(runtimeState)};
const logPath = ${JSON.stringify(logPath)};
const mode = ${JSON.stringify(options.sessionMode ?? "one")};
const operatorSession = ${JSON.stringify(packagedSession)};
const operatorEnvFile = ${JSON.stringify(packagedEnvFile)};
const managedConfig = ${JSON.stringify(path.join(stateDir, "openclaw.json"))};
const backendMeta = (explicit) => ({
  env_file:operatorEnvFile,
  session_path:${options.hostileBackendMeta ? JSON.stringify(path.join(root, "hostile-meta.session")) : "operatorSession"},
  session_source:explicit ? "explicit" : ${JSON.stringify(options.precheckSessionSource ?? "monitor-binding")},
  lock_scope:${options.hostileBackendMeta ? '"explicit"' : '"machine"'},
  backend:"fixture"
});
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
fs.appendFileSync(logPath, "proof fixture activity\\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const value = (flag) => args[args.indexOf(flag) + 1];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for (const key of [
  "OPENCLAW_GATEWAY_URL","CLAWDBOT_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN","CLAWDBOT_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD","CLAWDBOT_GATEWAY_PASSWORD",
  "CLAWDBOT_GATEWAY_PORT"
]) {
  if (process.env[key] !== undefined) process.exit(23);
}
if (process.env.OPENCLAW_GATEWAY_PORT !== "18789") process.exit(24);
if (process.env.OPENCLAW_CONFIG_PATH !== managedConfig) process.exit(25);
if (args[0] === "telegram-user") {
  const isPrecheck = args[1] === "precheck";
  if (isPrecheck && (args.includes("--session") || args.includes("--env-file"))) process.exit(21);
  if (!isPrecheck && value("--session") !== operatorSession) process.exit(29);
  if (!isPrecheck && value("--env-file") !== operatorEnvFile) process.exit(30);
  if (process.env.USERBOT_SESSION !== undefined) process.exit(22);
  if (process.env.OPENCLAW_TELEGRAM_USER_SESSION !== undefined) process.exit(26);
  if (process.env.OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION !== undefined) process.exit(27);
  if (process.env.OPENCLAW_TELEGRAM_USER_LOCK_PATH !== undefined) process.exit(28);
}
if (args[0] === "channels" && args[1] === "status") {
  state.statusCalls += 1;
  save();
  const now = new Date().toISOString();
  emit({channelAccounts:{telegram:[{
    accountId:"default",running:true,connected:true,
    probe:{ok:true,bot:{id:42,username:"jarvis_fixture_bot"}},
    transportActivity:{
      completedCount:state.statusCalls,
      stallCount:0,stopTimeoutCount:0,restartAttempts:0,
      transportGeneration:${options.missingTransportGeneration ? "undefined" : "1"},
      watchdog:${options.missingWatchdog ? "undefined" : "{escalation:null,lastStallAt:null,lastStopTimeoutAt:null}"}
    },
    lastPollCompletedAt:now,lastInboundAt:now,lastOutboundAt:now
  }]}});
} else if (args[0] === "telegram-user" && args[1] === "precheck") {
  emit({ok:true,backend_meta:backendMeta(false)});
} else if (args[0] === "telegram-user" && args[1] === "topic-create") {
  if (${options.topicCreateFails === true}) process.exit(8);
  emit({
    chat_id:${options.wrongTopicChat ? '"-1009999999999"' : 'value("--chat")'},
    topic_title:value("--title"),
    topic_anchor:100,
    message_id:${options.invalidTopicIds ? "101" : "100"},
    backend_meta:backendMeta(true)
  });
} else if (args[0] === "telegram-user" && args[1] === "send") {
  emit({result:{message:{message_id:101,sender_id:7}},backend_meta:backendMeta(true)});
} else if (args[0] === "telegram-user" && args[1] === "wait") {
  if (${options.waitFails === true}) process.exit(8);
  emit({
    matched:{
      message_id:102,sender_id:42,thread_anchor:100,
      text:${options.inexactReply ? '"prefix " + value("--contains") + " suffix"' : 'value("--contains")'}
    },
    backend_meta:backendMeta(true)
  });
} else if (args[0] === "telegram-user" && args[1] === "read") {
  emit({messages:state.topicDeleted ? [] : [{message_id:102,text:value("--contains")}],backend_meta:backendMeta(true)});
} else if (args[0] === "telegram-user" && args[1] === "topic-delete") {
  state.topicDeleted = true; save();
  emit({deleted:true,chat_id:value("--chat"),topic_anchor:Number(value("--topic-anchor")),backend_meta:backendMeta(true)});
} else if (args[0] === "gateway" && args[1] === "call" && args[2] === "sessions.list") {
  const key = "agent:main:telegram:group:-1003783709877:topic:100";
  const sessions = state.sessionDeleted || mode === "zero" ? [] :
    mode === "multiple" ? [{key},{key:"agent:other:telegram:group:-1003783709877:topic:100"}] : [{key}];
  emit({sessions});
} else if (args[0] === "gateway" && args[1] === "call" && args[2] === "sessions.delete") {
  const params = JSON.parse(value("--params"));
  state.sessionDeleted = true; save();
  emit({deleted:true,key:params.key,archived:[params.key + ".jsonl.deleted.fixture"]});
} else {
  process.exit(19);
}
`,
  );

  return {
    root,
    home,
    calls,
    gateArgs,
    lock,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_MODE: "1",
      OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_GATE: gate,
      OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_LAUNCHCTL: launchctl,
      OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_LOCK: lock,
      USERBOT_SESSION: path.join(root, "hostile-userbot.session"),
      OPENCLAW_TELEGRAM_USER_SESSION: path.join(root, "hostile-openclaw.session"),
      OPENCLAW_TELEGRAM_USER_CANONICAL_SESSION: path.join(root, "hostile-canonical.session"),
      OPENCLAW_TELEGRAM_USER_LOCK_PATH: path.join(root, "hostile.lock"),
      OPENCLAW_GATEWAY_URL: "wss://hostile.invalid",
      CLAWDBOT_GATEWAY_URL: "wss://legacy-hostile.invalid",
      OPENCLAW_GATEWAY_PORT: "29999",
      CLAWDBOT_GATEWAY_PORT: "28888",
      OPENCLAW_GATEWAY_TOKEN: "hostile-current-token",
      CLAWDBOT_GATEWAY_TOKEN: "hostile-legacy-token",
      OPENCLAW_GATEWAY_PASSWORD: "hostile-current-password",
      CLAWDBOT_GATEWAY_PASSWORD: "hostile-legacy-password",
      OPENCLAW_CONSUMER_INSTANCE_ID: "hostile-tester-lane",
      OPENCLAW_JARVIS_GATEWAY_LABEL: "ai.jarvis.gateway.hostile",
      OPENCLAW_JARVIS_INSTALLED_MANIFEST: path.join(root, "hostile-installed-manifest.json"),
      OPENCLAW_JARVIS_PROTECTION_MARKER: path.join(root, "hostile-protection-marker.json"),
      OPENCLAW_INSTALLED_JARVIS_APP_PATH: path.join(root, "Hostile.app"),
      OPENCLAW_JARVIS_APP_MANIFEST: path.join(root, "hostile-app-manifest.json"),
      ...(options.lockOwnerWriteFailure
        ? {
            OPENCLAW_JARVIS_TELEGRAM_PROOF_TEST_OWNER_WRITE_FAILURE: options.lockOwnerWriteFailure,
          }
        : {}),
    },
  };
}

function execute(
  testFixture: ReturnType<typeof fixture>,
  expectedCommit = "389c051",
  runtimeSource: "jarvis-managed-bundle" | "jarvis-break-glass-hotfix" = "jarvis-managed-bundle",
) {
  return spawnSync(
    "bash",
    [script, "--execute", "--runtime-source", runtimeSource, "--expected-commit", expectedCommit],
    {
      cwd: repoRoot,
      env: testFixture.env,
      encoding: "utf8",
    },
  );
}

function callsFor(testFixture: ReturnType<typeof fixture>) {
  if (!fs.existsSync(testFixture.calls)) {
    return [];
  }
  return fs
    .readFileSync(testFixture.calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("prove-jarvis-telegram-runtime", () => {
  it("emits a static parseable dry-run plan with zero filesystem or runtime mutation", () => {
    const testFixture = fixture();
    const result = spawnSync("bash", [script, "--dry-run", "--expected-commit", "389C051"], {
      cwd: repoRoot,
      env: testFixture.env,
      encoding: "utf8",
    });
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(evidence.mode).toBe("dry-run");
    expect(evidence.expectedCommit).toBe("389c051");
    expect(evidence.runtimeSource).toEqual({
      selected: "jarvis-managed-bundle",
      default: "jarvis-managed-bundle",
      autoFallback: false,
    });
    expect(evidence.mutations).toBe(false);
    expect(callsFor(testFixture)).toEqual([]);
    expect(fs.existsSync(testFixture.lock)).toBe(false);

    const hotfix = spawnSync(
      "bash",
      [
        script,
        "--dry-run",
        "--runtime-source",
        "jarvis-break-glass-hotfix",
        "--expected-commit",
        "389C051",
      ],
      { cwd: repoRoot, env: testFixture.env, encoding: "utf8" },
    );
    const hotfixEvidence = JSON.parse(hotfix.stdout);
    expect(hotfix.status).toBe(0);
    expect(hotfixEvidence.runtimeSource).toEqual({
      selected: "jarvis-break-glass-hotfix",
      default: "jarvis-managed-bundle",
      autoFallback: false,
    });
    expect(callsFor(testFixture)).toEqual([]);
    expect(fs.existsSync(testFixture.gateArgs)).toBe(false);
  });

  it("serializes the canary, performs exact cleanup, and reports archives as residuals", () => {
    const testFixture = fixture();
    const result = execute(testFixture, "389C051");
    const evidence = JSON.parse(result.stdout);
    const calls = callsFor(testFixture);
    expect(result.status, `${result.stderr}\n${result.stdout}\n${JSON.stringify(calls)}`).toBe(0);
    expect(evidence.result).toBe("passed");
    expect(evidence.expectedCommit).toBe("389c051");
    expect(evidence.cleanup.topic).toBe("deleted");
    expect(evidence.cleanup.session).toBe("absent");
    expect(evidence.cleanup.archivesRemain).toHaveLength(1);
    expect(evidence.telegram).toMatchObject({
      topicAnchor: 100,
      sentMessageId: 101,
      sentSenderId: 7,
      replyMessageId: 102,
      replySenderId: 42,
      replyThreadAnchor: 100,
    });
    expect(evidence.telegram.transportBefore).toMatchObject({
      transportGeneration: 1,
      watchdog: { escalation: null },
    });
    expect(evidence.telegram.transportAfter).toMatchObject({
      transportGeneration: 1,
      watchdog: { escalation: null },
    });
    expect(Date.parse(evidence.timing.startedAt)).toBe(evidence.timing.startedAtMs);
    expect(Date.parse(evidence.timing.finishedAt)).toBe(evidence.timing.finishedAtMs);
    expect(evidence.timing.finishedAtMs).toBeGreaterThanOrEqual(evidence.timing.startedAtMs);
    expect(evidence.residuals).toContainEqual(
      expect.objectContaining({
        type: "archived-session-transcript",
        reason: "archived-not-erased",
      }),
    );
    expect(calls.filter((args) => args[1] === "topic-create")).toHaveLength(1);
    for (const args of calls.filter((args) => args[0] === "telegram-user")) {
      if (args[1] === "precheck") {
        expect(args).not.toContain("--session");
        expect(args).not.toContain("--env-file");
        continue;
      }
      expect(args[args.indexOf("--session") + 1]).toBe(
        path.join(
          testFixture.home,
          "Library",
          "Application Support",
          "Jarvis",
          ".jarvis",
          "telegram-user",
          "userbot.session",
        ),
      );
    }
    expect(evidence.operatorSession).toEqual({
      source: "monitor-binding",
      path: path.join(
        testFixture.home,
        "Library",
        "Application Support",
        "Jarvis",
        ".jarvis",
        "telegram-user",
        "userbot.session",
      ),
      lockScope: "machine",
      verifiedBackend: {
        envFile: path.join(
          testFixture.home,
          "Library",
          "Application Support",
          "Jarvis",
          ".jarvis",
          "telegram-user",
          ".env.local",
        ),
        sessionPath: path.join(
          testFixture.home,
          "Library",
          "Application Support",
          "Jarvis",
          ".jarvis",
          "telegram-user",
          "userbot.session",
        ),
        sessionSource: "monitor-binding",
        lockScope: "machine",
        backend: "fixture",
      },
    });
    expect(calls.filter((args) => args[2] === "sessions.delete")).toHaveLength(1);
    expect(fs.existsSync(testFixture.lock)).toBe(false);
  });

  it("stops before Telegram when managed-runtime provenance fails and still emits JSON", () => {
    const testFixture = fixture({ gateFails: true });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.reason).toContain("selected Jarvis runtime provenance proof failed");
    expect(callsFor(testFixture)).toEqual([]);
  });

  it("accepts an explicitly selected protected-hotfix provenance proof", () => {
    const testFixture = fixture({ gateRuntimeSource: "jarvis-break-glass-hotfix" });
    const result = execute(testFixture, "389c051", "jarvis-break-glass-hotfix");
    const evidence = JSON.parse(result.stdout);
    expect(result.status, result.stderr).toBe(0);
    expect(evidence.runtimeSource).toEqual({
      selected: "jarvis-break-glass-hotfix",
      observed: "jarvis-break-glass-hotfix",
      autoFallback: false,
    });
    expect(fs.readFileSync(testFixture.gateArgs, "utf8")).toContain(
      "--runtime-source jarvis-break-glass-hotfix",
    );
  });

  it("accepts a full expected SHA when runtime provenance emits its short prefix", () => {
    const fullCommit = "389c0513cf0123456789abcdef0123456789abcd";
    const testFixture = fixture({ gateRuntimeCommit: fullCommit.slice(0, 10) });
    const result = execute(testFixture, fullCommit);
    const evidence = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(evidence.expectedCommit).toBe(fullCommit);
    expect(evidence.runtime.provenance.runtimeCommit).toBe(fullCommit.slice(0, 10));
  });

  it("accepts a packaged canonical fallback and pins it before mutations", () => {
    const testFixture = fixture({ precheckSessionSource: "state-default" });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(evidence.operatorSession.source).toBe("state-default");
    for (const args of callsFor(testFixture).filter(
      (args) => args[0] === "telegram-user" && args[1] !== "precheck",
    )) {
      expect(args).toContain("--session");
      expect(args).toContain("--env-file");
    }
  });

  it("rejects malformed short runtime commit provenance", () => {
    const testFixture = fixture({ gateRuntimeCommit: "3" });
    const result = execute(testFixture, "389c0513cf0123456789abcdef0123456789abcd");
    const evidence = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(evidence.runtime.provenance).toBeNull();
    expect(evidence.telegram.topicCreationAttempted).toBe(false);
  });

  it.each([
    [
      "wrong commit",
      "runtimeCommit=deadbee, expected 389c051; runtime_source_observed=jarvis-break-glass-hotfix; runtime_source_expected=jarvis-break-glass-hotfix",
      "runtime-commit-mismatch",
    ],
    [
      "missing protection",
      "protected-hotfix marker is not readable; runtime_source_observed=jarvis-break-glass-hotfix; runtime_source_expected=jarvis-break-glass-hotfix",
      "protection-marker-missing",
    ],
    [
      "mismatched protection",
      "protected-hotfix compatibility commit=deadbee, expected abcdef0; runtime_source_observed=jarvis-break-glass-hotfix; runtime_source_expected=jarvis-break-glass-hotfix",
      "protection-compatibility-commit-mismatch",
    ],
    [
      "PID ownership mismatch",
      "launchctl pid=999, expected pid=4242; runtime_source_observed=jarvis-break-glass-hotfix; runtime_source_expected=jarvis-break-glass-hotfix",
      "pid-owner-mismatch",
    ],
    [
      "listener ownership mismatch",
      "TCP port 18789 is not owned by ai.jarvis.gateway pid=4242; runtime_source_observed=jarvis-break-glass-hotfix; runtime_source_expected=jarvis-break-glass-hotfix",
      "listener-owner-mismatch",
    ],
    [
      "RPC mismatch",
      "RPC probe is not ok; runtime_source_observed=jarvis-break-glass-hotfix; runtime_source_expected=jarvis-break-glass-hotfix",
      "rpc-unhealthy",
    ],
  ] as const)("stops before Telegram for protected-hotfix %s", (_label, failure, code) => {
    const testFixture = fixture({ gateFails: true, gateFailureMessage: failure });
    const result = execute(testFixture, "389c051", "jarvis-break-glass-hotfix");
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.guidance).toMatchObject({
      code,
      observedRuntimeSource: "jarvis-break-glass-hotfix",
      expectedRuntimeSource: "jarvis-break-glass-hotfix",
    });
    expect(evidence.guidance.nextCommand).toBe(
      "bash scripts/prove-jarvis-telegram-runtime.sh --dry-run --runtime-source jarvis-break-glass-hotfix --expected-commit 389c051",
    );
    expect(evidence.telegram.topicCreationAttempted).toBe(false);
    expect(evidence.cleanup).toMatchObject({
      topic: "not-created",
      lock: "not-acquired",
    });
    expect(callsFor(testFixture)).toEqual([]);
    expect(result.stdout).not.toContain("DO_NOT_LEAK_THIS_TOKEN");
  });

  it("rejects a wrong source without auto-fallback and gives the valid source-specific command", () => {
    const testFixture = fixture({ gateRuntimeSource: "jarvis-break-glass-hotfix" });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.runtimeSource).toEqual({
      selected: "jarvis-managed-bundle",
      observed: "jarvis-break-glass-hotfix",
      autoFallback: false,
    });
    expect(evidence.guidance).toMatchObject({
      code: "runtime-source-mismatch",
      nextCommand:
        "bash scripts/prove-jarvis-telegram-runtime.sh --dry-run --runtime-source jarvis-break-glass-hotfix --expected-commit 389c051",
    });
    expect(evidence.telegram.topicCreationAttempted).toBe(false);
    expect(callsFor(testFixture)).toEqual([]);
  });

  it("serializes concurrent canaries with a fail-closed machine lock without leaking its token", () => {
    const testFixture = fixture();
    fs.mkdirSync(testFixture.lock);
    fs.writeFileSync(
      path.join(testFixture.lock, "owner.json"),
      JSON.stringify({ pid: 999, token: "DO_NOT_LEAK_THIS_TOKEN" }),
    );
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.reason).toContain("fail-closed owner metadata is readable");
    expect(result.stdout).not.toContain("DO_NOT_LEAK_THIS_TOKEN");
    expect(callsFor(testFixture)).toEqual([]);
  });

  it("removes an empty lock directory after owner metadata write failure", () => {
    const testFixture = fixture({ lockOwnerWriteFailure: "empty" });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.reason).toContain("lock owner metadata write failed");
    expect(evidence.cleanup.lock).toBe("not-acquired");
    expect(fs.existsSync(testFixture.lock)).toBe(false);
    expect(callsFor(testFixture)).toEqual([]);
  });

  it("keeps non-empty partial lock state fail-closed after owner metadata write failure", () => {
    const testFixture = fixture({ lockOwnerWriteFailure: "partial" });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("cleanup-incomplete");
    expect(evidence.residuals).toContainEqual(
      expect.objectContaining({ type: "lock", reason: "owner-write-partial-state" }),
    );
    expect(fs.existsSync(path.join(testFixture.lock, "owner.json"))).toBe(true);
    expect(callsFor(testFixture)).toEqual([]);
  });

  it("cleans the exact topic and canonical session after a proof failure", () => {
    const testFixture = fixture({ waitFails: true });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.cleanup.topic).toBe("deleted");
    expect(evidence.cleanup.session).toBe("absent");
  });

  it("fails before topic mutation when precheck reports mismatched backend ownership", () => {
    const testFixture = fixture({ hostileBackendMeta: true });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    const calls = callsFor(testFixture);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.reason).toContain(
      "operator-precheck returned mismatched operator backend ownership",
    );
    expect(calls.filter((args) => args[1] === "precheck")).toHaveLength(1);
    expect(calls.filter((args) => args[1] === "topic-create")).toEqual([]);
  });

  it.each(["machine-default", "env-file"] as const)(
    "rejects legacy %s session ownership before topic mutation",
    (precheckSessionSource) => {
      const testFixture = fixture({ precheckSessionSource });
      const result = execute(testFixture);
      const evidence = JSON.parse(result.stdout);
      const calls = callsFor(testFixture);

      expect(result.status).toBe(1);
      expect(evidence.reason).toContain(
        "operator-precheck returned mismatched operator backend ownership",
      );
      expect(calls.filter((args) => args[1] === "precheck")).toHaveLength(1);
      expect(calls.filter((args) => args[1] === "topic-create")).toEqual([]);
    },
  );

  it("rejects a reply that contains but does not exactly equal the nonce", () => {
    const testFixture = fixture({ inexactReply: true });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.reason).toContain("exactly match");
    expect(evidence.cleanup.topic).toBe("deleted");
    expect(evidence.cleanup.session).toBe("absent");
  });

  it.each([
    [
      "mismatched create identifiers",
      { invalidTopicIds: true },
      "invalid-or-mismatched-create-identifiers-refused-deletion",
    ],
    ["wrong-chat create response", { wrongTopicChat: true }, "wrong-chat-create-refused-deletion"],
    [
      "unknown create outcome",
      { topicCreateFails: true },
      "create-outcome-unknown-refused-deletion",
    ],
  ] as const)("reports cleanup-incomplete for %s", (_label, options, reason) => {
    const testFixture = fixture(options);
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    const calls = callsFor(testFixture);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("cleanup-incomplete");
    expect(evidence.telegram.topicCreationAttempted).toBe(true);
    expect(evidence.telegram.topicCreationUncertain).toBe(true);
    expect(evidence.cleanup.topic).toBe("creation-uncertain-delete-refused");
    expect(evidence.cleanup.marker).toBe("unknown");
    expect(evidence.residuals).toContainEqual(
      expect.objectContaining({ type: "telegram-topic", reason }),
    );
    expect(calls.filter((args) => args[1] === "topic-delete")).toEqual([]);
  });

  it.each([
    ["zero", "zero-canonical-matches"],
    ["multiple", "multiple-or-bound-shared-matches"],
  ] as const)("refuses %s canonical session matches", (sessionMode, reason) => {
    const testFixture = fixture({ sessionMode });
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("cleanup-incomplete");
    expect(evidence.residuals).toContainEqual(expect.objectContaining({ type: "session", reason }));
    expect(callsFor(testFixture).filter((args) => args[2] === "sessions.delete")).toEqual([]);
  });

  it.each([
    ["transport generation", { missingTransportGeneration: true }, "transport generation evidence"],
    ["watchdog", { missingWatchdog: true }, "watchdog evidence"],
  ] as const)("fails closed when %s evidence is absent", (_label, options, reason) => {
    const testFixture = fixture(options);
    const result = execute(testFixture);
    const evidence = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(evidence.result).toBe("failed");
    expect(evidence.reason).toContain(reason);
    expect(evidence.cleanup.topic).toBe("deleted");
    expect(evidence.cleanup.session).toBe("absent");
  });
});
