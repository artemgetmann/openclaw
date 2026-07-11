import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const LOCKFILE_OR_WORKSPACE_RE = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml)$/;
const PACKAGE_JSON_RE =
  /^(package\.json|ui\/package\.json|extensions\/[^/]+\/package\.json|packages\/[^/]+\/package\.json)$/;
const PRODUCTION_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];
const PATCH_HASH_QUALIFIER_RE = /\(patch_hash=[^)]+\)/g;
const LOCAL_DEPENDENCY_REFERENCE_RE = /^(file:|link:|workspace:)/;
const NORMALIZED_LOCKFILE_IGNORED_FIELDS = new Set(["patchedDependencies"]);
const NORMALIZED_LOCKFILE_GRAPH_FIELDS = new Set(["importers", "packages", "snapshots"]);

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

function parseLockfile(raw) {
  try {
    const parsed = parseYaml(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripPatchHashQualifiers(value) {
  return value.replaceAll(PATCH_HASH_QUALIFIER_RE, "");
}

function isLocalDependencyReference(reference) {
  return LOCAL_DEPENDENCY_REFERENCE_RE.test(reference);
}

function dependencyEntryToReference(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (isPlainObject(entry) && typeof entry.version === "string") {
    return entry.version;
  }
  return null;
}

function dependencyReferenceToSnapshotLocator(dependencyName, reference) {
  const normalizedReference = stripPatchHashQualifiers(reference);
  if (isLocalDependencyReference(normalizedReference)) {
    return normalizedReference;
  }
  // pnpm stores aliased scoped packages and git/tarball resolutions as the
  // resolved package locator, not under the dependency's alias name.
  const referenceWithoutPeers = normalizedReference.split("(", 1)[0] ?? normalizedReference;
  if (referenceWithoutPeers.includes("@")) {
    return normalizedReference;
  }
  if (normalizedReference.startsWith(`${dependencyName}@`)) {
    return normalizedReference;
  }
  return `${dependencyName}@${normalizedReference}`;
}

function snapshotLocatorToPackageKey(locator) {
  return stripPatchHashQualifiers(locator).split("(")[0] ?? "";
}

function normalizeDependencyMap(dependencies) {
  if (dependencies === undefined) {
    return {};
  }
  if (!isPlainObject(dependencies)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(dependencies)
      .map(([dependencyName, dependencyEntry]) => {
        const reference = dependencyEntryToReference(dependencyEntry);
        if (reference === null) {
          return null;
        }
        return [dependencyName, dependencyReferenceToSnapshotLocator(dependencyName, reference)];
      })
      .filter(Boolean)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeSnapshotEntry(snapshotEntry) {
  if (!isPlainObject(snapshotEntry)) {
    return null;
  }
  const normalizedEntry = stableJson(snapshotEntry);
  for (const dependencyField of PRODUCTION_DEPENDENCY_FIELDS) {
    const normalizedDependencies = normalizeDependencyMap(snapshotEntry[dependencyField]);
    if (normalizedDependencies === null) {
      return null;
    }
    if (Object.keys(normalizedDependencies).length > 0) {
      normalizedEntry[dependencyField] = normalizedDependencies;
    } else {
      delete normalizedEntry[dependencyField];
    }
  }
  return normalizedEntry;
}

function buildNormalizedProductionLockfile(lockfile) {
  const importers = lockfile.importers;
  const packages = lockfile.packages;
  const snapshots = lockfile.snapshots;
  if (!isPlainObject(importers) || !isPlainObject(packages) || !isPlainObject(snapshots)) {
    return {
      ok: false,
      reason: "pnpm-lock.yaml is missing importers, packages, or snapshots",
    };
  }

  const normalizedImporters = {};
  const reachablePackageEntries = {};
  const reachableSnapshotEntries = {};
  const resolvedProductionInventory = new Set();
  const pendingLocators = [];
  const snapshotKeysByNormalizedLocator = new Map();

  for (const snapshotKey of Object.keys(snapshots)) {
    const normalizedLocator = stripPatchHashQualifiers(snapshotKey);
    if (snapshotKeysByNormalizedLocator.has(normalizedLocator)) {
      return {
        ok: false,
        reason: `pnpm-lock.yaml has ambiguous normalized snapshot ${normalizedLocator}`,
      };
    }
    snapshotKeysByNormalizedLocator.set(normalizedLocator, snapshotKey);
  }

  for (const [importerName, importerEntry] of Object.entries(importers)) {
    if (!isPlainObject(importerEntry)) {
      return { ok: false, reason: `pnpm-lock.yaml importer ${importerName} is malformed` };
    }

    const normalizedImporterDependencies = {};
    for (const dependencyField of PRODUCTION_DEPENDENCY_FIELDS) {
      const normalizedDependencies = normalizeDependencyMap(importerEntry[dependencyField]);
      if (normalizedDependencies === null) {
        return {
          ok: false,
          reason: `pnpm-lock.yaml importer ${importerName} has malformed ${dependencyField}`,
        };
      }
      if (Object.keys(normalizedDependencies).length > 0) {
        normalizedImporterDependencies[dependencyField] = normalizedDependencies;
      }
      for (const locator of Object.values(normalizedDependencies)) {
        if (!isLocalDependencyReference(locator)) {
          pendingLocators.push(locator);
        }
      }
    }

    normalizedImporters[importerName] = normalizedImporterDependencies;
  }

  const visitedLocators = new Set();
  while (pendingLocators.length > 0) {
    const locator = pendingLocators.pop();
    if (!locator || visitedLocators.has(locator)) {
      continue;
    }
    visitedLocators.add(locator);

    const packageKey = snapshotLocatorToPackageKey(locator);
    if (!packageKey) {
      return { ok: false, reason: `pnpm-lock.yaml locator ${locator} could not be normalized` };
    }

    const packageEntry = packages[packageKey];
    const snapshotKey = snapshotKeysByNormalizedLocator.get(locator);
    const snapshotEntry = snapshotKey ? snapshots[snapshotKey] : undefined;
    if (!isPlainObject(packageEntry) || !isPlainObject(snapshotEntry)) {
      return {
        ok: false,
        reason: `pnpm-lock.yaml could not resolve ${locator} from the production dependency graph`,
      };
    }

    resolvedProductionInventory.add(packageKey);
    reachablePackageEntries[packageKey] = stableJson(packageEntry);

    const normalizedSnapshotEntry = normalizeSnapshotEntry(snapshotEntry);
    if (normalizedSnapshotEntry === null) {
      return { ok: false, reason: `pnpm-lock.yaml snapshot ${locator} is malformed` };
    }
    // Store by the normalized locator so adding or refreshing a pnpm patch hash
    // cannot look like a registry package/version change.
    reachableSnapshotEntries[locator] = normalizedSnapshotEntry;

    for (const dependencyField of PRODUCTION_DEPENDENCY_FIELDS) {
      for (const dependencyLocator of Object.values(
        normalizedSnapshotEntry[dependencyField] ?? {},
      )) {
        if (!isLocalDependencyReference(dependencyLocator)) {
          pendingLocators.push(dependencyLocator);
        }
      }
    }
  }

  // Security invariant: registry audit can only speak to the registry-resolved
  // production graph. We intentionally ignore pnpm's patch hash/path metadata
  // so patch-only lockfile churn does not inherit unrelated advisory debt, but
  // we keep every other reachable production metadata field fail-closed.
  const normalizedTopLevel = Object.fromEntries(
    Object.entries(lockfile)
      .filter(
        ([key]) =>
          !NORMALIZED_LOCKFILE_GRAPH_FIELDS.has(key) &&
          !NORMALIZED_LOCKFILE_IGNORED_FIELDS.has(key),
      )
      .map(([key, value]) => [key, stableJson(value)]),
  );

  return {
    ok: true,
    normalizedLockfile: stableJson({
      topLevel: normalizedTopLevel,
      importers: normalizedImporters,
      packages: reachablePackageEntries,
      snapshots: reachableSnapshotEntries,
    }),
    resolvedProductionInventory: [...resolvedProductionInventory].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export function compareProductionLockfileAuditView(beforeRaw, afterRaw) {
  const beforeLockfile = parseLockfile(beforeRaw);
  const afterLockfile = parseLockfile(afterRaw);
  if (beforeLockfile === null || afterLockfile === null) {
    return { comparable: false, reason: "pnpm-lock.yaml could not be parsed" };
  }

  const beforeNormalized = buildNormalizedProductionLockfile(beforeLockfile);
  if (!beforeNormalized.ok) {
    return { comparable: false, reason: beforeNormalized.reason };
  }

  const afterNormalized = buildNormalizedProductionLockfile(afterLockfile);
  if (!afterNormalized.ok) {
    return { comparable: false, reason: afterNormalized.reason };
  }

  const inventoryChanged =
    JSON.stringify(beforeNormalized.resolvedProductionInventory) !==
    JSON.stringify(afterNormalized.resolvedProductionInventory);
  const normalizedLockfileChanged =
    JSON.stringify(beforeNormalized.normalizedLockfile) !==
    JSON.stringify(afterNormalized.normalizedLockfile);

  return {
    comparable: true,
    inventoryChanged,
    normalizedLockfileChanged,
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
    if (isPlainObject(normalized?.pnpm)) {
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
    if (comparison.inventoryChanged) {
      return {
        shouldRun: true,
        reason: "pnpm-lock.yaml changed the resolved production package inventory",
      };
    }
    if (comparison.normalizedLockfileChanged) {
      return {
        shouldRun: true,
        reason: "pnpm-lock.yaml changed reachable production lock metadata beyond patch hashes",
      };
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

    // A pnpm patch declaration changes install behavior, but registry audit
    // cannot inspect local patch code. Only suppress that declaration when the
    // lockfile comparison above independently proved the resolved production
    // graph identical after removing patch metadata. Every other manifest
    // change remains audit-relevant and fails closed.
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
      reason:
        "pnpm-lock.yaml changed patch metadata only and the resolved production package inventory is unchanged",
    };
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
