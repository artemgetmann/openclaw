#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import buildConfigs from "../tsdown.config.ts";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const extraArgs = process.argv.slice(2);

// tsdown executes every configuration in one config file with Promise.all.
// This repository has several large, independent entry graphs, so the default
// behavior retains all of those bundler graphs at once and can push a 16 GiB
// development host into active swapping. Build the same named configurations
// one at a time; only the first build may clean dist, otherwise a later build
// would erase the outputs produced by its predecessors.
const serialConfigs = buildConfigs.map((config) => config.name);
if (
  serialConfigs.length === 0 ||
  serialConfigs.some((name) => typeof name !== "string" || name.length === 0) ||
  new Set(serialConfigs).size !== serialConfigs.length
) {
  throw new Error("Every tsdown build configuration must have a unique non-empty name.");
}

function runTsdown(args) {
  const result = spawnSync(
    "pnpm",
    ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel, ...args],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  // A signal or spawn failure has no numeric status. Keep the prior fail-closed
  // behavior instead of treating an incomplete build as success.
  return typeof result.status === "number" ? result.status : 1;
}

// Explicit filtering is a targeted developer operation. Preserve its existing
// single-invocation semantics rather than stacking our aggregate filter on top.
const callerSelectedConfig = extraArgs.some(
  (arg, index) =>
    arg === "--filter" ||
    arg === "-F" ||
    arg.startsWith("--filter=") ||
    (index > 0 && (extraArgs[index - 1] === "--filter" || extraArgs[index - 1] === "-F")),
);

// Watch mode is one persistent aggregate process. Serial spawnSync calls would
// never advance beyond the first graph, silently leaving the other entries
// unwatched. Preserve tsdown's original all-config watcher for this developer
// mode; the memory-bounded sequence applies only to terminating builds.
const watchMode = extraArgs.some(
  (arg) => arg === "--watch" || arg === "-w" || arg.startsWith("--watch="),
);
if (callerSelectedConfig || watchMode) {
  process.exit(runTsdown(extraArgs));
}

// Clean is a global output-directory operation, not a per-config preference.
// Remove caller clean flags before serializing so a trailing --clean cannot
// override --no-clean and erase graphs already emitted by earlier invocations.
// Preserve an explicit final --no-clean for incremental developer builds.
const cleanFlags = extraArgs.filter((arg) => arg === "--clean" || arg === "--no-clean");
const serialExtraArgs = extraArgs.filter((arg) => arg !== "--clean" && arg !== "--no-clean");
const cleanFirstGraph = cleanFlags.at(-1) !== "--no-clean";

for (const [index, configName] of serialConfigs.entries()) {
  const cleanArgs = index === 0 && cleanFirstGraph ? ["--clean"] : ["--no-clean"];
  const status = runTsdown(["--filter", configName, ...cleanArgs, ...serialExtraArgs]);
  if (status !== 0) {
    process.exit(status);
  }
}
