import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const requireFromRoot = createRequire(path.join(ROOT_DIR, "package.json"));
const MATRIX_CRYPTO_PACKAGE = "@matrix-org/matrix-sdk-crypto-nodejs";
const MATRIX_CRYPTO_DIST_UNIVERSAL = "matrix-sdk-crypto.darwin-universal.node";
const MATRIX_CRYPTO_DIST_X64 = "matrix-sdk-crypto.darwin-x64.node";
const MATRIX_CRYPTO_DIST_ARM64 = "matrix-sdk-crypto.darwin-arm64.node";

function log(message) {
  process.stderr.write(`[matrix-crypto] ${message}\n`);
}

function resolveMatrixCryptoPackageDir() {
  // Worktrees under `.worktrees/` inherit hoisted dependencies from the sacred
  // home clone, so resolve via Node instead of hard-coding a local node_modules path.
  const packageJsonPath = requireFromRoot.resolve(`${MATRIX_CRYPTO_PACKAGE}/package.json`);
  return path.dirname(packageJsonPath);
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed ${response.status} ${response.statusText} for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(arrayBuffer));
}

async function ensurePackageBinary(params) {
  const targetPath = path.join(params.packageDir, params.fileName);
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  // The npm tarball intentionally ships without native payloads; the official
  // release assets are the source of truth for darwin binaries.
  const url = `https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v${params.version}/${params.fileName}`;
  log(`downloading ${params.fileName}`);
  await downloadFile(url, targetPath);
  return targetPath;
}

function ensureUniversalBinary(params) {
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
  execFileSync(
    "/usr/bin/lipo",
    ["-create", params.arm64Path, params.x64Path, "-output", params.outputPath],
    {
      stdio: "inherit",
    },
  );
}

export async function ensureMatrixCryptoDarwinArtifacts(params = {}) {
  if (process.platform !== "darwin") {
    return null;
  }

  const packageDir = params.packageDir ?? resolveMatrixCryptoPackageDir();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const version = params.version ?? packageJson.version;
  const distDir = params.distDir ?? path.join(ROOT_DIR, "dist");

  const arm64Path = await ensurePackageBinary({
    packageDir,
    version,
    fileName: MATRIX_CRYPTO_DIST_ARM64,
  });
  const x64Path = await ensurePackageBinary({
    packageDir,
    version,
    fileName: MATRIX_CRYPTO_DIST_X64,
  });

  if (!fs.existsSync(distDir)) {
    return {
      packageDir,
      arm64Path,
      x64Path,
      distDir,
      distX64Path: null,
      universalPath: null,
    };
  }

  // tsdown only materializes the host-arch asset automatically. Seed the x64
  // twin and a universal binary into dist so the generated loader can satisfy
  // both Intel and Apple Silicon without any packaging-time surgery.
  const distX64Path = path.join(distDir, MATRIX_CRYPTO_DIST_X64);
  fs.copyFileSync(x64Path, distX64Path);
  const universalPath = path.join(distDir, MATRIX_CRYPTO_DIST_UNIVERSAL);
  ensureUniversalBinary({
    arm64Path,
    x64Path,
    outputPath: universalPath,
  });

  return {
    packageDir,
    arm64Path,
    x64Path,
    distDir,
    distX64Path,
    universalPath,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await ensureMatrixCryptoDarwinArtifacts();
}
