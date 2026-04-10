import crypto from "node:crypto";
import { loadConfig } from "../../config/config.js";
import type { CronJobCreate } from "../../cron/types.js";
import { seedMonitorSession } from "../../monitor/session.js";
import {
  createMonitorRecord,
  findMonitor,
  loadMonitorStore,
  resolveMonitorStorePath,
  saveMonitorStore,
  updateMonitorRecord,
} from "../../monitor/store.js";
import type { MonitorActionPolicy, MonitorUpdatePatch } from "../../monitor/types.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMonitorCreateParams,
  validateMonitorGetParams,
  validateMonitorListParams,
  validateMonitorStopParams,
  validateMonitorUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function resolveStorePath(cronStorePath: string) {
  return resolveMonitorStorePath({ cronStorePath });
}

function resolveMonitorDelivery(
  originDelivery: CronJobCreate["delivery"] | undefined,
): CronJobCreate["delivery"] | undefined {
  if (!originDelivery) {
    return undefined;
  }
  if (originDelivery.mode === "webhook" || originDelivery.mode === "none") {
    return originDelivery;
  }
  // CLI-origin monitors do not have a channel/to target. In that case the
  // wake should still run and write into the durable origin session instead of
  // forcing a broken channel-style announce delivery.
  if (!originDelivery.channel && !originDelivery.to) {
    return undefined;
  }
  return {
    mode: "announce",
    channel: originDelivery.channel,
    to: originDelivery.to,
    accountId: originDelivery.accountId,
  };
}

export const monitorHandlers: GatewayRequestHandlers = {
  "monitor.list": async ({ params, respond, context }) => {
    if (!validateMonitorListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid monitor.list params: ${formatValidationErrors(validateMonitorListParams.errors)}`,
        ),
      );
      return;
    }
    const store = await loadMonitorStore(resolveStorePath(context.cronStorePath));
    respond(true, { monitors: store.monitors }, undefined);
  },
  "monitor.get": async ({ params, respond, context }) => {
    if (!validateMonitorGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid monitor.get params: ${formatValidationErrors(validateMonitorGetParams.errors)}`,
        ),
      );
      return;
    }
    const monitorId = (params as { monitorId: string }).monitorId;
    const store = await loadMonitorStore(resolveStorePath(context.cronStorePath));
    const monitor = findMonitor(store, monitorId);
    if (!monitor) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `monitor not found: ${monitorId}`),
      );
      return;
    }
    respond(true, monitor, undefined);
  },
  "monitor.create": async ({ params, respond, context }) => {
    if (!validateMonitorCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid monitor.create params: ${formatValidationErrors(validateMonitorCreateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      instructions: string;
      agentId: string;
      name?: string;
      originSessionKey: string;
      originDelivery?: CronJobCreate["delivery"];
      sourceType: string;
      sourceTarget: Record<string, unknown>;
      cadence: CronJobCreate["schedule"];
      expiryAt?: string;
      stopCondition?: string;
      actionPolicy?: MonitorActionPolicy;
      lastCheckpoint?: Record<string, unknown>;
    };
    const storePath = resolveStorePath(context.cronStorePath);
    const store = await loadMonitorStore(storePath);
    const monitorId = crypto.randomBytes(12).toString("hex");
    const cfg = loadConfig();
    const monitorSessionKey = toAgentStoreSessionKey({
      agentId: p.agentId,
      requestKey: `monitor:${monitorId}`,
      mainKey: cfg.session?.mainKey,
    });
    const cronDelivery = resolveMonitorDelivery(p.originDelivery);
    const cronJob: CronJobCreate = {
      name: p.name?.trim() || `${p.sourceType.trim()} monitor`,
      enabled: true,
      schedule: p.cadence,
      sessionTarget: `session:${monitorSessionKey}`,
      wakeMode: "next-heartbeat",
      payload: {
        kind: "monitorWake",
        monitorId,
      },
      delivery: cronDelivery,
      agentId: p.agentId,
    };
    const createdJob = await context.cron.add(cronJob);
    const monitor = createMonitorRecord(
      {
        monitorId,
        agentId: p.agentId,
        name: p.name,
        originSessionKey: p.originSessionKey,
        originDelivery: createdJob.delivery,
        monitorSessionKey,
        sourceType: p.sourceType,
        sourceTarget: p.sourceTarget,
        cadence: p.cadence,
        expiryAt: p.expiryAt,
        stopCondition: p.stopCondition,
        actionPolicy: p.actionPolicy,
        lastCheckpoint: p.lastCheckpoint,
        cronJobId: createdJob.id,
      },
      Date.now(),
    );
    store.monitors.push(monitor);
    await saveMonitorStore(storePath, store);
    await seedMonitorSession({
      cfg,
      agentId: p.agentId,
      sessionKey: monitor.monitorSessionKey,
      sessionId: crypto.randomUUID(),
      label: `Monitor: ${monitor.name ?? monitor.sourceType}`,
      instructions: p.instructions,
      sourceType: p.sourceType,
      sourceTarget: p.sourceTarget,
      cadence: p.cadence,
      stopCondition: p.stopCondition,
      expiryAt: p.expiryAt,
      actionPolicy: monitor.actionPolicy,
      originSessionKey: p.originSessionKey,
    });
    respond(true, monitor, undefined);
  },
  "monitor.update": async ({ params, respond, context }) => {
    if (!validateMonitorUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid monitor.update params: ${formatValidationErrors(validateMonitorUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { monitorId: string; patch: MonitorUpdatePatch };
    const storePath = resolveStorePath(context.cronStorePath);
    const store = await loadMonitorStore(storePath);
    const index = store.monitors.findIndex((monitor) => monitor.monitorId === p.monitorId);
    if (index === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `monitor not found: ${p.monitorId}`),
      );
      return;
    }
    const updated = updateMonitorRecord(store.monitors[index], p.patch, Date.now());
    store.monitors[index] = updated;
    await saveMonitorStore(storePath, store);
    if (updated.status !== "active") {
      await context.cron.update(updated.cronJobId, { enabled: false });
    }
    respond(true, updated, undefined);
  },
  "monitor.stop": async ({ params, respond, context }) => {
    if (!validateMonitorStopParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid monitor.stop params: ${formatValidationErrors(validateMonitorStopParams.errors)}`,
        ),
      );
      return;
    }
    const monitorId = (params as { monitorId: string }).monitorId;
    const storePath = resolveStorePath(context.cronStorePath);
    const store = await loadMonitorStore(storePath);
    const index = store.monitors.findIndex((monitor) => monitor.monitorId === monitorId);
    if (index === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `monitor not found: ${monitorId}`),
      );
      return;
    }
    const stopped = updateMonitorRecord(store.monitors[index], { status: "stopped" }, Date.now());
    store.monitors[index] = stopped;
    await saveMonitorStore(storePath, store);
    await context.cron.update(stopped.cronJobId, { enabled: false });
    respond(true, stopped, undefined);
  },
};
