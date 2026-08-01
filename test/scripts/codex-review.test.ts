import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "codex-review.mjs");
const PR_SCRIPT_PATH = path.join(process.cwd(), "scripts", "pr");
const CODING_AGENT_SKILL_PATH = path.join(process.cwd(), "skills", "coding-agent", "SKILL.md");
const temporaryDirectories: string[] = [];

function makeCodexStub(source: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-review-"));
  temporaryDirectories.push(directory);
  const stubPath = path.join(directory, "codex");
  fs.writeFileSync(stubPath, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(stubPath, 0o755);
  return directory;
}

function runReview(stubDirectory: string, args: string[]) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-home-"));
  temporaryDirectories.push(codexHome);
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PATH: `${stubDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("scripts/codex-review.mjs", () => {
  it("runs exactly one review against the selected base and preserves success", () => {
    const stubDirectory = makeCodexStub(
      "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(0);\n",
    );

    const result = runReview(stubDirectory, ["--base", "origin/custom", "--timeout", "5"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('["review","--base","origin/custom"]');
    expect(result.stderr).toContain("with a 5s deadline");
  });

  it("preserves a completed review's nonzero exit status", () => {
    const stubDirectory = makeCodexStub("process.exit(7);\n");

    const result = runReview(stubDirectory, ["--timeout", "5"]);

    expect(result.status).toBe(7);
  });

  it("classifies a readonly Codex state directory before spawning a review", () => {
    const stubDirectory = makeCodexStub(
      "process.stderr.write('review spawned'); process.exit(99);\n",
    );
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-readonly-codex-home-"));
    temporaryDirectories.push(codexHome);
    const statePath = path.join(codexHome, "state_5.sqlite");
    fs.writeFileSync(statePath, "");
    fs.chmodSync(codexHome, 0o555);

    const result = (() => {
      try {
        return spawnSync(process.execPath, [SCRIPT_PATH, "--timeout", "5"], {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
            PATH: `${stubDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          timeout: 10_000,
        });
      } finally {
        fs.chmodSync(codexHome, 0o755);
      }
    })();

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      "CODEX_REVIEW_PREFLIGHT status=host_context_required code=codex_state_unwritable",
    );
    expect(result.stderr).toContain("Re-run this exact command once outside");
    expect(result.stderr).not.toContain("review spawned");
    expect(fs.readdirSync(codexHome)).toEqual(["state_5.sqlite"]);
  });

  it("terminates a stalled review once and reports the missing verdict", () => {
    const stubDirectory = makeCodexStub(
      ['process.on("SIGTERM", () => process.exit(0));', "setInterval(() => {}, 10_000);"].join(
        "\n",
      ),
    );
    const startedAt = Date.now();

    const result = runReview(stubDirectory, ["--timeout", "1"]);

    expect(result.status).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.stderr).toContain("timed out after 1s");
    expect(result.stderr).toContain("Do not retry automatically");
    expect(result.stderr).toContain("direct diff review and executable proof");
  });

  it("rejects invalid deadlines before spawning Codex", () => {
    const stubDirectory = makeCodexStub("process.exit(0);\n");

    const result = runReview(stubDirectory, ["--timeout", "0"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--timeout must be a positive integer");
  });

  it("prints help successfully without spawning Codex", () => {
    const stubDirectory = makeCodexStub("process.exit(99);\n");

    const result = runReview(stubDirectory, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Usage: scripts/codex-review.mjs");
  });
});

describe("disabled Copilot review compatibility command", () => {
  it("returns immediately without calling GitHub, including for legacy polling options", () => {
    const stubDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-review-"));
    temporaryDirectories.push(stubDirectory);
    const markerPath = path.join(stubDirectory, "gh-called");
    const ghStubPath = path.join(stubDirectory, "gh");
    fs.writeFileSync(
      ghStubPath,
      `#!/bin/sh\nprintf called > ${JSON.stringify(markerPath)}\nexit 99\n`,
    );
    fs.chmodSync(ghStubPath, 0o755);

    const result = spawnSync(
      "bash",
      [PR_SCRIPT_PATH, "copilot-check", "1283", "--timeout", "300", "--interval", "15"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ignoring legacy copilot-check polling options");
    expect(result.stdout).toContain("Copilot code review is disabled");
    expect(result.stdout).toContain("explicit skip, not Copilot review proof");
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

describe("coding-agent review guidance", () => {
  it("routes OpenClaw reviews through the bounded helper and forbids automatic retries", () => {
    const skill = fs.readFileSync(CODING_AGENT_SKILL_PATH, "utf8");

    expect(skill).toContain(
      'bash pty:true timeout:660 workdir:/tmp/pr-130-review command:"scripts/codex-review.mjs --base origin/main"',
    );
    expect(skill).toContain("never leave a review unbounded");
    expect(skill).toContain("instead of retrying");
  });
});
