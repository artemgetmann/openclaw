import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGoogleChromeExecutableForPlatform } from "../browser/chrome.executables.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";

export type ArtifactExecutableName =
  | "chrome"
  | "node"
  | "pdfinfo"
  | "pdftoppm"
  | "python"
  | "soffice";

export type ArtifactExecutableResolution = {
  name: ArtifactExecutableName;
  path: string | null;
  source: "browser-config" | "env" | "path" | "process" | "runtime" | "unavailable";
};

export type ArtifactRuntimeResolution = {
  roots: string[];
  executables: Record<ArtifactExecutableName, ArtifactExecutableResolution>;
};

export type ArtifactCommandRuntime = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
};

export type ArtifactCommandRunner = (
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
) => Promise<SpawnResult>;

const EXECUTABLES: ArtifactExecutableName[] = [
  "chrome",
  "node",
  "pdfinfo",
  "pdftoppm",
  "python",
  "soffice",
];

const ENV_EXECUTABLES: Record<ArtifactExecutableName, string[]> = {
  chrome: ["OPENCLAW_ARTIFACT_CHROME", "CHROME_PATH"],
  node: ["OPENCLAW_ARTIFACT_NODE"],
  pdfinfo: ["OPENCLAW_ARTIFACT_PDFINFO"],
  pdftoppm: ["OPENCLAW_ARTIFACT_PDFTOPPM"],
  python: ["OPENCLAW_ARTIFACT_PYTHON"],
  soffice: ["OPENCLAW_ARTIFACT_SOFFICE", "SOFFICE"],
};

const RUNTIME_ROOT_ENVS = ["OPENCLAW_ARTIFACT_RUNTIME_DIR"];

export function normalizePdfScale(raw: unknown): number {
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : 1;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("PDF scale must be a positive number.");
  }
  if (value < 0.1 || value > 2) {
    throw new Error("PDF scale must be between 0.1 and 2.");
  }
  return value;
}

export function resolveHtmlInputUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("HTML input is required.");
  }
  if (/^https?:\/\//i.test(trimmed) || /^file:/i.test(trimmed)) {
    return trimmed;
  }
  return pathToFileURL(path.resolve(resolveUserPath(trimmed))).href;
}

function exists(filePath: string | undefined): filePath is string {
  return Boolean(filePath && fs.existsSync(filePath));
}

function resolveEnvPath(name: ArtifactExecutableName, env: NodeJS.ProcessEnv) {
  for (const key of ENV_EXECUTABLES[name]) {
    const candidate = env[key]?.trim();
    if (exists(candidate)) {
      return { path: candidate, source: "env" as const };
    }
  }
  return null;
}

function getRuntimeRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  for (const key of RUNTIME_ROOT_ENVS) {
    const raw = env[key]?.trim();
    if (raw) {
      roots.push(resolveUserPath(raw));
    }
  }
  return Array.from(new Set(roots.filter((root) => root && fs.existsSync(root))));
}

function executableNames(name: ArtifactExecutableName): string[] {
  if (name === "python") {
    return ["python3.12", "python3", "python"];
  }
  if (name === "node") {
    return ["node"];
  }
  if (name === "chrome") {
    return ["chrome", "google-chrome", "chromium", "chromium-browser"];
  }
  return [name];
}

function resolveFromRuntimeRoots(
  name: ArtifactExecutableName,
  roots: string[],
): ArtifactExecutableResolution | null {
  for (const root of roots) {
    // Explicit artifact runtimes may keep tools in a few common nested bins.
    // Never search a developer-product cache implicitly: packaged Jarvis must
    // behave the same on a clean customer machine.
    const binDirs = [
      path.join(root, "bin"),
      path.join(root, "dependencies", "bin"),
      path.join(root, "python", "bin"),
      path.join(root, "dependencies", "python", "bin"),
      path.join(root, "node", "bin"),
      path.join(root, "dependencies", "node", "bin"),
    ];
    for (const binDir of binDirs) {
      for (const exeName of executableNames(name)) {
        const candidate = path.join(binDir, exeName);
        if (exists(candidate)) {
          return { name, path: candidate, source: "runtime" };
        }
      }
    }
  }
  return null;
}

function resolveFromPath(name: ArtifactExecutableName, env: NodeJS.ProcessEnv) {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const exeName of executableNames(name)) {
      const candidate = path.join(dir, exeName);
      if (exists(candidate)) {
        return { name, path: candidate, source: "path" as const };
      }
    }
  }
  return null;
}

function resolveChrome(env: NodeJS.ProcessEnv): ArtifactExecutableResolution {
  const envPath = resolveEnvPath("chrome", env);
  if (envPath) {
    return { name: "chrome", ...envPath };
  }
  const detected = resolveGoogleChromeExecutableForPlatform(process.platform);
  if (detected?.path) {
    return { name: "chrome", path: detected.path, source: "browser-config" };
  }
  return resolveFromPath("chrome", env) ?? { name: "chrome", path: null, source: "unavailable" };
}

export function resolveArtifactRuntime(env: NodeJS.ProcessEnv = process.env) {
  const roots = getRuntimeRoots(env);
  const executables = {} as Record<ArtifactExecutableName, ArtifactExecutableResolution>;

  for (const name of EXECUTABLES) {
    if (name === "chrome") {
      executables[name] = resolveChrome(env);
      continue;
    }
    if (name === "node") {
      executables[name] = { name, path: process.execPath, source: "process" };
      continue;
    }
    const envPath = resolveEnvPath(name, env);
    executables[name] = envPath
      ? { name, ...envPath }
      : (resolveFromRuntimeRoots(name, roots) ??
        resolveFromPath(name, env) ?? { name, path: null, source: "unavailable" });
  }

  return { roots, executables };
}

export function requireArtifactExecutable(
  runtime: ArtifactRuntimeResolution,
  name: ArtifactExecutableName,
): string {
  const resolved = runtime.executables[name];
  if (!resolved.path) {
    throw new Error(`Artifact runtime dependency missing: ${name}.`);
  }
  return resolved.path;
}

export async function defaultArtifactCommandRunner(
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("Missing command.");
  }
  return await runCommandWithTimeout([command, ...args], options);
}
