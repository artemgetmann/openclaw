import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "telegram-live-runtime.sh");

describe("telegram-live-runtime.sh", () => {
  it("keeps truthy env parsing compatible with macOS bash 3", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "telegram-live-runtime-"));
    const sourcePath = path.join(tempDir, "telegram-live-runtime-source.sh");
    const scriptSource = readFileSync(SCRIPT_PATH, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
    writeFileSync(sourcePath, scriptSource, "utf8");

    const stdout = execFileSync(
      BASH_BIN,
      [
        "--noprofile",
        "--norc",
        "-lc",
        `source ${JSON.stringify(sourcePath)} && is_truthy_env_flag "TRUE" && printf ok`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(stdout).toBe("ok");
  });
});
