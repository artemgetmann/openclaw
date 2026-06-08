import { getLogger } from "../logging.js";

const DEBUG_ENV = "OPENCLAW_TELEGRAM_PROGRESS_DEBUG";

type DebugFields = Record<string, boolean | number | string | undefined>;

function isDisabledDebugValue(value: string): boolean {
  return value === "" || value === "0" || value === "false" || value === "off" || value === "no";
}

export function isTelegramProgressDebugEnabled(): boolean {
  const raw = process.env[DEBUG_ENV]?.trim().toLowerCase();
  return raw != null && !isDisabledDebugValue(raw);
}

function formatDebugFields(fields: DebugFields | undefined): string {
  if (!fields) {
    return "";
  }
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function logTelegramProgressDebug(event: string, fields?: DebugFields): void {
  if (!isTelegramProgressDebugEnabled()) {
    return;
  }
  const message = `telegram-progress-debug: ${event}${formatDebugFields(fields)}`;
  try {
    getLogger().info({ message, ...fields }, "telegram-progress-debug");
  } catch {
    // Diagnostics must never affect delivery behavior.
  }
}
