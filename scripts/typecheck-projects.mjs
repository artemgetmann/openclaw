import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Core and extensions share a dense runtime graph, so separating them would compile the same state
// repeatedly. UI is worthwhile only because its contract boundary now keeps its core reach small.
export const TYPECHECK_PROJECTS = [
  { name: "core", config: "tsconfig.typecheck.core.json" },
  { name: "ui", config: "tsconfig.typecheck.ui.json" },
];

function resolveTsgoBinary() {
  const executable = process.platform === "win32" ? "tsgo.cmd" : "tsgo";
  return path.join(repoRoot, "node_modules", ".bin", executable);
}

export function runTypecheckProjects({
  spawn = spawnSync,
  binary = resolveTsgoBinary(),
  output = process.stdout,
} = {}) {
  for (const project of TYPECHECK_PROJECTS) {
    output.write(`TYPECHECK_PROJECT_START name=${project.name} config=${project.config}\n`);
    const result = spawn(binary, ["-p", project.config], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    // Signals and spawn errors have no numeric status. Normalize them to a normal nonzero failure so
    // callers cannot mistake an interrupted partition for a successful repository proof.
    const status = result.status ?? 1;
    if (status !== 0) {
      output.write(`TYPECHECK_PROJECT_FAIL name=${project.name} status=${status}\n`);
      return status;
    }
    output.write(`TYPECHECK_PROJECT_PASS name=${project.name}\n`);
  }
  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  process.exitCode = runTypecheckProjects();
}
