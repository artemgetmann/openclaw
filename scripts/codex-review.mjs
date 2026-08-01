#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE = "origin/main";
const DEFAULT_TIMEOUT_SECONDS = 600;
const FORCE_KILL_GRACE_MS = 5_000;
const HOST_CONTEXT_REQUIRED_EXIT_CODE = 75;

function usage(message, exitCode = 2) {
  if (message) {
    process.stderr.write(`${message}\n\n`);
  }
  process.stderr.write("Usage: scripts/codex-review.mjs [--base <ref>] [--timeout <seconds>]\n");
  process.exit(exitCode);
}

function parsePositiveInteger(rawValue, label) {
  if (!/^[1-9][0-9]*$/.test(rawValue)) {
    usage(`${label} must be a positive integer: ${rawValue}`);
  }
  return Number.parseInt(rawValue, 10);
}

function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") {
      options.base = argv[++index] ?? usage("--base requires a git ref");
    } else if (argument === "--timeout") {
      const rawTimeout = argv[++index] ?? usage("--timeout requires seconds");
      options.timeoutSeconds = parsePositiveInteger(rawTimeout, "--timeout");
    } else if (argument === "--help" || argument === "-h") {
      usage(undefined, 0);
    } else {
      usage(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function resolveCodexHome() {
  const configuredHome = String(process.env.CODEX_HOME ?? "").trim();
  return configuredHome || path.join(os.homedir(), ".codex");
}

function requireWritableCodexState() {
  const codexHome = resolveCodexHome();
  let probeDirectory;
  let failure;

  try {
    // SQLite needs both a writable database and a writable parent directory for
    // its journal/WAL sidecars. A disposable directory proves the latter
    // without writing to Codex credentials, configuration, or state records.
    probeDirectory = fs.mkdtempSync(path.join(codexHome, ".codex-review-preflight-"));
  } catch (error) {
    failure = error;
  } finally {
    if (probeDirectory) {
      try {
        fs.rmSync(probeDirectory, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (!failure) {
    return true;
  }

  const reason = String(
    failure && typeof failure === "object" && "code" in failure ? failure.code : "unknown",
  );
  process.stderr.write(
    `CODEX_REVIEW_PREFLIGHT status=host_context_required code=codex_state_unwritable reason=${reason}\n`,
  );
  process.stderr.write(
    `Codex review requires writable Codex host state at ${codexHome}. Re-run this exact command once outside the restricted sandbox; if that host-context attempt fails, stop and report it.\n`,
  );
  return false;
}

const options = parseArgs(process.argv.slice(2));
if (!requireWritableCodexState()) {
  process.exit(HOST_CONTEXT_REQUIRED_EXIT_CODE);
}
const command = ["codex", "review", "--base", options.base];
process.stderr.write(
  `Starting one Codex review attempt with a ${options.timeoutSeconds}s deadline: ${command.join(" ")}\n`,
);

const review = spawn(command[0], command.slice(1), {
  stdio: "inherit",
});

let finished = false;
let timedOut = false;
let forceKillTimer;

// A hung review must not own the shipping lane forever. Ask it to stop cleanly,
// then force termination only if the CLI ignores SIGTERM for five more seconds.
const deadlineTimer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `Codex review timed out after ${options.timeoutSeconds}s; terminating the sidecar.\n`,
  );
  review.kill("SIGTERM");
  forceKillTimer = setTimeout(() => {
    if (!finished) {
      review.kill("SIGKILL");
    }
  }, FORCE_KILL_GRACE_MS);
}, options.timeoutSeconds * 1_000);

review.on("error", (error) => {
  clearTimeout(deadlineTimer);
  process.stderr.write(`Unable to start Codex review: ${error.message}\n`);
  process.exitCode = 2;
});

review.on("exit", (code, signal) => {
  finished = true;
  clearTimeout(deadlineTimer);
  clearTimeout(forceKillTimer);

  if (timedOut) {
    process.stderr.write(
      "No Codex verdict was produced. Do not retry automatically; continue with direct diff review and executable proof, and report the timeout.\n",
    );
    process.exitCode = 124;
    return;
  }

  if (signal) {
    process.stderr.write(`Codex review ended from signal ${signal}.\n`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});

// Preserve normal Ctrl-C and termination semantics while ensuring the child
// review does not outlive the agent lane that launched it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    review.kill(signal);
  });
}
