import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runFastPackage(args: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fast-package-"));
  tempRoots.push(root);
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(scriptsDir);
  fs.copyFileSync(
    path.join(repoRoot, "scripts", "package-consumer-mac-app-fast.sh"),
    path.join(scriptsDir, "package-consumer-mac-app-fast.sh"),
  );
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// fixture\n");
  fs.writeFileSync(
    path.join(scriptsDir, "package-consumer-mac-app.sh"),
    '#!/usr/bin/env bash\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n',
    { mode: 0o755 },
  );

  return spawnSync(
    "/bin/bash",
    [path.join(scriptsDir, "package-consumer-mac-app-fast.sh"), ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

describe("fast consumer packaging wrapper", () => {
  it("runs under macOS Bash 3.2 when no optional arguments are present", () => {
    const result = runFastPackage([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });

  it("still forwards an explicit instance", () => {
    const result = runFastPackage(["--instance", "smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("--instance\nsmoke\n");
  });
});
