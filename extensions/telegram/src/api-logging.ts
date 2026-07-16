import { danger } from "../../../src/globals.js";
import { formatErrorMessage } from "../../../src/infra/errors.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import { formatTelegramTransportErrorForLogging } from "./fetch.js";

export type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: RuntimeEnv;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

function resolveTelegramApiLogger(runtime?: RuntimeEnv, logger?: TelegramApiLogger) {
  if (logger) {
    return logger;
  }
  if (runtime?.error) {
    return runtime.error;
  }
  return (message: string) => fallbackLogger.error(message);
}

export async function withTelegramApiErrorLogging<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
}: TelegramApiLoggingParams<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!shouldLog || shouldLog(err)) {
      // Transport errors retain raw causes for code-level diagnosis, but logs expose only
      // ordered phases plus repository-redacted messages. Never stringify attempt objects:
      // underlying fetch errors can contain Bot API URLs with the token in the path.
      const errText = formatTelegramTransportErrorForLogging(err) ?? formatErrorMessage(err);
      const log = resolveTelegramApiLogger(runtime, logger);
      log(danger(`telegram ${operation} failed: ${errText}`));
    }
    throw err;
  }
}
