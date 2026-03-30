import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import type {
  TelegramUserBackendMeta,
  TelegramUserBackendError,
  TelegramUserBackendOptions,
  TelegramUserPrecheck,
  TelegramUserReadResult,
  TelegramUserSendResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

function resolveRepoRoot(): string {
  const importDir = path.dirname(fileURLToPath(import.meta.url));
  const directCandidates = [
    process.cwd(),
    path.resolve(importDir, "..", ".."),
    path.resolve(importDir, "..", "..", ".."),
  ];

  for (const candidate of directCandidates) {
    if (fsSync.existsSync(path.join(candidate, "scripts", "telegram-e2e", "requirements.txt"))) {
      return candidate;
    }
  }

  let current = path.resolve(process.cwd());
  while (true) {
    if (fsSync.existsSync(path.join(current, "scripts", "telegram-e2e", "requirements.txt"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error("Could not locate the repo root for Telegram user tooling.");
}

const repoRoot = resolveRepoRoot();
const telegramE2eDir = path.join(repoRoot, "scripts", "telegram-e2e");
const backendScriptPath = path.join(telegramE2eDir, "telethon_cli.py");
const requirementsPath = path.join(telegramE2eDir, "requirements.txt");
const defaultEnvFilePath = path.join(telegramE2eDir, ".env.local");
const defaultSessionPath = path.join(telegramE2eDir, "tmp", "userbot.session");

type PythonInvocation = {
  argsPrefix: string[];
  command: string;
};

type BackendCallOptions = TelegramUserBackendOptions & {
  args: string[];
};

type BackendEnvBuild = {
  env: NodeJS.ProcessEnv;
  meta: TelegramUserBackendMeta;
};

function resolveVenvPythonPath(): string {
  if (process.platform === "win32") {
    return path.join(telegramE2eDir, ".venv", "Scripts", "python.exe");
  }
  return path.join(telegramE2eDir, ".venv", "bin", "python");
}

function sanitizeBackendText(raw: string, env: NodeJS.ProcessEnv): string {
  let text = raw;
  for (const secret of [
    env.TELEGRAM_API_HASH,
    env.TELEGRAM_BOT_TOKEN,
    env.TG_BOT_TOKEN,
    env.OPENCLAW_TELEGRAM_USER_API_HASH,
  ]) {
    if (secret) {
      text = text.split(secret).join("<redacted>");
    }
  }
  return text.trim();
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadScopedEnvFile(
  envFilePath: string | null | undefined,
): Promise<Record<string, string>> {
  if (!envFilePath) {
    return {};
  }
  if (!(await fileExists(envFilePath))) {
    return {};
  }
  const raw = await fs.readFile(envFilePath, "utf8");
  const parsed = dotenv.parse(raw);
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

async function detectSystemPython(): Promise<PythonInvocation> {
  const candidates: PythonInvocation[] =
    process.platform === "win32"
      ? [
          { command: "py", argsPrefix: ["-3"] },
          { command: "python", argsPrefix: [] },
        ]
      : [
          { command: "python3", argsPrefix: [] },
          { command: "python", argsPrefix: [] },
        ];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.command, [...candidate.argsPrefix, "-c", "import sys"], {
        timeout: 8_000,
      });
      return candidate;
    } catch {
      // Try the next interpreter candidate.
    }
  }

  throw new Error("Python 3 is required for Telegram user E2E tooling.");
}

async function ensureTelethonPython(): Promise<string> {
  const venvPython = resolveVenvPythonPath();
  if (await fileExists(venvPython)) {
    try {
      await execFileAsync(venvPython, ["-c", "import telethon"], { timeout: 8_000 });
      return venvPython;
    } catch {
      // Fall through to repair the virtualenv in place.
    }
  }

  const python = await detectSystemPython();
  const venvDir = path.join(telegramE2eDir, ".venv");
  await execFileAsync(python.command, [...python.argsPrefix, "-m", "venv", venvDir], {
    timeout: 60_000,
  });
  await execFileAsync(
    venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
    {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  await execFileAsync(venvPython, ["-c", "import telethon"], { timeout: 8_000 });
  return venvPython;
}

function resolveTelegramCredSource(
  loadedEnv: Record<string, string>,
  key: "TELEGRAM_API_ID" | "TELEGRAM_API_HASH",
): TelegramUserBackendMeta["api_id_source"] {
  if ((loadedEnv[key] ?? "").trim()) {
    return "env-file";
  }
  if ((process.env[key] ?? "").trim()) {
    return "process-env";
  }
  return "missing";
}

async function buildBackendEnv(options: TelegramUserBackendOptions): Promise<BackendEnvBuild> {
  const envFilePath = options.envFile ? path.resolve(options.envFile) : defaultEnvFilePath;
  const loadedEnv = await loadScopedEnvFile(envFilePath);
  const sessionPath = path.resolve(options.session ?? defaultSessionPath);
  return {
    env: {
      ...process.env,
      ...loadedEnv,
      OPENCLAW_TELEGRAM_USER_ENV_FILE: envFilePath,
      OPENCLAW_TELEGRAM_USER_SESSION: sessionPath,
    },
    meta: {
      api_hash_source: resolveTelegramCredSource(loadedEnv, "TELEGRAM_API_HASH"),
      api_id_source: resolveTelegramCredSource(loadedEnv, "TELEGRAM_API_ID"),
      env_file: envFilePath,
      session_path: sessionPath,
    },
  };
}

function parseBackendJson<T>(raw: string, fallbackMessage: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}

function parseBackendError(
  stderr: string,
  env: NodeJS.ProcessEnv,
  meta: TelegramUserBackendMeta,
): Error {
  const sanitized = sanitizeBackendText(stderr, env);
  if (!sanitized) {
    return new Error("Telegram user backend failed without diagnostic output.");
  }
  try {
    const parsed = JSON.parse(sanitized) as { error?: TelegramUserBackendError };
    if (parsed?.error?.message) {
      const details =
        parsed.error.code === "E_MISSING_CREDS"
          ? ` env_file=${meta.env_file} session=${meta.session_path} api_id_source=${meta.api_id_source} api_hash_source=${meta.api_hash_source}`
          : "";
      return new Error(`${parsed.error.code}: ${parsed.error.message}${details}`);
    }
  } catch {
    // Fall back to the raw sanitized stderr.
  }
  return new Error(sanitized);
}

function readExecErrorStderr(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) {
    return "";
  }
  const stderr = error.stderr;
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8");
  }
  return "";
}

async function runBackendCommand<T>(options: BackendCallOptions): Promise<T> {
  const python = await ensureTelethonPython();
  const { env, meta } = await buildBackendEnv(options);
  try {
    const { stdout } = await execFileAsync(python, [backendScriptPath, ...options.args], {
      cwd: repoRoot,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const sanitizedStdout = sanitizeBackendText(stdout, env);
    const parsed = parseBackendJson<T & { backend_meta?: TelegramUserBackendMeta }>(
      sanitizedStdout,
      "Telegram user backend returned invalid JSON output.",
    );
    parsed.backend_meta ??= meta;
    return parsed;
  } catch (error) {
    throw parseBackendError(readExecErrorStderr(error), env, meta);
  }
}

function pushOptionalNumberArg(args: string[], flag: string, value: number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    args.push(flag, String(Math.trunc(value)));
  }
}

function pushOptionalStringArg(args: string[], flag: string, value: string | null | undefined) {
  if (typeof value === "string" && value.trim()) {
    args.push(flag, value);
  }
}

export function getTelegramUserDefaults() {
  return {
    backendScriptPath,
    defaultEnvFilePath,
    defaultSessionPath,
    telegramE2eDir,
  };
}

export async function runTelegramUserPrecheck(
  params: {
    chat?: string | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserPrecheck> {
  const args = ["precheck"];
  pushOptionalStringArg(args, "--chat", params.chat);
  return runBackendCommand<TelegramUserPrecheck>({
    ...params,
    args,
  });
}

export async function runTelegramUserSend(
  params: {
    chat: string;
    message: string;
    replyTo?: number | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserSendResult> {
  const args = ["send", "--chat", params.chat, "--message", params.message];
  pushOptionalNumberArg(args, "--reply-to", params.replyTo);
  return runBackendCommand<TelegramUserSendResult>({
    ...params,
    args,
  });
}

export async function runTelegramUserRead(
  params: {
    afterId?: number | null;
    beforeId?: number | null;
    chat: string;
    limit?: number | null;
  } & TelegramUserBackendOptions,
): Promise<TelegramUserReadResult> {
  const args = ["read", "--chat", params.chat];
  pushOptionalNumberArg(args, "--limit", params.limit);
  pushOptionalNumberArg(args, "--after-id", params.afterId);
  pushOptionalNumberArg(args, "--before-id", params.beforeId);
  return runBackendCommand<TelegramUserReadResult>({
    ...params,
    args,
  });
}

export function getTelegramUserDefaultPollIntervalMs(): number {
  return 1_000;
}

export function getTelegramUserDefaultWaitTimeoutMs(): number {
  return 45_000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
