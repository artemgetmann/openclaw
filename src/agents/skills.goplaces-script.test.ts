import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempCwd() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-goplaces-script-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("goplaces skill script wrapper", () => {
  it("resolves repo-local runtime dependencies when launched outside the repo", () => {
    const result = spawnSync(
      "bash",
      [path.resolve("skills/goplaces/scripts/goplaces-search.sh"), "--help"],
      {
        cwd: makeTempCwd(),
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("goplaces-search.sh [search] <query>");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
