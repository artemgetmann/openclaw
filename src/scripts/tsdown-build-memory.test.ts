import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts", "tsdown-build.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runWithFakePnpm(args: string[] = []) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tsdown-memory-"));
  tempDirs.push(fixture);
  const bin = path.join(fixture, "bin");
  const calls = path.join(fixture, "calls.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"$TSDOWN_TEST_CALLS"\nexit 0\n`,
  );
  fs.chmodSync(path.join(bin, "pnpm"), 0o755);

  execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      TSDOWN_TEST_CALLS: calls,
    },
  });
  return fs.readFileSync(calls, "utf8").trim().split("\n");
}

describe("tsdown build memory profile", () => {
  it("builds every named graph serially and cleans only the first graph", () => {
    const calls = runWithFakePnpm();

    expect(calls).toHaveLength(9);
    expect(calls[0]).toContain("--filter core-index --clean");
    expect(calls.slice(1).every((call) => call.includes("--no-clean"))).toBe(true);
    expect(calls.map((call) => call.match(/--filter ([^ ]+)/)?.[1])).toEqual([
      "core-index",
      "cli-entry",
      "daemon-cli",
      "warning-filter",
      "channel-lazy-entries",
      "plugin-sdk",
      "bundled-plugins",
      "extension-api",
      "bundled-hooks",
    ]);
  });

  it("preserves a caller-selected config as one targeted invocation", () => {
    const calls = runWithFakePnpm(["--filter", "plugin-sdk", "--report"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--filter plugin-sdk --report");
  });

  it("normalizes aggregate clean flags without erasing earlier graph outputs", () => {
    const cleanCalls = runWithFakePnpm(["--clean", "--report"]);
    const incrementalCalls = runWithFakePnpm(["--clean", "--no-clean", "--report"]);

    expect(cleanCalls[0]).toContain("--filter core-index --clean --report");
    expect(cleanCalls.slice(1).every((call) => call.includes("--no-clean --report"))).toBe(true);
    expect(cleanCalls.every((call) => !call.endsWith("--clean"))).toBe(true);
    expect(incrementalCalls.every((call) => call.includes("--no-clean --report"))).toBe(true);
  });

  it("preserves one aggregate invocation for persistent watch mode", () => {
    const calls = runWithFakePnpm(["--watch", "src"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--watch src");
    expect(calls[0]).not.toContain("--filter");
  });
});
