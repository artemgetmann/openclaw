import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  classifyFatalListenerHealthError,
  resolveListenerHealthStorePath,
  updateListenerHealth,
  type ListenerHealthSnapshot,
} from "../monitor/listener-health.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  pollWhatsAppMonitorEvents,
  type WhatsAppMonitorPollDispatchContext,
} from "../whatsapp/monitor-listener.js";

const DEFAULT_WHATSAPP_MONITOR_POLL_INTERVAL_MS = 1_000;

function readBooleanOpt(opts: Record<string, unknown>, key: string): boolean {
  return opts[key] === true;
}

function readNumberOpt(opts: Record<string, unknown>, key: string): number | undefined {
  const value = opts[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readStringOpt(opts: Record<string, unknown>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasProvidedOpt(opts: Record<string, unknown>, key: string): boolean {
  const value = opts[key];
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.trim().length > 0)
  );
}

function readPositiveIntegerOpt(
  opts: Record<string, unknown>,
  key: string,
  flag: string,
  context: string,
): number | undefined {
  const value = readNumberOpt(opts, key);
  if (value === undefined) {
    if (hasProvidedOpt(opts, key)) {
      throw new Error(`${context} requires ${flag} to be a positive integer.`);
    }
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${context} requires ${flag} to be a positive integer.`);
  }
  return value;
}

export function resolveLocalWhatsAppMonitorHookUrl(hookUrl: string): string {
  let url: URL;
  try {
    url = new URL(hookUrl);
  } catch (err) {
    throw new Error(`WhatsApp monitor poll requires a valid --hook-url: ${String(err)}`, {
      cause: err,
    });
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopbackHosts.has(url.hostname)) {
    throw new Error("WhatsApp monitor poll --hook-url must point to the local gateway.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath.endsWith("/monitor-event")) {
    throw new Error("WhatsApp monitor poll --hook-url must target the generic monitor-event hook.");
  }
  url.pathname = normalizedPath;
  return url.toString();
}

async function postWhatsAppMonitorEventHook(
  context: WhatsAppMonitorPollDispatchContext,
  opts: Record<string, unknown>,
  hookUrl: string,
) {
  const hookToken = readStringOpt(opts, "hookToken") ?? process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(hookToken ? { Authorization: `Bearer ${hookToken}` } : {}),
    },
    // The WhatsApp adapter already returns the generic MonitorEventEnvelope.
    // Post that exact shape so the gateway's existing monitor-event normalizer
    // owns validation and route/enqueue behavior.
    body: JSON.stringify({
      ...context.event,
      monitorId: context.monitor.monitorId,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`whatsapp monitor hook returned HTTP ${response.status}: ${body}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function logJson(runtime: RuntimeEnv, payload: unknown) {
  runtime.log(JSON.stringify(payload, null, 2));
}

function formatWhatsAppMonitorPollText(
  result: Awaited<ReturnType<typeof pollWhatsAppMonitorEvents>>,
  runNumber?: number,
): string {
  const lines = [
    `WhatsApp monitor poll${runNumber ? ` run=${runNumber}` : ""} checked=${result.checked} events=${result.events.length} dispatched=${result.dispatched} updated_cursors=${result.updatedCursors} skipped=${result.skipped.length}`,
    `Cursor store: ${result.cursorStorePath}`,
  ];
  for (const skipped of result.skipped) {
    lines.push(
      `Skipped ${skipped.monitorId}: ${skipped.reason}${skipped.error ? ` (${skipped.error})` : ""}`,
    );
  }
  for (const event of result.events) {
    lines.push(
      `Event ${event.monitor.monitorId}: target=${event.target} idempotency=${event.event.idempotencyKey ?? "-"}`,
    );
  }
  if (!result.events.length && !result.skipped.length) {
    lines.push("No WhatsApp monitor events detected.");
  }
  return lines.join("\n");
}

export async function whatsappMonitorPollCommand(
  opts: Record<string, unknown>,
  runtime: RuntimeEnv,
) {
  const dbPath = readStringOpt(opts, "dbPath");
  if (!dbPath) {
    throw new Error("WhatsApp monitor poll requires --db-path.");
  }

  const hookUrl = readStringOpt(opts, "hookUrl");
  const localHookUrl = hookUrl ? resolveLocalWhatsAppMonitorHookUrl(hookUrl) : undefined;
  const commitWithoutDispatch = readBooleanOpt(opts, "commitWithoutDispatch");
  const watch = readBooleanOpt(opts, "watch");
  const maxRuns = readPositiveIntegerOpt(opts, "maxRuns", "--max-runs", "WhatsApp monitor poll");
  const pollIntervalMs =
    readPositiveIntegerOpt(opts, "pollIntervalMs", "--poll-interval-ms", "WhatsApp monitor poll") ??
    DEFAULT_WHATSAPP_MONITOR_POLL_INTERVAL_MS;

  if (watch && !localHookUrl && !commitWithoutDispatch) {
    throw new Error(
      "WhatsApp monitor poll --watch requires --hook-url or --commit-without-dispatch so matched events can advance the cursor.",
    );
  }

  const basePollOptions = {
    commitWithoutDispatch,
    cronStorePath: readStringOpt(opts, "cronStore"),
    cursorStorePath: readStringOpt(opts, "cursorStore"),
    dbPath,
    monitorStorePath: readStringOpt(opts, "monitorStore"),
    dispatchEvent:
      localHookUrl && !commitWithoutDispatch
        ? async (context: WhatsAppMonitorPollDispatchContext) =>
            postWhatsAppMonitorEventHook(context, opts, localHookUrl)
        : undefined,
  };

  const listenerStartedAtMs = Date.now();
  const healthStorePath = watch
    ? resolveListenerHealthStorePath({
        cronStorePath: basePollOptions.cronStorePath,
        env: process.env,
        monitorStorePath: basePollOptions.monitorStorePath,
      })
    : undefined;
  const reportHealthTransition = (snapshot: ListenerHealthSnapshot) => {
    if (snapshot.transition === "degraded") {
      runtime.error(
        `WhatsApp listener health degraded: ${snapshot.record.lastError ?? "listener check failed"}`,
      );
    } else if (snapshot.transition === "recovered") {
      runtime.log("WhatsApp listener health recovered.");
    }
  };
  let healthPersistenceWarningEmitted = false;
  const persistHealth = async (input: Parameters<typeof updateListenerHealth>[0]) => {
    try {
      const snapshot = await updateListenerHealth(input);
      healthPersistenceWarningEmitted = false;
      reportHealthTransition(snapshot);
    } catch {
      if (!healthPersistenceWarningEmitted) {
        runtime.error("WhatsApp listener health persistence unavailable.");
        healthPersistenceWarningEmitted = true;
      }
    }
  };

  for (let runNumber = 1; ; runNumber += 1) {
    let result: Awaited<ReturnType<typeof pollWhatsAppMonitorEvents>>;
    try {
      result = await pollWhatsAppMonitorEvents(basePollOptions);
    } catch (err) {
      if (healthStorePath) {
        await persistHealth({
          check: "failure",
          error: classifyFatalListenerHealthError(err),
          owner: {
            pid: process.pid,
            profile: process.env.OPENCLAW_PROFILE,
            startedAtMs: listenerStartedAtMs,
          },
          pollIntervalMs,
          service: "whatsapp",
          storePath: healthStorePath,
        });
      }
      throw err;
    }

    if (healthStorePath) {
      const operationalErrors = result.skipped.filter(
        (skip) => skip.reason === "lookup_error" || skip.reason === "dispatch_error",
      );
      await persistHealth({
        check: operationalErrors.length > 0 ? "failure" : "success",
        error: operationalErrors.map((skip) => skip.reason).join(","),
        owner: {
          pid: process.pid,
          profile: process.env.OPENCLAW_PROFILE,
          startedAtMs: listenerStartedAtMs,
        },
        pollIntervalMs,
        routedEvent: result.dispatched > 0,
        service: "whatsapp",
        storePath: healthStorePath,
      });
    }
    if (readBooleanOpt(opts, "json")) {
      logJson(runtime, watch ? { run: runNumber, ...result } : result);
    } else {
      runtime.log(formatWhatsAppMonitorPollText(result, watch ? runNumber : undefined));
    }

    if (!watch || (maxRuns !== undefined && runNumber >= maxRuns)) {
      return;
    }
    await sleep(pollIntervalMs);
  }
}
