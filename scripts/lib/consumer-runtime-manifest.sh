#!/usr/bin/env bash

openclaw_refresh_consumer_runtime_manifest() {
  local node_bin="$1"
  local manifest_path="$2"
  local git_commit="$3"
  local app_build="$4"

  "$node_bin" --input-type=module - "$manifest_path" "$git_commit" "$app_build" <<'NODE'
import fs from "node:fs";

const [manifestPath, gitCommit, appBuild] = process.argv.slice(2);
const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.format !== 1) {
  throw new Error(`Bundled runtime manifest has an unsupported structure: ${manifestPath}`);
}

for (const field of ["bundleVersion", "gitCommit", "nodeVersion", "uvVersion", "runtimeInputKey"]) {
  if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
    throw new Error(`Bundled runtime manifest has no non-empty string ${field}: ${manifestPath}`);
  }
}
if (!/^[0-9a-f]{7,40}$/i.test(parsed.gitCommit.trim())) {
  throw new Error(`Bundled runtime manifest has an invalid gitCommit: ${manifestPath}`);
}
if (!/^[0-9a-f]{7,40}$/i.test(gitCommit?.trim() ?? "") || !appBuild?.trim()) {
  throw new Error("Current git commit and app build are required for runtime manifest refresh");
}

// Cache/reuse keeps the runtime payload inputs fixed, but package identity must
// follow the build-info.json copied from the current checkout. Preserve the
// payload fields and update only the two package receipt fields atomically.
const next = {
  ...parsed,
  bundleVersion: appBuild,
  gitCommit,
};
const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
const mode = fs.statSync(manifestPath).mode;
fs.writeFileSync(temporaryPath, `${JSON.stringify(next)}\n`, { mode });
fs.renameSync(temporaryPath, manifestPath);
NODE
}
