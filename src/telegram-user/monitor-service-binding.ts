import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const bindingVersion = 1;
const bindingFileName = "monitor-service-binding.json";

export type TelegramUserMonitorBinding = {
  envFile?: string;
  session?: string;
};

export type TelegramUserMonitorBindingWrite = TelegramUserMonitorBinding & {
  env: NodeJS.ProcessEnv;
};

export type TelegramUserMonitorBindingSummary = {
  configured: boolean;
  envFile: { configured: boolean; present: boolean };
  session: { configured: boolean; present: boolean };
  source: "profile-state" | "none" | "unavailable";
};

type StoredBinding = TelegramUserMonitorBinding & {
  version: typeof bindingVersion;
};

/**
 * Selector normalization is shared by install planning and backend reads so the
 * persisted identity cannot vary with the working directory of a later CLI.
 */
export function normalizeTelegramUserMonitorSelector(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

export function resolveTelegramUserMonitorBindingPath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveStateDir(env), "telegram-user", bindingFileName);
}

function parseBinding(raw: string): TelegramUserMonitorBinding | null {
  let parsed: Partial<StoredBinding>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredBinding>;
  } catch (error) {
    throw new Error("Telegram monitor binding is not valid JSON.", { cause: error });
  }
  if (parsed.version !== bindingVersion) {
    // Absence is the only state eligible for legacy backfill. Failing closed
    // prevents an older CLI from replacing a newer binding format it cannot
    // safely interpret; explicit --env-file commands bypass this read.
    throw new Error(`Unsupported Telegram monitor binding version: ${String(parsed.version)}.`);
  }
  return {
    envFile: normalizeTelegramUserMonitorSelector(parsed.envFile),
    session: normalizeTelegramUserMonitorSelector(parsed.session),
  };
}

export async function readTelegramUserMonitorBinding(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramUserMonitorBinding | null> {
  try {
    return parseBinding(await fs.readFile(resolveTelegramUserMonitorBindingPath(env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Writes through a same-directory temporary file so readers see either the old
 * complete binding or the new one. Mode 0600 limits path metadata to the user.
 */
export async function writeTelegramUserMonitorBinding(
  params: TelegramUserMonitorBindingWrite,
): Promise<void> {
  const bindingPath = resolveTelegramUserMonitorBindingPath(params.env);
  const bindingDir = path.dirname(bindingPath);
  const stored: StoredBinding = {
    version: bindingVersion,
    envFile: normalizeTelegramUserMonitorSelector(params.envFile),
    session: normalizeTelegramUserMonitorSelector(params.session),
  };
  const tempPath = `${bindingPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.mkdir(bindingDir, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // Set final permissions before the commit point. Once rename succeeds,
    // this function must not report failure after publishing the new binding.
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, bindingPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Removes the persisted selector state when a failed install must restore the
 * previous absence of a binding. ENOENT is already the desired end state.
 */
export async function clearTelegramUserMonitorBinding(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await fs.rm(resolveTelegramUserMonitorBindingPath(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function exists(target: string | undefined): Promise<boolean> {
  if (!target) {
    return false;
  }
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Returns only non-sensitive readiness facts; selector paths never leave here. */
export async function summarizeTelegramUserMonitorBinding(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TelegramUserMonitorBindingSummary> {
  const binding = await readTelegramUserMonitorBinding(env);
  return {
    configured: binding !== null,
    source: binding === null ? "none" : "profile-state",
    envFile: {
      configured: Boolean(binding?.envFile),
      present: await exists(binding?.envFile),
    },
    session: {
      configured: Boolean(binding?.session),
      present: await exists(binding?.session),
    },
  };
}
