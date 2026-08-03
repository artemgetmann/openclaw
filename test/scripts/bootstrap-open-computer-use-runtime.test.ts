import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "bootstrap-open-computer-use-runtime.sh");
const tempRoots: string[] = [];

function writeExecutable(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${contents}\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createHarness(): {
  env: NodeJS.ProcessEnv;
  scriptPath: string;
  callsPath: string;
  agentPidPath: string;
  agentOwnerPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocu-bootstrap-test-"));
  tempRoots.push(root);
  const sourceRepo = path.join(root, "source");
  const appExecutable = path.join(
    sourceRepo,
    "dist",
    "Open Computer Use (Dev).app",
    "Contents",
    "MacOS",
    "OpenComputerUse",
  );
  const callsPath = path.join(root, "calls.log");
  const agentPidPath = path.join(root, "agent.pid");
  const agentOwnerPath = path.join(root, "agent.owner");
  const fakeBin = path.join(root, "bin");
  const bootstrapRoot = path.join(root, "bootstrap-root");
  const scriptPath = path.join(bootstrapRoot, "scripts", "bootstrap-open-computer-use-runtime.sh");

  // Lifecycle behavior is the contract under test here. Install the production
  // script in an isolated fixture root with a narrow guard stub so unit tests
  // never contend for, inherit, or re-exec through the host-wide heavy lease.
  writeExecutable(scriptPath, fs.readFileSync(SCRIPT_PATH, "utf8"));
  writeExecutable(
    path.join(bootstrapRoot, "scripts", "lib", "heavy-local-slot.sh"),
    [
      "#!/usr/bin/env bash",
      "openclaw_heavy_local_slot_require_or_reexec() {",
      "  return 0",
      "}",
    ].join("\n"),
  );

  writeExecutable(
    appExecutable,
    [
      "#!/usr/bin/env bash",
      "set -u",
      'printf "%s\\n" "${1:-}" >> "$OPENCLAW_TEST_CALLS"',
      'case "${1:-}" in',
      "  doctor)",
      '    if [[ ! -f "$OPENCLAW_TEST_AGENT_PID" ]] || ! kill -0 "$(cat "$OPENCLAW_TEST_AGENT_PID")" 2>/dev/null; then',
      '      "$0" __fake-agent &',
      '      printf "%s\\n" "$!" > "$OPENCLAW_TEST_AGENT_PID"',
      '      if [[ "${OPENCLAW_TEST_DELAY_AGENT_BIND:-0}" == "1" ]]; then',
      "        (",
      "          sleep 0.2",
      '          printf "%s\\n" "${OPEN_COMPUTER_USE_APP_AGENT_OWNER_TOKEN:-}" > "$OPENCLAW_TEST_AGENT_OWNER"',
      "        ) &",
      "      else",
      '        printf "%s\\n" "${OPEN_COMPUTER_USE_APP_AGENT_OWNER_TOKEN:-}" > "$OPENCLAW_TEST_AGENT_OWNER"',
      "      fi",
      "    fi",
      '    if [[ "${OPENCLAW_TEST_DOCTOR_HANG:-0}" == "1" ]]; then',
      "      trap 'exit 143' TERM INT",
      "      while true; do sleep 1; done",
      "    fi",
      '    exit "${OPENCLAW_TEST_DOCTOR_EXIT:-0}"',
      "    ;;",
      "  __fake-agent)",
      "    trap 'exit 0' TERM INT",
      "    while true; do sleep 1; done",
      "    ;;",
      "  __open-computer-use-stop-owned-app-agent)",
      "    for _ in {1..40}; do",
      '      if [[ -f "$OPENCLAW_TEST_AGENT_PID" && -f "$OPENCLAW_TEST_AGENT_OWNER" ]] &&',
      '        [[ "$(cat "$OPENCLAW_TEST_AGENT_OWNER")" == "${OPEN_COMPUTER_USE_APP_AGENT_OWNER_TOKEN:-}" ]]; then',
      '        kill -TERM "$(cat "$OPENCLAW_TEST_AGENT_PID")" 2>/dev/null || true',
      "        break",
      "      fi",
      "      sleep 0.025",
      "    done",
      "    ;;",
      "esac",
    ].join("\n"),
  );
  writeExecutable(path.join(sourceRepo, "scripts", "build-open-computer-use-app.sh"), "exit 0");
  execFileSync("git", ["init", "-q", sourceRepo]);
  execFileSync("git", ["-C", sourceRepo, "add", "."]);
  execFileSync("git", [
    "-C",
    sourceRepo,
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@openclaw.invalid",
    "commit",
    "-qm",
    "test fixture",
  ]);
  const sourceRef = execFileSync("git", ["-C", sourceRepo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  writeExecutable(path.join(fakeBin, "swift"), "exit 0");

  return {
    scriptPath,
    callsPath,
    agentPidPath,
    agentOwnerPath,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      OPENCLAW_OPEN_COMPUTER_USE_REPO: sourceRepo,
      OPENCLAW_OPEN_COMPUTER_USE_REF: sourceRef,
      OPENCLAW_OPEN_COMPUTER_USE_WORKDIR: path.join(root, "checkout"),
      OPENCLAW_OPEN_COMPUTER_USE_APP_PATH: path.join(root, "Open Computer Use (Dev).app"),
      OPENCLAW_OPEN_COMPUTER_USE_BIN_PATH_FILE: path.join(root, "bin-path.txt"),
      OPENCLAW_TEST_CALLS: callsPath,
      OPENCLAW_TEST_AGENT_PID: agentPidPath,
      OPENCLAW_TEST_AGENT_OWNER: agentOwnerPath,
    },
  };
}

function processExists(pidPath: string): boolean {
  if (!fs.existsSync(pidPath)) {
    return false;
  }
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pidPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!processExists(pidPath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "darwin")("bootstrap Open Computer Use lifecycle", () => {
  it("does not run doctor without explicit developer intent", () => {
    const harness = createHarness();
    const result = spawnSync("/bin/bash", [harness.scriptPath], {
      env: harness.env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping permission check");
    expect(fs.existsSync(harness.callsPath)).toBe(false);
  });

  it.each([
    ["success", "0", 0],
    ["failure", "7", 7],
  ])("stops the Dev agent after doctor %s", async (_label, doctorExit, expectedStatus) => {
    const harness = createHarness();
    const result = spawnSync("/bin/bash", [harness.scriptPath], {
      env: {
        ...harness.env,
        OPENCLAW_OPEN_COMPUTER_USE_RUN_DOCTOR: "1",
        OPENCLAW_TEST_DOCTOR_EXIT: doctorExit,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(expectedStatus);
    expect(fs.readFileSync(harness.callsPath, "utf8")).toContain(
      "__open-computer-use-stop-owned-app-agent",
    );
    expect(fs.readFileSync(harness.agentOwnerPath, "utf8")).toMatch(/^openclaw-bootstrap-/);
    expect(await waitForProcessExit(harness.agentPidPath)).toBe(true);
  });

  it("stops the Dev agent when doctor times out", async () => {
    const harness = createHarness();
    const result = spawnSync("/bin/bash", [harness.scriptPath], {
      env: {
        ...harness.env,
        OPENCLAW_OPEN_COMPUTER_USE_RUN_DOCTOR: "1",
        OPENCLAW_OPEN_COMPUTER_USE_DOCTOR_TIMEOUT_SECONDS: "1",
        OPENCLAW_TEST_DOCTOR_HANG: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(124);
    expect(fs.readFileSync(harness.callsPath, "utf8")).toContain(
      "__open-computer-use-stop-owned-app-agent",
    );
    expect(await waitForProcessExit(harness.agentPidPath)).toBe(true);
  });

  it("stops an owned Dev agent whose launch binding completes after doctor exits", async () => {
    const harness = createHarness();
    const result = spawnSync("/bin/bash", [harness.scriptPath], {
      env: {
        ...harness.env,
        OPENCLAW_OPEN_COMPUTER_USE_RUN_DOCTOR: "1",
        OPENCLAW_TEST_DELAY_AGENT_BIND: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(harness.agentOwnerPath, "utf8")).toMatch(/^openclaw-bootstrap-/);
    expect(await waitForProcessExit(harness.agentPidPath)).toBe(true);
  });

  it("stops the Dev agent when bootstrap receives SIGTERM", async () => {
    const harness = createHarness();
    const child = spawn("/bin/bash", [harness.scriptPath], {
      env: {
        ...harness.env,
        OPENCLAW_OPEN_COMPUTER_USE_RUN_DOCTOR: "1",
        OPENCLAW_OPEN_COMPUTER_USE_DOCTOR_TIMEOUT_SECONDS: "30",
        OPENCLAW_TEST_DOCTOR_HANG: "1",
      },
      stdio: "ignore",
    });

    for (let attempt = 0; attempt < 100 && !fs.existsSync(harness.agentPidPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(harness.agentPidPath)).toBe(true);
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));

    expect(exitCode).toBe(143);
    expect(fs.readFileSync(harness.callsPath, "utf8")).toContain(
      "__open-computer-use-stop-owned-app-agent",
    );
    expect(await waitForProcessExit(harness.agentPidPath)).toBe(true);
  });

  it("does not stop a pre-existing Dev agent that never adopted its owner token", async () => {
    const harness = createHarness();
    const preExistingAgent = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    fs.writeFileSync(harness.agentPidPath, `${preExistingAgent.pid}\n`);
    fs.writeFileSync(harness.agentOwnerPath, "pre-existing-owner\n");

    const result = spawnSync("/bin/bash", [harness.scriptPath], {
      env: {
        ...harness.env,
        OPENCLAW_OPEN_COMPUTER_USE_RUN_DOCTOR: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(processExists(harness.agentPidPath)).toBe(true);
    expect(fs.readFileSync(harness.agentOwnerPath, "utf8").trim()).toBe("pre-existing-owner");
    preExistingAgent.kill("SIGTERM");
    await new Promise((resolve) => preExistingAgent.once("exit", resolve));
  });
});
