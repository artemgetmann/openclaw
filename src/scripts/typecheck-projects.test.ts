import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TYPECHECK_PROJECTS, runTypecheckProjects } from "../../scripts/typecheck-projects.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("partitioned typecheck runner", () => {
  it("owns every original source root exactly once", () => {
    const includes = TYPECHECK_PROJECTS.flatMap(({ config }) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, config), "utf8")) as {
        include?: string[];
      };
      return parsed.include ?? [];
    });

    expect(includes).toEqual(["src/**/*", "extensions/**/*", "ui/**/*"]);
    expect(new Set(includes).size).toBe(includes.length);
  });

  it("runs core then UI and succeeds only when both pass", () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const output = { write: vi.fn() };

    expect(runTypecheckProjects({ spawn, binary: "tsgo", output })).toBe(0);
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["-p", "tsconfig.typecheck.core.json"],
      ["-p", "tsconfig.typecheck.ui.json"],
    ]);
  });

  it.each([
    ["core", [1]],
    ["ui", [0, 1]],
  ])("fails the aggregate when %s fails", (_name, statuses) => {
    const spawn = vi.fn();
    for (const status of statuses) {
      spawn.mockReturnValueOnce({ status });
    }

    expect(runTypecheckProjects({ spawn, binary: "tsgo", output: { write: vi.fn() } })).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(statuses.length);
  });
});
