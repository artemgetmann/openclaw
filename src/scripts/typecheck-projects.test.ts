import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { TYPECHECK_PROJECTS, runTypecheckProjects } from "../../scripts/typecheck-projects.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configHost: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  },
};

describe("partitioned typecheck runner", () => {
  it("owns every original source root exactly once", () => {
    // Parse the same file lists that the compiler will use. Literal `include` comparisons can miss
    // a future `exclude`, glob change, or accidental overlap between the two project configs.
    const readRoots = (config: string) => {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        path.join(repoRoot, config),
        {},
        configHost,
      );
      if (!parsed) {
        throw new Error(`Unable to parse ${config}`);
      }
      return parsed.fileNames.map((fileName) => path.relative(repoRoot, fileName)).toSorted();
    };

    const originalRoots = readRoots("tsconfig.json");
    const partitionRoots = TYPECHECK_PROJECTS.flatMap(({ config }) => readRoots(config));

    expect(new Set(partitionRoots).size).toBe(partitionRoots.length);
    expect(partitionRoots.toSorted()).toEqual(originalRoots);
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

  it("fails closed and skips UI when the core compiler is interrupted", () => {
    const spawn = vi.fn().mockReturnValue({ status: null, signal: "SIGTERM" });

    expect(runTypecheckProjects({ spawn, binary: "tsgo", output: { write: vi.fn() } })).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
