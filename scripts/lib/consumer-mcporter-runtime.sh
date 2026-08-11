#!/usr/bin/env bash

# Consumer mcporter payload contract. Keep the package identity in one place so
# fresh packaging, runtime-cache acceptance, and final app verification reject
# the same version, archive, CLI entrypoint, and license drift.
OPENCLAW_CONSUMER_MCPORTER_PACKAGE="mcporter"
OPENCLAW_CONSUMER_MCPORTER_VERSION="0.7.3"
OPENCLAW_CONSUMER_MCPORTER_INTEGRITY="sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA=="
OPENCLAW_CONSUMER_MCPORTER_LICENSE="MIT"
OPENCLAW_CONSUMER_MCPORTER_BIN="dist/cli.js"
OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION="1.0.0-beta.57"
OPENCLAW_CONSUMER_ROLLDOWN_ARM64_INTEGRITY="sha512-9c4FOhRGpl+PX7zBK5p17c5efpF9aSpTPgyigv57hXf5NjQUaJOOiejPLAtFiKNBIfm5Uu6yFkvLKzOafNvlTw=="
OPENCLAW_CONSUMER_ROLLDOWN_X64_INTEGRITY="sha512-6RsB8Qy4LnGqNGJJC/8uWeLWGOvbRL/KG5aJ8XXpSEupg/KQtlBEiFaYU/Ma5Usj1s+bt3ItkqZYAI50kSplBA=="

openclaw_verify_consumer_mcporter_runtime() {
  local node_bin="$1"
  local payload_root="$2"
  local receipt_mode="${3:-verify}"

  "$node_bin" --input-type=module - \
    "$payload_root" \
    "$OPENCLAW_CONSUMER_MCPORTER_PACKAGE" \
    "$OPENCLAW_CONSUMER_MCPORTER_VERSION" \
    "$OPENCLAW_CONSUMER_MCPORTER_INTEGRITY" \
    "$OPENCLAW_CONSUMER_MCPORTER_LICENSE" \
    "$OPENCLAW_CONSUMER_MCPORTER_BIN" \
    "$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION" \
    "$OPENCLAW_CONSUMER_ROLLDOWN_ARM64_INTEGRITY" \
    "$OPENCLAW_CONSUMER_ROLLDOWN_X64_INTEGRITY" \
    "$receipt_mode" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [
  payloadRoot,
  packageName,
  expectedVersion,
  expectedIntegrity,
  expectedLicense,
  expectedBin,
  expectedBindingVersion,
  expectedArm64Integrity,
  expectedX64Integrity,
  receiptMode,
] = process.argv.slice(2);
const fail = (message) => {
  throw new Error(`invalid packaged mcporter payload: ${message}`);
};
const readJson = (filePath, label) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is missing or invalid at ${filePath}: ${String(error)}`);
  }
};
const sha256 = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const rootPackage = readJson(path.join(payloadRoot, "package.json"), "root package.json");
const lock = readJson(path.join(payloadRoot, "package-lock.json"), "package-lock.json");
const installedRoot = path.join(payloadRoot, "node_modules", packageName);
const installedPackage = readJson(path.join(installedRoot, "package.json"), "installed package.json");
const lockedPackage = lock?.packages?.[`node_modules/${packageName}`];
const bindingContracts = [
  ["@rolldown/binding-darwin-arm64", expectedArm64Integrity],
  ["@rolldown/binding-darwin-x64", expectedX64Integrity],
];

if (rootPackage?.private !== true || rootPackage?.dependencies?.[packageName] !== expectedVersion) {
  fail(`root dependency must pin ${packageName}@${expectedVersion}`);
}
if (lock?.lockfileVersion !== 3 || lockedPackage?.version !== expectedVersion) {
  fail(`package lock must pin ${packageName}@${expectedVersion}`);
}
if (lockedPackage?.integrity !== expectedIntegrity) {
  fail(`integrity mismatch for ${packageName}@${expectedVersion}`);
}
if (installedPackage?.version !== expectedVersion) {
  fail(`installed version is ${JSON.stringify(installedPackage?.version)}, expected ${expectedVersion}`);
}
if (installedPackage?.license !== expectedLicense) {
  fail(`installed license is ${JSON.stringify(installedPackage?.license)}, expected ${expectedLicense}`);
}
if (installedPackage?.bin?.mcporter !== expectedBin) {
  fail(`installed bin is ${JSON.stringify(installedPackage?.bin?.mcporter)}, expected ${expectedBin}`);
}

// The Jarvis app is universal. npm normally omits the binding for the build
// host's opposite architecture, so require both native rolldown payloads.
const bindingReceipts = {};
for (const [bindingName, expectedBindingIntegrity] of bindingContracts) {
  const bindingRoot = path.join(payloadRoot, "node_modules", ...bindingName.split("/"));
  const bindingPackage = readJson(path.join(bindingRoot, "package.json"), `${bindingName} package.json`);
  const lockedBinding = lock?.packages?.[`node_modules/${bindingName}`];
  if (rootPackage?.dependencies?.[bindingName] !== expectedBindingVersion) {
    fail(`root dependency must pin ${bindingName}@${expectedBindingVersion}`);
  }
  if (bindingPackage?.version !== expectedBindingVersion || lockedBinding?.version !== expectedBindingVersion) {
    fail(`${bindingName} must be installed and locked at ${expectedBindingVersion}`);
  }
  if (lockedBinding?.integrity !== expectedBindingIntegrity) {
    fail(`integrity mismatch for ${bindingName}@${expectedBindingVersion}`);
  }
  const nativeName = fs.readdirSync(bindingRoot).find((name) => name.endsWith(".node"));
  if (!nativeName) {
    fail(`native binary is missing from ${bindingRoot}`);
  }
  bindingReceipts[bindingName] = {
    version: expectedBindingVersion,
    integrity: expectedBindingIntegrity,
    nativeSha256: sha256(path.join(bindingRoot, nativeName)),
  };
}

const cliPath = path.join(installedRoot, expectedBin);
if (!fs.statSync(cliPath, { throwIfNoEntry: false })?.isFile()) {
  fail(`CLI entrypoint is missing: ${cliPath}`);
}
const licenseName = fs
  .readdirSync(installedRoot)
  .find((name) => /^licen[sc]e(?:\.|$)/i.test(name) && fs.statSync(path.join(installedRoot, name)).isFile());
if (!licenseName) {
  fail(`MIT license notice is missing from ${installedRoot}`);
}

const expectedReceipt = {
  format: 1,
  package: packageName,
  version: expectedVersion,
  integrity: expectedIntegrity,
  license: expectedLicense,
  bin: expectedBin,
  cliSha256: sha256(cliPath),
  licenseSha256: sha256(path.join(installedRoot, licenseName)),
  rolldownBindings: bindingReceipts,
};
const receiptPath = path.join(payloadRoot, "receipt.json");
if (receiptMode === "write") {
  fs.writeFileSync(receiptPath, `${JSON.stringify(expectedReceipt, null, 2)}\n`, { mode: 0o644 });
} else {
  const receipt = readJson(receiptPath, "receipt.json");
  if (JSON.stringify(receipt) !== JSON.stringify(expectedReceipt)) {
    fail(`receipt does not match the installed package: ${receiptPath}`);
  }
}
NODE
}

openclaw_package_consumer_mcporter_runtime() {
  local node_bin="$1"
  local npm_bin="$2"
  local payload_root="$3"
  local stage_root=""

  if [[ ! -x "$node_bin" || ! -x "$npm_bin" ]]; then
    echo "ERROR: packaging mcporter requires executable Node and npm binaries." >&2
    return 1
  fi

  stage_root="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-consumer-mcporter.XXXXXX")"
  # Always clean the disposable prefix. npm never runs in the repository or in
  # user-global mode, so packaging cannot mutate either dependency surface.
  trap 'rm -rf "$stage_root"' RETURN
  "$node_bin" --input-type=module - \
    "$stage_root/package.json" \
    "$OPENCLAW_CONSUMER_MCPORTER_VERSION" \
    "$OPENCLAW_CONSUMER_ROLLDOWN_BINDING_VERSION" <<'NODE'
import fs from "node:fs";
const [packagePath, version, bindingVersion] = process.argv.slice(2);
fs.writeFileSync(
  packagePath,
  `${JSON.stringify({
    private: true,
    dependencies: {
      mcporter: version,
      "@rolldown/binding-darwin-arm64": bindingVersion,
      "@rolldown/binding-darwin-x64": bindingVersion,
    },
  }, null, 2)}\n`,
  { mode: 0o644 },
);
NODE
  (
    cd "$stage_root"
    # --force lets npm materialize both Darwin architecture packages in the
    # universal app payload instead of rejecting the non-host architecture.
    "$npm_bin" install --force --ignore-scripts --no-audit --no-fund --package-lock=true
  )
  openclaw_verify_consumer_mcporter_runtime "$node_bin" "$stage_root" write

  rm -rf "$payload_root"
  mkdir -p "$(dirname "$payload_root")"
  mv "$stage_root" "$payload_root"
  stage_root=""
  trap - RETURN
  openclaw_verify_consumer_mcporter_runtime "$node_bin" "$payload_root"
}
