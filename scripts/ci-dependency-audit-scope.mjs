import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const LOCKFILE_OR_WORKSPACE_RE = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
const PACKAGE_JSON_RE =
  /^(package\.json|ui\/package\.json|extensions\/[^/]+\/package\.json|packages\/[^/]+\/package\.json)$/;
const PATCH_HASH_QUALIFIER_RE = /\(patch_hash=[^)]+\)/g;

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

function normalizeLockfilePatchMetadata(raw) {
  const normalizedNewlines = raw.replaceAll("\r\n", "\n");
  // Fail closed before normalization. This script runs before dependency
  // installation in the secrets job, so it deliberately uses structural
  // markers from pnpm's deterministic lock format instead of a YAML package.
  if (
    !normalizedNewlines.startsWith("lockfileVersion:") ||
    !normalizedNewlines.includes("\nimporters:\n") ||
    !normalizedNewlines.includes("\npackages:\n") ||
    !normalizedNewlines.includes("\nsnapshots:\n")
  ) {
    return null;
  }

  const lines = normalizedNewlines.split("\n");
  const normalized = [];
  let skippingTopLevelPatchBlock = false;
  for (const line of lines) {
    if (line === "patchedDependencies:") {
      skippingTopLevelPatchBlock = true;
      continue;
    }
    if (skippingTopLevelPatchBlock) {
      if (line.length === 0 || /^\s/u.test(line)) {
        continue;
      }
      skippingTopLevelPatchBlock = false;
    }
    // Blank-line and trailing-space churn has no dependency audit meaning.
    // Removing it also keeps deletion of the patch block's separator neutral.
    const normalizedLine = line.replaceAll(PATCH_HASH_QUALIFIER_RE, "").trimEnd();
    if (normalizedLine.length > 0) {
      normalized.push(normalizedLine);
    }
  }
  return normalized.join("\n");
}

export function compareProductionLockfileAuditView(beforeRaw, afterRaw) {
  const beforeNormalized = normalizeLockfilePatchMetadata(beforeRaw);
  const afterNormalized = normalizeLockfilePatchMetadata(afterRaw);
  if (beforeNormalized === null || afterNormalized === null) {
    return { comparable: false, reason: "pnpm-lock.yaml could not be parsed" };
  }
  const changed = beforeNormalized !== afterNormalized;
  return {
    comparable: true,
    inventoryChanged: changed,
    normalizedLockfileChanged: changed,
  };
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

function packageJsonHasNonPatchAuditRelevantChange(beforePackage, afterPackage) {
  const withoutPatchedDependencies = (packageJson) => {
    const normalized = structuredClone(packageJson);
    if (
      normalized?.pnpm &&
      typeof normalized.pnpm === "object" &&
      !Array.isArray(normalized.pnpm)
    ) {
      delete normalized.pnpm.patchedDependencies;
      if (Object.keys(normalized.pnpm).length === 0) {
        delete normalized.pnpm;
      }
    }
    return normalized;
  };
  return packageJsonHasAuditRelevantChange(
    withoutPatchedDependencies(beforePackage),
    withoutPatchedDependencies(afterPackage),
  );
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
  if (auditScopePaths.includes("pnpm-workspace.yaml")) {
    return { shouldRun: true, reason: "pnpm-workspace.yaml changed" };
  }

  let skippedPatchOnlyLockfileChange = false;
  if (auditScopePaths.includes("pnpm-lock.yaml")) {
    const beforeRaw = gitShowFile(base, "pnpm-lock.yaml");
    const afterRaw = gitShowFile(head, "pnpm-lock.yaml");
    if (beforeRaw === null || afterRaw === null) {
      return { shouldRun: true, reason: "pnpm-lock.yaml was added or removed" };
    }
    const comparison = compareProductionLockfileAuditView(beforeRaw, afterRaw);
    if (!comparison.comparable) {
      return { shouldRun: true, reason: comparison.reason };
    }
    if (comparison.normalizedLockfileChanged) {
      return { shouldRun: true, reason: "pnpm-lock.yaml changed beyond patch metadata" };
    }
    skippedPatchOnlyLockfileChange = true;
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
    const hasRelevantChange = skippedPatchOnlyLockfileChange
      ? packageJsonHasNonPatchAuditRelevantChange(beforePackage, afterPackage)
      : packageJsonHasAuditRelevantChange(beforePackage, afterPackage);
    if (hasRelevantChange) {
      return { shouldRun: true, reason: `${filePath} changed dependency-relevant fields` };
    }
  }

  if (skippedPatchOnlyLockfileChange) {
    return {
      shouldRun: false,
      reason: "pnpm-lock.yaml changed patch metadata only; registry package data is unchanged",
    };
  }
  return { shouldRun: false, reason: "package.json changes are script or metadata only" };
}

function writeGitHubOutput(shouldRun, outputPath = process.env.GITHUB_OUTPUT) {
  if (outputPath) {
    appendFileSync(outputPath, `run_dependency_audit=${shouldRun}\n`, "utf8");
  }
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
    } else if (argv[i] === "--head") {
      args.head = argv[i + 1] ?? "HEAD";
      i += 1;
    }
  }
  return args;
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = shouldRunAuditForChangedPaths(listChangedPaths(args.base, args.head), args);
    console.log(result.reason);
    writeGitHubOutput(result.shouldRun);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    writeGitHubOutput(true);
    process.exit(1);
  }
}
