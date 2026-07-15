import crypto from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { getSessionGoal, resolveSessionGoalAutonomy } from "../../config/sessions/goals.js";
import { resolveStorePath as resolveSessionStorePath } from "../../config/sessions/paths.js";
import type { CronService } from "../../cron/service.js";
import type { CronJobCreate } from "../../cron/types.js";
import {
  resolveMonitorActionTarget,
  resolveMonitorOriginDelivery,
  resolveMonitorWatchDelivery,
} from "../../monitor/delivery.js";
import { routeMonitorEvent, type MonitorEventRoute } from "../../monitor/event-router.js";
import {
  applyMonitorNotificationEvent,
  resolveMonitorNotificationPolicy,
} from "../../monitor/notifications.js";
import { seedMonitorSession } from "../../monitor/session.js";
import {
  buildMonitorDisclosure,
  createMonitorListenerEvidence,
  createMonitorRecord,
  createMonitorIdentityKey,
  findMonitor,
  loadMonitorStore,
  normalizeMonitorInstructions,
  resolveMonitorStorePath,
  saveMonitorStore,
  updateMonitorRecord,
  withMonitorStoreWriteLock,
} from "../../monitor/store.js";
import {
  isTerminalMonitorStatus,
  type MonitorActionPolicy,
  type MonitorEventEnvelope,
  type MonitorEventTriggerKind,
  type MonitorGoalSnapshot,
  type MonitorNotificationEvent,
  type MonitorNotificationPolicy,
  type MonitorTriggerMatch,
  type MonitorTrigger,
  type MonitorUpdatePatch,
} from "../../monitor/types.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { normalizeWhatsAppLidJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMonitorCreateParams,
  validateMonitorGetParams,
  validateMonitorListParams,
  validateMonitorRouteEventParams,
  validateMonitorStopParams,
  validateMonitorUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function resolveStorePath(cronStorePath: string) {
  return resolveMonitorStorePath({ cronStorePath });
}

function resolveMonitorDisclosurePurpose(params: {
  instructions: string;
  name?: string;
  existingName?: string;
}): string {
  return params.name?.trim() || params.existingName?.trim() || params.instructions;
}

function normalizeMonitorCreateSource(params: {
  sourceType: string;
  sourceTarget: Record<string, unknown>;
}): { sourceType: string; sourceTarget: Record<string, unknown> } {
  const normalizedType = params.sourceType.trim().toLowerCase();
  const isTelegramUserSource =
    normalizedType === "telegram-user" ||
    normalizedType === "telegram_user_session" ||
    normalizedType === "telegram-user-session";
  if (!isTelegramUserSource) {
    return params;
  }

  const sourceTarget = { ...params.sourceTarget };
  if (sourceTarget.afterId === undefined && sourceTarget.afterMessageId !== undefined) {
    sourceTarget.afterId = sourceTarget.afterMessageId;
  }
  delete sourceTarget.afterMessageId;
  return { sourceType: "telegram-user", sourceTarget };
}

function normalizeMonitorCreateTrigger(
  trigger: MonitorTrigger | undefined,
  sourceType: string,
): MonitorTrigger | undefined {
  if (!trigger || sourceType !== "telegram-user" || trigger.kind === "schedule") {
    return trigger;
  }
  const eventTrigger = trigger.kind === "hybrid" ? trigger.event : trigger;
  const matchSourceType = eventTrigger.match?.sourceType?.trim().toLowerCase();
  if (matchSourceType !== "telegram_user_session" && matchSourceType !== "telegram-user-session") {
    return trigger;
  }
  const normalizedEvent = {
    ...eventTrigger,
    match: { ...eventTrigger.match, sourceType: "telegram-user" },
  };
  return trigger.kind === "hybrid" ? { ...trigger, event: normalizedEvent } : normalizedEvent;
}

function resolveGoalBoundEventTriggerKind(sourceType: string): MonitorEventTriggerKind | undefined {
  const normalized = sourceType.trim().toLowerCase();
  // Only default to adapters that exist today. Future listener adapters can add
  // their own defaults once they can emit the same monitor event envelope.
  if (normalized === "gmail") {
    return "webhook";
  }
  if (normalized === "telegram-user") {
    return "local_listener";
  }
  if (normalized === "whatsapp") {
    return "local_listener";
  }
  return undefined;
}

function readSourceTargetString(
  sourceTarget: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = sourceTarget[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveGmailEventSourceTarget(
  sourceTarget: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const threadId = readSourceTargetString(sourceTarget, ["threadId", "gmailThreadId"]);
  if (!threadId) {
    return undefined;
  }
  const account = readSourceTargetString(sourceTarget, ["account", "accountId", "emailAddress"]);
  if (!account) {
    return undefined;
  }
  return {
    account,
    threadId,
  };
}

function resolveTelegramUserEventSourceTarget(
  sourceTarget: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const chat = readSourceTargetString(sourceTarget, ["chat", "chatId", "target", "to"]);
  if (!chat) {
    return undefined;
  }

  // The local listener owns the watched chat configuration. Keep sourceTarget
  // to stable routing keys so inbound message text stays evidence, not authority.
  const eventSourceTarget: Record<string, unknown> = { chat };
  const accountId = readSourceTargetString(sourceTarget, ["accountId", "account"]);
  if (accountId) {
    eventSourceTarget.accountId = accountId;
  }
  const threadAnchor = readSourceTargetString(sourceTarget, [
    "threadAnchor",
    "topicAnchor",
    "topicId",
  ]);
  if (threadAnchor) {
    eventSourceTarget.threadAnchor = threadAnchor;
  }
  return eventSourceTarget;
}

function resolveWhatsAppEventSourceTarget(
  sourceTarget: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const eventSourceTarget: Record<string, unknown> = {};
  const accountId = readSourceTargetString(sourceTarget, ["accountId", "account"]);
  if (accountId) {
    eventSourceTarget.accountId = accountId;
  }

  // WhatsApp-as-me monitors can start from several user-facing aliases, but the
  // local listener adapter emits a canonical target plus the resolved chat JID.
  // Normalize aliases here so accepted monitor.create shapes still route to the
  // event envelope without trusting message text or sender-provided labels.
  const rawTarget = readSourceTargetString(sourceTarget, ["target", "to", "chat", "chatId"]);
  const normalizedLid = rawTarget ? normalizeWhatsAppLidJid(rawTarget) : null;
  if (normalizedLid) {
    eventSourceTarget.chatJid = normalizedLid;
  } else if (rawTarget) {
    eventSourceTarget.target = normalizeWhatsAppTarget(rawTarget) ?? rawTarget;
  }
  const chatJid = readSourceTargetString(sourceTarget, ["chatJid"]);
  if (chatJid) {
    eventSourceTarget.chatJid = normalizeWhatsAppLidJid(chatJid) ?? chatJid;
  }

  return Object.keys(eventSourceTarget).some((key) => key !== "accountId")
    ? eventSourceTarget
    : undefined;
}

function hasGmailSourceTargetQualifiers(sourceTarget: Record<string, unknown>): boolean {
  const qualifierTarget = { ...sourceTarget };
  delete qualifierTarget.account;
  delete qualifierTarget.accountId;
  delete qualifierTarget.emailAddress;
  delete qualifierTarget.threadId;
  delete qualifierTarget.gmailThreadId;
  return Object.keys(qualifierTarget).length > 0;
}

function resolveGoalBoundTriggerMatch(params: {
  sourceType: string;
  sourceTarget: Record<string, unknown>;
}): MonitorTriggerMatch | undefined {
  const normalized = params.sourceType.trim().toLowerCase();
  if (normalized === "gmail") {
    if (hasGmailSourceTargetQualifiers(params.sourceTarget)) {
      return undefined;
    }
    const eventSourceTarget = resolveGmailEventSourceTarget(params.sourceTarget);
    return eventSourceTarget
      ? { sourceType: params.sourceType, sourceTarget: eventSourceTarget }
      : undefined;
  }
  if (normalized === "telegram-user") {
    const eventSourceTarget = resolveTelegramUserEventSourceTarget(params.sourceTarget);
    return eventSourceTarget
      ? {
          sourceType: params.sourceType,
          sourceTarget: eventSourceTarget,
          eventTypes: ["message.created"],
        }
      : undefined;
  }
  if (normalized === "whatsapp") {
    const eventSourceTarget = resolveWhatsAppEventSourceTarget(params.sourceTarget);
    return eventSourceTarget
      ? {
          sourceType: params.sourceType,
          sourceTarget: eventSourceTarget,
          eventTypes: ["message.created"],
        }
      : undefined;
  }
  return { sourceType: params.sourceType, sourceTarget: params.sourceTarget };
}

function buildGoalBoundMonitorTrigger(params: {
  goal?: MonitorGoalSnapshot;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  cadence: CronJobCreate["schedule"];
}): MonitorTrigger | undefined {
  if (!params.goal) {
    return undefined;
  }
  const eventKind = resolveGoalBoundEventTriggerKind(params.sourceType);
  if (!eventKind) {
    return undefined;
  }
  const match = resolveGoalBoundTriggerMatch({
    sourceType: params.sourceType,
    sourceTarget: params.sourceTarget,
  });
  if (!match) {
    return undefined;
  }
  return {
    kind: "hybrid",
    schedule: { cadence: params.cadence },
    event: {
      kind: eventKind,
      match,
    },
  };
}

function resolveMonitorCreateTrigger(params: {
  explicitTrigger?: MonitorTrigger;
  goal?: MonitorGoalSnapshot;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  cadence: CronJobCreate["schedule"];
}): MonitorTrigger | undefined {
  return params.explicitTrigger
    ? normalizeTriggerScheduleCadence(params.explicitTrigger, params.cadence)
    : buildGoalBoundMonitorTrigger(params);
}

function resolveMonitorIdentitySourceTarget(params: {
  sourceType: string;
  sourceTarget: Record<string, unknown>;
}): Record<string, unknown> {
  if (params.sourceType.trim().toLowerCase() === "whatsapp") {
    return resolveWhatsAppEventSourceTarget(params.sourceTarget) ?? params.sourceTarget;
  }
  if (params.sourceType.trim().toLowerCase() !== "gmail") {
    return params.sourceTarget;
  }
  const eventSourceTarget = resolveGmailEventSourceTarget(params.sourceTarget);
  if (!eventSourceTarget) {
    return params.sourceTarget;
  }
  const normalized = { ...params.sourceTarget };
  delete normalized.accountId;
  delete normalized.emailAddress;
  delete normalized.gmailThreadId;
  return {
    ...normalized,
    ...eventSourceTarget,
  };
}

function createMonitorCreateIdentityKey(params: {
  agentId: string;
  sourceType: string;
  sourceTarget: Record<string, unknown>;
  actionPolicy?: MonitorActionPolicy;
  purposeLabel?: string;
}): string {
  return createMonitorIdentityKey({
    ...params,
    sourceTarget: resolveMonitorIdentitySourceTarget({
      sourceType: params.sourceType,
      sourceTarget: params.sourceTarget,
    }),
  });
}

function findActiveMonitorByCreateIdentity(
  store: Awaited<ReturnType<typeof loadMonitorStore>>,
  input: {
    agentId: string;
    sourceType: string;
    sourceTarget: Record<string, unknown>;
    actionPolicy?: MonitorActionPolicy;
    purposeLabel?: string;
  },
) {
  const identityKey = createMonitorCreateIdentityKey(input);
  return store.monitors.find(
    (monitor) =>
      (monitor.status === "active" || monitor.status === "degraded") &&
      createMonitorCreateIdentityKey({
        agentId: monitor.agentId,
        sourceType: monitor.sourceType,
        sourceTarget: monitor.sourceTarget,
        actionPolicy: monitor.actionPolicy,
        purposeLabel: monitor.name,
      }) === identityKey,
  );
}

function buildScheduleMonitorTrigger(cadence: CronJobCreate["schedule"]): MonitorTrigger {
  return { kind: "schedule", cadence };
}

function normalizeTriggerScheduleCadence(
  trigger: MonitorTrigger,
  cadence: CronJobCreate["schedule"],
): MonitorTrigger {
  if (trigger.kind === "schedule") {
    return { ...trigger, cadence };
  }
  if (trigger.kind === "hybrid") {
    return {
      ...trigger,
      schedule: {
        ...trigger.schedule,
        cadence,
      },
    };
  }
  return trigger;
}

function monitorTriggersEqual(
  left: MonitorTrigger | undefined,
  right: MonitorTrigger | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shouldUpgradeExistingTrigger(existing: MonitorTrigger | undefined): boolean {
  return !existing || existing.kind === "schedule";
}

async function resolveMonitorGoalSnapshot(params: {
  explicitGoal?: MonitorGoalSnapshot;
  originSessionKey: string;
  agentId: string;
  cfg: ReturnType<typeof loadConfig>;
}): Promise<MonitorGoalSnapshot | undefined> {
  if (params.explicitGoal) {
    return params.explicitGoal;
  }
  const snapshot = await getSessionGoal({
    sessionKey: params.originSessionKey,
    storePath: resolveSessionStorePath(params.cfg.session?.store, { agentId: params.agentId }),
    persist: false,
  });
  if (snapshot.status !== "found" || snapshot.goal?.status !== "active") {
    return undefined;
  }
  return {
    id: snapshot.goal.id,
    objective: snapshot.goal.objective,
    autonomy: resolveSessionGoalAutonomy(snapshot.goal),
  };
}

export type MonitorEventDispatchResult = {
  matched: number;
  wakes: Array<
    MonitorEventRoute & {
      enqueue: Awaited<ReturnType<CronService["enqueueRun"]>>;
    }
  >;
};

const MAX_PENDING_PROCESS_EXIT_EVENTS = 100;

function monitorEventIdentityKey(event: MonitorEventEnvelope): string {
  const idempotencyKey = event.idempotencyKey?.trim();
  if (idempotencyKey) {
    return idempotencyKey;
  }
  return JSON.stringify({
    triggerKind: event.triggerKind,
    sourceType: event.sourceType,
    sourceTarget: event.sourceTarget,
    eventType: event.eventType,
    receivedAtMs: event.receivedAtMs,
  });
}

async function replayPendingProcessExitEventsForMonitor(params: {
  cronStorePath: string;
  cron: Pick<CronService, "enqueueRun">;
  monitorId: string;
}) {
  const store = await loadMonitorStore(resolveStorePath(params.cronStorePath));
  const pendingProcessExitEvents =
    store.pendingEvents?.filter((event) => event.triggerKind === "process_exit") ?? [];
  for (const event of pendingProcessExitEvents) {
    await dispatchMonitorEventToCronUnlocked({
      cronStorePath: params.cronStorePath,
      cron: params.cron,
      event,
      monitorId: params.monitorId,
    });
  }
}

async function replayPendingProcessExitEventsIfPossible(params: {
  cronStorePath: string;
  cron: unknown;
  monitorId: string;
}) {
  const enqueueRun = (params.cron as Partial<Pick<CronService, "enqueueRun">>).enqueueRun;
  if (typeof enqueueRun !== "function") {
    return;
  }
  await replayPendingProcessExitEventsForMonitor({
    cronStorePath: params.cronStorePath,
    cron: { enqueueRun: enqueueRun.bind(params.cron) },
    monitorId: params.monitorId,
  });
}

export async function dispatchMonitorEventToCron(params: {
  cronStorePath: string;
  cron: Pick<CronService, "enqueueRun">;
  event: MonitorEventEnvelope;
  monitorId?: string;
}): Promise<MonitorEventDispatchResult> {
  const storePath = resolveStorePath(params.cronStorePath);
  return await withMonitorStoreWriteLock(
    storePath,
    async () => await dispatchMonitorEventToCronUnlocked(params),
  );
}

async function dispatchMonitorEventToCronUnlocked(params: {
  cronStorePath: string;
  cron: Pick<CronService, "enqueueRun">;
  event: MonitorEventEnvelope;
  monitorId?: string;
}): Promise<MonitorEventDispatchResult> {
  const storePath = resolveStorePath(params.cronStorePath);
  const store = await loadMonitorStore(storePath);
  const routes = routeMonitorEvent({ monitors: store.monitors, event: params.event }).filter(
    (route) => !params.monitorId || route.monitorId === params.monitorId,
  );
  let storeChanged = false;
  if (params.event.triggerKind === "process_exit") {
    const eventKey = monitorEventIdentityKey(params.event);
    if (routes.length === 0 && !params.monitorId) {
      // Fast background commands can exit before the monitor record exists.
      // Keep a small durable one-shot backlog so monitor.create can replay it.
      const pending = store.pendingEvents ?? [];
      if (!pending.some((event) => monitorEventIdentityKey(event) === eventKey)) {
        store.pendingEvents = [...pending, params.event]
          .filter((event) => event.triggerKind === "process_exit")
          .slice(-MAX_PENDING_PROCESS_EXIT_EVENTS);
        storeChanged = true;
      }
    }
    if (routes.length > 0 && store.pendingEvents?.length) {
      const pending = store.pendingEvents.filter(
        (event) => monitorEventIdentityKey(event) !== eventKey,
      );
      if (pending.length !== store.pendingEvents.length) {
        if (pending.length) {
          store.pendingEvents = pending;
        } else {
          delete store.pendingEvents;
        }
        storeChanged = true;
      }
    }
    // Process output is local to the originating exec session, so persist the
    // exit evidence before enqueueing the monitor wake that will inspect it.
    for (const route of routes) {
      const index = store.monitors.findIndex((monitor) => monitor.monitorId === route.monitorId);
      if (index >= 0) {
        const monitor = store.monitors[index];
        store.monitors[index] = updateMonitorRecord(
          monitor,
          {
            lastCheckpoint: {
              ...monitor.lastCheckpoint,
              processExitEvent: {
                eventType: params.event.eventType,
                idempotencyKey: params.event.idempotencyKey,
                receivedAtMs: params.event.receivedAtMs,
                sourceTarget: params.event.sourceTarget,
                evidence: params.event.evidence,
              },
            },
          },
          Date.now(),
        );
        storeChanged = true;
      }
    }
  }

  const listenerEvidence = createMonitorListenerEvidence(params.event, Date.now());
  if (listenerEvidence) {
    for (const route of routes) {
      const index = store.monitors.findIndex((monitor) => monitor.monitorId === route.monitorId);
      if (index >= 0) {
        store.monitors[index] = updateMonitorRecord(
          store.monitors[index],
          { listenerEvidence },
          listenerEvidence.updatedAtMs,
        );
        storeChanged = true;
      }
    }
  }
  if (storeChanged) {
    // Commit the evidence receipt before cron enqueue so a restart cannot make
    // an accepted listener wake look like it never reached this monitor.
    await saveMonitorStore(storePath, store);
  }

  const wakes: MonitorEventDispatchResult["wakes"] = [];
  for (const route of routes) {
    // The router only decides that this event belongs to the monitor. The
    // existing cron job remains the execution owner so origin delivery and
    // the durable monitor session stay exactly where the monitor was created.
    const enqueue = await params.cron.enqueueRun(route.cronJobId, "force");
    wakes.push({ ...route, enqueue });
  }
  return { matched: wakes.length, wakes };
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
    const rawParams = params as {
      instructions: string;
      agentId: string;
      name?: string;
      originSessionKey: string;
      originDelivery?: CronJobCreate["delivery"];
      watchDelivery?: CronJobCreate["delivery"];
      sourceType: string;
      sourceTarget: Record<string, unknown>;
      cadence: CronJobCreate["schedule"];
      trigger?: MonitorTrigger;
      expiryAt?: string;
      stopCondition?: string;
      actionPolicy?: MonitorActionPolicy;
      goal?: MonitorGoalSnapshot;
      notificationPolicy?: MonitorNotificationPolicy;
      lastCheckpoint?: Record<string, unknown>;
    };
    const instructions = normalizeMonitorInstructions(rawParams.instructions);
    const normalizedSource = normalizeMonitorCreateSource(rawParams);
    const p = {
      ...rawParams,
      instructions,
      sourceType: normalizedSource.sourceType,
      sourceTarget: normalizedSource.sourceTarget,
      trigger: normalizeMonitorCreateTrigger(rawParams.trigger, normalizedSource.sourceType),
    };
    const storePath = resolveStorePath(context.cronStorePath);
    await withMonitorStoreWriteLock(storePath, async () => {
      const store = await loadMonitorStore(storePath);
      const cfg = loadConfig();
      const goal = await resolveMonitorGoalSnapshot({
        explicitGoal: p.goal,
        originSessionKey: p.originSessionKey,
        agentId: p.agentId,
        cfg,
      });
      const trigger = resolveMonitorCreateTrigger({
        explicitTrigger: p.trigger,
        goal,
        sourceType: p.sourceType,
        sourceTarget: p.sourceTarget,
        cadence: p.cadence,
      });
      const existingMonitor = findActiveMonitorByCreateIdentity(store, {
        agentId: p.agentId,
        sourceType: p.sourceType,
        sourceTarget: p.sourceTarget,
        actionPolicy: p.actionPolicy,
        purposeLabel: p.name,
      });
      if (existingMonitor) {
        const reconciledTrigger = resolveMonitorCreateTrigger({
          explicitTrigger: p.trigger,
          goal,
          sourceType: p.sourceType,
          sourceTarget: p.sourceTarget,
          cadence: existingMonitor.cadence,
        });
        const nextTrigger =
          reconciledTrigger ??
          (!existingMonitor.trigger
            ? buildScheduleMonitorTrigger(existingMonitor.cadence)
            : undefined);
        const goalChanged = JSON.stringify(existingMonitor.goal) !== JSON.stringify(goal);
        const triggerChanged =
          nextTrigger !== undefined &&
          shouldUpgradeExistingTrigger(existingMonitor.trigger) &&
          !monitorTriggersEqual(existingMonitor.trigger, nextTrigger);
        const notificationPolicy = resolveMonitorNotificationPolicy(
          p.notificationPolicy ?? existingMonitor.notificationPolicy,
        );
        // Pre-change unnamed monitors stored their original task as the
        // disclosure purpose. Recover that persisted contract before trusting
        // text from a later duplicate request.
        const reconciledInstructions =
          existingMonitor.instructions?.trim() ||
          existingMonitor.disclosure?.purpose.trim() ||
          p.instructions;
        const disclosure = buildMonitorDisclosure({
          purpose: resolveMonitorDisclosurePurpose({
            instructions: reconciledInstructions,
            name: p.name,
            existingName: existingMonitor.name,
          }),
          name: existingMonitor.name,
          sourceType: existingMonitor.sourceType,
          sourceTarget: existingMonitor.sourceTarget,
          cadence: existingMonitor.cadence,
          expiryAt: existingMonitor.expiryAt,
          stopCondition: existingMonitor.stopCondition,
          actionPolicy: existingMonitor.actionPolicy,
          goal,
          notificationPolicy,
        });
        const contractChanged =
          JSON.stringify(existingMonitor.notificationPolicy) !==
            JSON.stringify(notificationPolicy) ||
          JSON.stringify(existingMonitor.disclosure) !== JSON.stringify(disclosure) ||
          existingMonitor.notificationState === undefined;
        // Duplicate identity intentionally ignores instructions: retries must
        // not create a second watcher or rewrite routing/cadence. Preserve an
        // existing original task, but repair legacy records that predate it.
        const instructionsChanged = !existingMonitor.instructions?.trim();
        const reconciled =
          goalChanged || triggerChanged || contractChanged || instructionsChanged
            ? updateMonitorRecord(
                existingMonitor,
                {
                  ...(instructionsChanged ? { instructions: reconciledInstructions } : {}),
                  ...(goalChanged ? { goal } : {}),
                  ...(triggerChanged ? { trigger: nextTrigger } : {}),
                  ...(contractChanged
                    ? {
                        notificationPolicy,
                        notificationState: existingMonitor.notificationState ?? {
                          consecutiveUnchangedChecks: 0,
                        },
                        disclosure,
                      }
                    : {}),
                },
                Date.now(),
              )
            : existingMonitor;
        if (reconciled !== existingMonitor) {
          const index = store.monitors.findIndex(
            (monitor) => monitor.monitorId === existingMonitor.monitorId,
          );
          if (index >= 0) {
            store.monitors[index] = reconciled;
            await saveMonitorStore(storePath, store);
          }
        }
        await replayPendingProcessExitEventsIfPossible({
          cronStorePath: context.cronStorePath,
          cron: context.cron,
          monitorId: reconciled.monitorId,
        });
        respond(true, reconciled, undefined);
        return;
      }
      const monitorId = crypto.randomBytes(12).toString("hex");
      const watchDelivery = resolveMonitorWatchDelivery({
        sourceType: p.sourceType,
        sourceTarget: p.sourceTarget,
        explicitWatchDelivery: p.watchDelivery,
      });
      const actionTarget = resolveMonitorActionTarget({
        sourceType: p.sourceType,
        sourceTarget: p.sourceTarget,
        explicitWatchDelivery: watchDelivery,
      });
      const monitorSessionKey = toAgentStoreSessionKey({
        agentId: p.agentId,
        requestKey: `monitor:${monitorId}`,
        mainKey: cfg.session?.mainKey,
      });
      const cronDelivery = resolveMonitorOriginDelivery({
        originSessionKey: p.originSessionKey,
        originDelivery: p.originDelivery,
      });
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
          instructions: p.instructions,
          originSessionKey: p.originSessionKey,
          originDelivery: createdJob.delivery,
          ...(watchDelivery ? { watchDelivery } : {}),
          monitorSessionKey,
          sourceType: p.sourceType,
          sourceTarget: p.sourceTarget,
          cadence: p.cadence,
          trigger,
          expiryAt: p.expiryAt,
          stopCondition: p.stopCondition,
          actionPolicy: p.actionPolicy,
          goal,
          purpose: resolveMonitorDisclosurePurpose({
            instructions: p.instructions,
            name: p.name,
          }),
          notificationPolicy: p.notificationPolicy,
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
        goal: monitor.goal,
        notificationPolicy: monitor.notificationPolicy,
        notificationState: monitor.notificationState,
        watchDeliveryConfigured: Boolean(actionTarget ?? watchDelivery),
        originSessionKey: p.originSessionKey,
        originDelivery: monitor.originDelivery,
      });
      await replayPendingProcessExitEventsIfPossible({
        cronStorePath: context.cronStorePath,
        cron: context.cron,
        monitorId: monitor.monitorId,
      });
      respond(true, monitor, undefined);
    });
  },
  "monitor.routeEvent": async ({ params, respond, context }) => {
    if (!validateMonitorRouteEventParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid monitor.routeEvent params: ${formatValidationErrors(validateMonitorRouteEventParams.errors)}`,
        ),
      );
      return;
    }

    const event = params as MonitorEventEnvelope;
    const result = await dispatchMonitorEventToCron({
      cronStorePath: context.cronStorePath,
      cron: context.cron,
      event,
    });

    respond(true, result, undefined);
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
    const p = params as {
      monitorId: string;
      patch: MonitorUpdatePatch & { notificationEvent?: MonitorNotificationEvent };
    };
    const storePath = resolveStorePath(context.cronStorePath);
    await withMonitorStoreWriteLock(storePath, async () => {
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
      const nowMs = Date.now();
      const { notificationEvent, ...recordPatch } = p.patch;
      const current = store.monitors[index];
      const notificationDecision = notificationEvent
        ? applyMonitorNotificationEvent({
            policy: recordPatch.notificationPolicy ?? current.notificationPolicy,
            state: current.notificationState,
            event: notificationEvent,
            nowMs,
            actionCapability: resolveSessionGoalAutonomy(recordPatch.goal ?? current.goal).level,
          })
        : undefined;
      const updated = updateMonitorRecord(
        current,
        {
          ...recordPatch,
          ...(notificationEvent === "completion" && recordPatch.status === undefined
            ? { status: "completed" }
            : {}),
          ...(notificationDecision ? { notificationState: notificationDecision.state } : {}),
        },
        nowMs,
      );
      store.monitors[index] = updated;
      await saveMonitorStore(storePath, store);
      if (isTerminalMonitorStatus(updated.status)) {
        await context.cron.update(updated.cronJobId, { enabled: false });
      }
      respond(
        true,
        notificationDecision
          ? {
              ...updated,
              notificationDecision: {
                shouldNotify: notificationDecision.shouldNotify,
                reason: notificationDecision.reason,
                ...(notificationDecision.nextAction
                  ? { nextAction: notificationDecision.nextAction }
                  : {}),
              },
            }
          : updated,
        undefined,
      );
    });
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
    await withMonitorStoreWriteLock(storePath, async () => {
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
    });
  },
};
