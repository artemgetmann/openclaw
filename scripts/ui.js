#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat", ".com"]);
const WINDOWS_UNSAFE_SHELL_ARG_PATTERN = /[\r\n"&|<>^%!]/;

function usage() {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write("Usage: node scripts/ui.js <install|dev|build|test> [...args]\n");
}

function which(cmd) {
  try {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const paths = (process.env[key] ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
        : [""];
    for (const entry of paths) {
      for (const ext of extensions) {
        const candidate = path.join(entry, process.platform === "win32" ? `${cmd}${ext}` : cmd);
        try {
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function prependPathEntry(entry, currentPath = process.env.PATH ?? "") {
  if (!entry) {
    return currentPath;
  }
  const segments = currentPath.split(path.delimiter).filter(Boolean);
  if (segments.includes(entry)) {
    return currentPath || entry;
  }
  return currentPath ? `${entry}${path.delimiter}${currentPath}` : entry;
}

function collectNodeToolchainCandidates({
  nodeExecPath = process.execPath,
  envNodeBin = process.env.OPENCLAW_NODE_BIN,
  realpathSync = fs.realpathSync,
} = {}) {
  const candidates = [];
  const seen = new Set();

  function pushCandidate(candidate) {
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  pushCandidate(envNodeBin);
  pushCandidate(nodeExecPath);

  // Homebrew and similar package managers often expose one stable symlink and
  // one versioned cellar path. Probe both so the fallback survives whichever
  // path Node used to launch this script.
  for (const candidate of candidates) {
    try {
      pushCandidate(realpathSync(candidate));
    } catch {
      // ignore
    }
  }

  return candidates;
}

export function resolveCorepackBinary({
  nodeExecPath = process.execPath,
  envNodeBin = process.env.OPENCLAW_NODE_BIN,
  platform = process.platform,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  const corepackName = platform === "win32" ? "corepack.cmd" : "corepack";

  for (const candidateNode of collectNodeToolchainCandidates({
    nodeExecPath,
    envNodeBin,
    realpathSync,
  })) {
    const candidate = path.join(path.dirname(candidateNode), corepackName);
    try {
      if (existsSync(candidate)) {
        return {
          corepackPath: candidate,
          nodeExecPath: candidateNode,
        };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export function resolveRunner({
  pnpmPath,
  nodeExecPath = process.execPath,
  envNodeBin = process.env.OPENCLAW_NODE_BIN,
  platform = process.platform,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  const pnpm = pnpmPath === undefined ? which("pnpm") : pnpmPath;
  if (pnpm) {
    return { cmd: pnpm, argvPrefix: [], kind: "pnpm" };
  }

  // launchd often starts without the interactive shell PATH, so fall back to
  // the Corepack binary shipped with the active Node runtime before declaring
  // pnpm missing.
  const toolchain = resolveCorepackBinary({
    nodeExecPath,
    envNodeBin,
    platform,
    existsSync,
    realpathSync,
  });
  if (toolchain) {
    const nodeDir = path.dirname(toolchain.nodeExecPath);
    // Corepack itself is a node script (`#!/usr/bin/env node`), so launchd
    // recovery needs the exact Node/Corepack pair that lived together on disk
    // instead of trusting `node` to be on PATH or mixing two installs.
    return {
      cmd: toolchain.nodeExecPath,
      argvPrefix: [toolchain.corepackPath, "pnpm"],
      envPatch: {
        PATH: prependPathEntry(nodeDir),
      },
      kind: "corepack-pnpm",
    };
  }
  return null;
}

export function shouldUseShellForCommand(cmd, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }
  const extension = path.extname(cmd).toLowerCase();
  return WINDOWS_SHELL_EXTENSIONS.has(extension);
}

export function assertSafeWindowsShellArgs(args, platform = process.platform) {
  if (platform !== "win32") {
    return;
  }
  const unsafeArg = args.find((arg) => WINDOWS_UNSAFE_SHELL_ARG_PATTERN.test(arg));
  if (!unsafeArg) {
    return;
  }
  // SECURITY: `shell: true` routes through cmd.exe; reject risky metacharacters
  // in forwarded args to prevent shell control-flow/env-expansion injection.
  throw new Error(
    `Unsafe Windows shell argument: ${unsafeArg}. Remove shell metacharacters (" & | < > ^ % !).`,
  );
}

function createSpawnOptions(cmd, args, envOverride) {
  const useShell = shouldUseShellForCommand(cmd);
  if (useShell) {
    assertSafeWindowsShellArgs(args);
  }
  return {
    cwd: uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
    ...(useShell ? { shell: true } : {}),
  };
}

function run(cmd, args, envOverride) {
  let child;
  try {
    child = spawn(cmd, args, createSpawnOptions(cmd, args, envOverride));
  } catch (err) {
    console.error(`Failed to launch ${cmd}:`, err);
    process.exit(1);
    return;
  }

  child.on("error", (err) => {
    console.error(`Failed to launch ${cmd}:`, err);
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });
}

function runSync(cmd, args, envOverride) {
  let result;
  try {
    result = spawnSync(cmd, args, createSpawnOptions(cmd, args, envOverride));
  } catch (err) {
    console.error(`Failed to launch ${cmd}:`, err);
    process.exit(1);
    return;
  }
  if (result.signal) {
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function depsInstalled(kind) {
  try {
    const require = createRequire(path.join(uiDir, "package.json"));
    require.resolve("vite");
    require.resolve("dompurify");
    if (kind === "test") {
      require.resolve("vitest");
      require.resolve("@vitest/browser-playwright");
      require.resolve("playwright");
    }
    return true;
  } catch {
    return false;
  }
}

function resolveScriptAction(action) {
  if (action === "install") {
    return null;
  }
  if (action === "dev") {
    return "dev";
  }
  if (action === "build") {
    return "build";
  }
  if (action === "test") {
    return "test";
  }
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  if (!action) {
    usage();
    process.exit(2);
  }

  const runner = resolveRunner();
  if (!runner) {
    process.stderr.write(
      "Missing UI runner: install pnpm or use Node with corepack, then retry.\n",
    );
    process.exit(1);
  }

  const script = resolveScriptAction(action);
  if (action !== "install" && !script) {
    usage();
    process.exit(2);
  }

  if (action === "install") {
    const installEnv = runner.envPatch ? { ...process.env, ...runner.envPatch } : undefined;
    run(runner.cmd, [...runner.argvPrefix, "install", ...rest], installEnv);
    return;
  }

  if (!depsInstalled(action === "test" ? "test" : "build")) {
    const baseInstallEnv =
      action === "build" ? { ...process.env, NODE_ENV: "production" } : process.env;
    const installEnv = runner.envPatch ? { ...baseInstallEnv, ...runner.envPatch } : baseInstallEnv;
    const installArgs = action === "build" ? ["install", "--prod"] : ["install"];
    runSync(runner.cmd, [...runner.argvPrefix, ...installArgs], installEnv);
  }

  const runEnv = runner.envPatch ? { ...process.env, ...runner.envPatch } : undefined;
  run(runner.cmd, [...runner.argvPrefix, "run", script, ...rest], runEnv);
}

const isDirectExecution = (() => {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main();
}
