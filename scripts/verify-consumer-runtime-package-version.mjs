#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appPath = process.argv[2];

if (!appPath) {
  console.error("Usage: scripts/verify-consumer-runtime-package-version.mjs <app_path>");
  process.exit(2);
}

const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
const runtimePackagePath = path.join(
  appPath,
  "Contents",
  "Resources",
  "OpenClawRuntime",
  "openclaw",
  "package.json",
);

function readPlistValue(plistPath, key) {
  return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
    encoding: "utf8",
  }).trim();
}

if (!fs.existsSync(infoPlistPath)) {
  console.error(`ERROR: app Info.plist missing: ${infoPlistPath}`);
  process.exit(1);
}

if (!fs.existsSync(runtimePackagePath)) {
  console.error(`ERROR: bundled runtime package.json missing: ${runtimePackagePath}`);
  process.exit(1);
}

const appVersion = readPlistValue(infoPlistPath, "CFBundleShortVersionString");
const runtimePackage = JSON.parse(fs.readFileSync(runtimePackagePath, "utf8"));
const runtimeVersion = runtimePackage.version;

if (typeof runtimeVersion !== "string" || runtimeVersion.length === 0) {
  console.error(`ERROR: bundled runtime package.json has no string version: ${runtimePackagePath}`);
  process.exit(1);
}

if (runtimeVersion !== appVersion) {
  console.error("ERROR: consumer app version and bundled runtime package version differ.");
  console.error(`  app_version=${appVersion}`);
  console.error(`  runtime_package_version=${runtimeVersion}`);
  console.error(`  runtime_package_json=${runtimePackagePath}`);
  process.exit(1);
}

process.stdout.write(`${runtimeVersion}\n`);
