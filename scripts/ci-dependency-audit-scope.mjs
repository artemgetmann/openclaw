import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const LOCKFILE_OR_WORKSPACE_RE = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
const PACKAGE_JSON_RE =
  /^(package\.json|ui\/package\.json|extensions\/[^/]+\/package\.json|packages\/[^/]+\/package\.json)$/;

// These fields can change what package managers install, resolve, bundle, or
// execute as package dependency metadata. Other package.json metadata, such as
// scripts or description, should not make an unrelated PR inherit existing
// production audit debt.
export const AUDIT_RELEVANT_PACKAGE_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "packageManager",
  "pnpm",
  "resolutions",
  "workspaces",
];

function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJson(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function gitShowFile(ref, filePath) {
  try {
    return execFileSync("git", ["show", `${ref}:${filePath}`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

function listChangedPaths(base, head) {
  const output = execFileSync("git", ["diff", "--name-only", base, head, "--"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function packageJsonHasAuditRelevantChange(beforePackage, afterPackage) {
  for (const field of AUDIT_RELEVANT_PACKAGE_FIELDS) {
    if (
      JSON.stringify(stableJson(beforePackage?.[field])) !==
      JSON.stringify(stableJson(afterPackage?.[field]))
    ) {
      return true;
    }
  }
  return false;
}

export function isAuditScopePath(filePath) {
  return LOCKFILE_OR_WORKSPACE_RE.test(filePath) || PACKAGE_JSON_RE.test(filePath);
}

export function isAlwaysAuditPath(filePath) {
  return LOCKFILE_OR_WORKSPACE_RE.test(filePath);
}

export function isPackageManifestPath(filePath) {
  return PACKAGE_JSON_RE.test(filePath);
}

export function shouldRunAuditForChangedPaths(changedPaths, { base = "", head = "HEAD" } = {}) {
  const auditScopePaths = changedPaths.filter(isAuditScopePath);
  if (auditScopePaths.length === 0) {
    return { shouldRun: false, reason: "no dependency audit scope paths changed" };
  }

  const alwaysAuditPath = auditScopePaths.find(isAlwaysAuditPath);
  if (alwaysAuditPath) {
    return { shouldRun: true, reason: `${alwaysAuditPath} changed` };
  }

  for (const filePath of auditScopePaths.filter(isPackageManifestPath)) {
    const beforeRaw = gitShowFile(base, filePath);
    const afterRaw = gitShowFile(head, filePath);
    if (beforeRaw === null || afterRaw === null) {
      return { shouldRun: true, reason: `${filePath} was added or removed` };
    }

    const beforePackage = parseJson(beforeRaw);
    const afterPackage = parseJson(afterRaw);
    if (beforePackage === null || afterPackage === null) {
      return { shouldRun: true, reason: `${filePath} could not be parsed` };
    }

    if (packageJsonHasAuditRelevantChange(beforePackage, afterPackage)) {
      return { shouldRun: true, reason: `${filePath} changed dependency-relevant fields` };
    }
  }

  return { shouldRun: false, reason: "package.json changes are script or metadata only" };
}

function writeGitHubOutput(shouldRun, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) {
    return;
  }
  appendFileSync(outputPath, `run_dependency_audit=${shouldRun}\n`, "utf8");
}

function isDirectRun() {
  const direct = process.argv[1];
  return Boolean(direct && import.meta.url.endsWith(direct));
}

function parseArgs(argv) {
  const args = { base: "", head: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = argv[i + 1] ?? "HEAD";
      i += 1;
    }
  }
  return args;
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const changedPaths = listChangedPaths(args.base, args.head);
    const result = shouldRunAuditForChangedPaths(changedPaths, args);
    console.log(result.reason);
    writeGitHubOutput(result.shouldRun);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    writeGitHubOutput(true);
    process.exit(1);
  }
}
