import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_ROUTES = 1_000;
const MAX_CALLBACKS_PER_ROUTE = 100;
const COMPLETED_ROUTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type CodexDurableCallbackStatus = "progress" | "blocked" | "decision-needed" | "complete";

export type CodexDurableCallbackInput = {
  callbackId: string;
  sequence: number;
  status: CodexDurableCallbackStatus;
  message: string;
  changedFiles?: string[];
  proof?: string[];
  nextAction?: string;
  workContinues?: boolean;
};

export type CodexDurableCallbackEnvelope = CodexDurableCallbackInput & {
  routeId: string;
  threadId: string;
  sessionKey: string;
  agentId?: string;
  turnId?: string;
  relayId?: string;
};

export type CodexCallbackRouteGrant = {
  routeId: string;
  capability: string;
  threadId: string;
  sessionKey: string;
  agentId?: string;
  nextSequence: number;
};

type StoredCallback = {
  callbackId: string;
  sequence: number;
  fingerprint: string;
  delivery: "started" | "delivered";
  envelope: CodexDurableCallbackEnvelope;
  startedAtMs: number;
  deliveredAtMs?: number;
};

type StoredRoute = {
  routeId: string;
  capability: string;
  threadId: string;
  sessionKey: string;
  agentId?: string;
  nextSequence: number;
  callbacks: StoredCallback[];
  createdAtMs: number;
  updatedAtMs: number;
  activeTurnId?: string;
  activeRelayId?: string;
  completedAtMs?: number;
  retiredAtMs?: number;
};

type RegistryDocument = {
  version: typeof REGISTRY_VERSION;
  routes: StoredRoute[];
};

export type CodexCallbackClaim =
  | { kind: "claimed"; envelope: CodexDurableCallbackEnvelope }
  | { kind: "delivered"; envelope: CodexDurableCallbackEnvelope }
  | { kind: "ambiguous"; envelope: CodexDurableCallbackEnvelope };

/**
 * Durable authority and exactly-once state for Codex-to-Jarvis callbacks.
 *
 * The capability is intentionally stored in an owner-only file because the
 * launcher must repeat it in later prompts on the same native thread. The
 * thread id is supplied by the Codex process environment, not model text, and
 * is checked in addition to the unguessable capability.
 */
export class CodexCallbackRouteRegistry {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reuse the one active route for an exact thread/session pair. A native
   * thread already bound to another Jarvis session fails closed so a later
   * caller cannot silently steal callback delivery.
   */
  async acquire(input: {
    threadId: string;
    sessionKey: string;
    agentId?: string;
  }): Promise<CodexCallbackRouteGrant> {
    return await this.mutate((document) => {
      const timestamp = this.now();
      // Completion closes a capability, so old completed routes can be
      // discarded without changing any active routing authority. Keep recent
      // receipts for exact retry, but always reserve capacity for one new route.
      pruneCompletedRoutes(document, timestamp);
      const threadId = requireStoredString(input.threadId, "threadId");
      const sessionKey = requireStoredString(input.sessionKey, "sessionKey");
      const activeForThread = document.routes.find(
        (route) =>
          route.threadId === threadId &&
          route.completedAtMs === undefined &&
          route.retiredAtMs === undefined,
      );
      if (activeForThread) {
        if (
          activeForThread.sessionKey !== sessionKey ||
          activeForThread.agentId !== input.agentId
        ) {
          throw new Error(
            `Codex callback thread ${threadId} is already bound to another Jarvis session`,
          );
        }
        return publicGrant(activeForThread);
      }

      if (document.routes.length >= MAX_ROUTES) {
        throw new Error("Codex callback route registry is full");
      }
      const route: StoredRoute = {
        routeId: randomUUID(),
        // 256 bits keeps this long-lived, narrowly scoped capability
        // unguessable without borrowing the much broader Gateway credential.
        capability: randomBytes(32).toString("base64url"),
        threadId,
        sessionKey,
        ...(input.agentId ? { agentId: requireStoredString(input.agentId, "agentId") } : {}),
        nextSequence: 1,
        callbacks: [],
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      };
      document.routes.push(route);
      return publicGrant(route);
    });
  }

  async findActiveTurn(input: { threadId: string; sessionKey: string }): Promise<
    | {
        routeId: string;
        relayId: string;
        threadId: string;
        turnId: string;
      }
    | undefined
  > {
    await this.mutationTail;
    const document = await this.readDocument();
    const route = document.routes.find(
      (entry) =>
        entry.threadId === input.threadId &&
        entry.sessionKey === input.sessionKey &&
        entry.completedAtMs === undefined &&
        entry.retiredAtMs === undefined &&
        entry.activeTurnId &&
        entry.activeRelayId,
    );
    if (!route?.activeTurnId || !route.activeRelayId) {
      return undefined;
    }
    return {
      routeId: route.routeId,
      relayId: route.activeRelayId,
      threadId: route.threadId,
      turnId: route.activeTurnId,
    };
  }

  /** Prove this exact relay turn is still active and has produced no callback. */
  async isSilentActiveTurn(input: {
    routeId: string;
    relayId: string;
    turnId: string;
  }): Promise<boolean> {
    await this.mutationTail;
    const document = await this.readDocument();
    const route = findRoute(document, input.routeId);
    return (
      route.activeRelayId === input.relayId &&
      route.activeTurnId === input.turnId &&
      !route.callbacks.some(
        (entry) => entry.delivery === "delivered" && entry.envelope.turnId === input.turnId,
      )
    );
  }

  /** Bind a Jarvis-owned live turn when one exists; cross-host later resumes remain valid without it. */
  async bindTurn(routeId: string, turn: { relayId: string; turnId: string }): Promise<void> {
    await this.mutate((document) => {
      const route = findRoute(document, routeId);
      if (route.completedAtMs !== undefined) {
        throw new Error(`Codex callback route ${route.routeId} is complete`);
      }
      route.activeRelayId = requireStoredString(turn.relayId, "relayId");
      route.activeTurnId = requireStoredString(turn.turnId, "turnId");
      route.updatedAtMs = this.now();
    });
  }

  /**
   * Clear only the exact turn that ended. A later Slingshot continuation can
   * still use the same route, but its callback will not falsely claim the old
   * turn or suppress an unrelated terminal listener.
   */
  async finishTurn(routeId: string, turnId: string): Promise<void> {
    await this.mutate((document) => {
      const route = findRoute(document, routeId);
      if (route.activeTurnId !== turnId) {
        return;
      }
      route.activeTurnId = undefined;
      route.activeRelayId = undefined;
      route.updatedAtMs = this.now();
    });
  }

  /** Close the exact interrupted route and mint a fresh recovery capability atomically. */
  async replaceInterruptedTurn(input: {
    threadId: string;
    sessionKey: string;
    agentId?: string;
    relayId: string;
    turnId: string;
  }): Promise<CodexCallbackRouteGrant> {
    return await this.mutate((document) => {
      const active = document.routes.find(
        (route) =>
          route.threadId === input.threadId &&
          route.completedAtMs === undefined &&
          route.retiredAtMs === undefined,
      );
      if (
        !active ||
        active.sessionKey !== input.sessionKey ||
        active.agentId !== input.agentId ||
        active.activeRelayId !== input.relayId ||
        active.activeTurnId !== input.turnId
      ) {
        throw new Error("Codex interrupted callback route identity does not match recovery claim");
      }
      const timestamp = this.now();
      active.retiredAtMs = timestamp;
      active.activeRelayId = undefined;
      active.activeTurnId = undefined;
      active.updatedAtMs = timestamp;
      // Reserve capacity for the replacement after retiring the old route.
      // This also prevents repeated recoveries from growing the durable file.
      pruneCompletedRoutes(document, timestamp);
      const route: StoredRoute = {
        routeId: randomUUID(),
        capability: randomBytes(32).toString("base64url"),
        threadId: active.threadId,
        sessionKey: active.sessionKey,
        ...(active.agentId ? { agentId: active.agentId } : {}),
        nextSequence: 1,
        callbacks: [],
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      };
      document.routes.push(route);
      return publicGrant(route);
    });
  }

  /**
   * Claim delivery before crossing into Jarvis. A crash after this write is
   * intentionally ambiguous and can never become a duplicate dispatch.
   */
  async claimCallback(input: {
    routeId: string;
    capability: string;
    sourceThreadId: string;
    callback: CodexDurableCallbackInput;
  }): Promise<CodexCallbackClaim> {
    return await this.mutate((document) => {
      const route = findRoute(document, input.routeId);
      verifyCapability(route.capability, input.capability);
      if (route.threadId !== input.sourceThreadId) {
        throw new Error("Codex callback source thread does not match its durable route");
      }

      const callback = normalizeCallback(input.callback);
      const fingerprint = callbackFingerprint(callback);
      const prior = route.callbacks.find((entry) => entry.callbackId === callback.callbackId);
      if (prior) {
        if (prior.sequence !== callback.sequence || prior.fingerprint !== fingerprint) {
          throw new Error("Codex callback id was reused with different content");
        }
        return {
          kind: prior.delivery === "delivered" ? "delivered" : "ambiguous",
          envelope: prior.envelope,
        };
      }
      const pending = route.callbacks.at(-1);
      if (pending?.delivery === "started") {
        // nextSequence deliberately does not advance until delivery is proven.
        // A different id at that sequence would create two claims for one
        // sequence and make the entire registry unreadable on restart.
        throw new Error(
          `Codex callback ${pending.callbackId} delivery is ambiguous; only its exact retry is allowed`,
        );
      }
      if (route.completedAtMs !== undefined || route.retiredAtMs !== undefined) {
        throw new Error(`Codex callback route ${route.routeId} already delivered completion`);
      }
      if (callback.sequence !== route.nextSequence) {
        throw new Error(
          `Codex callback sequence ${callback.sequence} is invalid; expected ${route.nextSequence}`,
        );
      }
      if (route.callbacks.length >= MAX_CALLBACKS_PER_ROUTE) {
        throw new Error(`Codex callback route ${route.routeId} reached its callback limit`);
      }

      const envelope: CodexDurableCallbackEnvelope = {
        ...callback,
        routeId: route.routeId,
        threadId: route.threadId,
        sessionKey: route.sessionKey,
        ...(route.agentId ? { agentId: route.agentId } : {}),
        ...(route.activeTurnId ? { turnId: route.activeTurnId } : {}),
        ...(route.activeRelayId ? { relayId: route.activeRelayId } : {}),
      };
      const timestamp = this.now();
      route.callbacks.push({
        callbackId: callback.callbackId,
        sequence: callback.sequence,
        fingerprint,
        delivery: "started",
        envelope,
        startedAtMs: timestamp,
      });
      route.updatedAtMs = timestamp;
      return { kind: "claimed", envelope };
    });
  }

  async markDelivered(routeId: string, callbackId: string): Promise<void> {
    await this.mutate((document) => {
      const route = findRoute(document, routeId);
      const callback = route.callbacks.find((entry) => entry.callbackId === callbackId);
      if (!callback) {
        throw new Error(`Codex callback ${callbackId} is not claimed`);
      }
      if (callback.delivery === "delivered") {
        return;
      }
      const timestamp = this.now();
      callback.delivery = "delivered";
      callback.deliveredAtMs = timestamp;
      route.nextSequence = callback.sequence + 1;
      if (callback.envelope.status === "complete") {
        route.completedAtMs = timestamp;
        route.activeTurnId = undefined;
        route.activeRelayId = undefined;
      }
      route.updatedAtMs = timestamp;
    });
  }

  private async mutate<T>(change: (document: RegistryDocument) => T): Promise<T> {
    const run = async () => {
      const document = await this.readDocument();
      const result = change(document);
      await this.writeDocument(document);
      return result;
    };
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async readDocument(): Promise<RegistryDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { version: REGISTRY_VERSION, routes: [] };
      }
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) {
      throw new Error("Codex callback route registry exceeds its size limit");
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.routes)) {
      throw new Error("Codex callback route registry has an unsupported document shape");
    }
    if (parsed.routes.length > MAX_ROUTES) {
      throw new Error("Codex callback route registry exceeds its route limit");
    }
    return {
      version: REGISTRY_VERSION,
      routes: parsed.routes.map(validateRoute),
    };
  }

  private async writeDocument(document: RegistryDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      });
      await chmod(temporaryPath, FILE_MODE);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, FILE_MODE);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function pruneCompletedRoutes(document: RegistryDocument, now: number): void {
  const active = document.routes.filter(
    (route) => route.completedAtMs === undefined && route.retiredAtMs === undefined,
  );
  const recentCompleted = document.routes
    .filter((route) => {
      const closedAt = route.completedAtMs ?? route.retiredAtMs;
      return closedAt !== undefined && now - closedAt <= COMPLETED_ROUTE_RETENTION_MS;
    })
    .sort(
      (left, right) =>
        (right.completedAtMs ?? right.retiredAtMs ?? 0) -
        (left.completedAtMs ?? left.retiredAtMs ?? 0),
    );
  const availableCompletedSlots = Math.max(0, MAX_ROUTES - active.length - 1);
  document.routes = [...active, ...recentCompleted.slice(0, availableCompletedSlots)];
}

function publicGrant(route: StoredRoute): CodexCallbackRouteGrant {
  return {
    routeId: route.routeId,
    capability: route.capability,
    threadId: route.threadId,
    sessionKey: route.sessionKey,
    ...(route.agentId ? { agentId: route.agentId } : {}),
    nextSequence: route.nextSequence,
  };
}

function normalizeCallback(input: CodexDurableCallbackInput): CodexDurableCallbackInput {
  const callbackId = requireBoundedString(input.callbackId, "callbackId", 200);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }
  if (!isCallbackStatus(input.status)) {
    throw new Error("status must be progress, blocked, decision-needed, or complete");
  }
  const message = requireBoundedString(input.message, "message", 16_000, true);
  if (isReceiptOnly(message)) {
    throw new Error("Codex callback must contain useful work content, not only a receipt");
  }
  return {
    callbackId,
    sequence: input.sequence,
    status: input.status,
    message,
    ...(input.changedFiles
      ? { changedFiles: normalizeArray(input.changedFiles, "changedFiles") }
      : {}),
    ...(input.proof ? { proof: normalizeArray(input.proof, "proof") } : {}),
    ...(input.nextAction
      ? { nextAction: requireBoundedString(input.nextAction, "nextAction", 4_000) }
      : {}),
    ...(input.workContinues === undefined ? {} : { workContinues: input.workContinues }),
  };
}

function callbackFingerprint(callback: CodexDurableCallbackInput): string {
  return JSON.stringify(callback);
}

function normalizeArray(value: string[], field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${field} must contain at most 100 strings`);
  }
  return value.map((entry, index) => requireBoundedString(entry, `${field}[${index}]`, 4_000));
}

function verifyCapability(expected: string, supplied: string): void {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    throw new Error("Codex callback capability is invalid");
  }
}

function findRoute(document: RegistryDocument, routeId: string): StoredRoute {
  const normalized = requireStoredString(routeId, "routeId");
  const route = document.routes.find((entry) => entry.routeId === normalized);
  if (!route) {
    throw new Error(`Codex callback route ${normalized} is not registered`);
  }
  return route;
}

function validateRoute(value: unknown): StoredRoute {
  if (!isRecord(value) || !Array.isArray(value.callbacks)) {
    throw new Error("Codex callback route registry contains a malformed route");
  }
  const route: StoredRoute = {
    routeId: requireStoredString(value.routeId, "routeId"),
    capability: requireStoredString(value.capability, "capability"),
    threadId: requireStoredString(value.threadId, "threadId"),
    sessionKey: requireStoredString(value.sessionKey, "sessionKey"),
    ...(typeof value.agentId === "string"
      ? { agentId: requireStoredString(value.agentId, "agentId") }
      : {}),
    nextSequence: requirePositiveInteger(value.nextSequence, "nextSequence"),
    callbacks: value.callbacks.map(validateCallback),
    createdAtMs: requireTimestamp(value.createdAtMs, "createdAtMs"),
    updatedAtMs: requireTimestamp(value.updatedAtMs, "updatedAtMs"),
    ...(typeof value.activeTurnId === "string"
      ? { activeTurnId: requireStoredString(value.activeTurnId, "activeTurnId") }
      : {}),
    ...(typeof value.activeRelayId === "string"
      ? { activeRelayId: requireStoredString(value.activeRelayId, "activeRelayId") }
      : {}),
    ...(typeof value.completedAtMs === "number"
      ? { completedAtMs: requireTimestamp(value.completedAtMs, "completedAtMs") }
      : {}),
    ...(typeof value.retiredAtMs === "number"
      ? { retiredAtMs: requireTimestamp(value.retiredAtMs, "retiredAtMs") }
      : {}),
  };
  if (route.callbacks.length > MAX_CALLBACKS_PER_ROUTE) {
    throw new Error("Codex callback route exceeds its callback limit");
  }
  validateRouteConsistency(route);
  return route;
}

function validateCallback(value: unknown): StoredCallback {
  if (!isRecord(value) || !isRecord(value.envelope)) {
    throw new Error("Codex callback route registry contains a malformed callback");
  }
  const envelope = normalizeCallback({
    callbackId: value.envelope.callbackId,
    sequence: value.envelope.sequence,
    status: value.envelope.status,
    message: value.envelope.message,
    ...(Array.isArray(value.envelope.changedFiles)
      ? { changedFiles: value.envelope.changedFiles as string[] }
      : {}),
    ...(Array.isArray(value.envelope.proof) ? { proof: value.envelope.proof as string[] } : {}),
    ...(typeof value.envelope.nextAction === "string"
      ? { nextAction: value.envelope.nextAction }
      : {}),
    ...(typeof value.envelope.workContinues === "boolean"
      ? { workContinues: value.envelope.workContinues }
      : {}),
  });
  const callbackId = requireStoredString(value.callbackId, "callbackId");
  const sequence = requirePositiveInteger(value.sequence, "sequence");
  const fingerprint = requireStoredString(value.fingerprint, "fingerprint");
  if (callbackId !== envelope.callbackId || sequence !== envelope.sequence) {
    throw new Error("Codex callback route registry entry identity is inconsistent");
  }
  if (fingerprint !== callbackFingerprint(envelope)) {
    throw new Error("Codex callback route registry entry fingerprint is inconsistent");
  }
  return {
    callbackId,
    sequence,
    fingerprint,
    delivery:
      value.delivery === "started" || value.delivery === "delivered"
        ? value.delivery
        : malformed("delivery"),
    envelope: {
      ...envelope,
      routeId: requireStoredString(value.envelope.routeId, "routeId"),
      threadId: requireStoredString(value.envelope.threadId, "threadId"),
      sessionKey: requireStoredString(value.envelope.sessionKey, "sessionKey"),
      ...(typeof value.envelope.agentId === "string" ? { agentId: value.envelope.agentId } : {}),
      ...(typeof value.envelope.turnId === "string" ? { turnId: value.envelope.turnId } : {}),
      ...(typeof value.envelope.relayId === "string" ? { relayId: value.envelope.relayId } : {}),
    },
    startedAtMs: requireTimestamp(value.startedAtMs, "startedAtMs"),
    ...(typeof value.deliveredAtMs === "number"
      ? { deliveredAtMs: requireTimestamp(value.deliveredAtMs, "deliveredAtMs") }
      : {}),
  };
}

/** Reject partial/corrupt state before it can influence a Jarvis route. */
function validateRouteConsistency(route: StoredRoute): void {
  if (Boolean(route.activeTurnId) !== Boolean(route.activeRelayId)) {
    throw new Error("Codex callback route active turn identity is incomplete");
  }
  for (const [index, callback] of route.callbacks.entries()) {
    if (callback.sequence !== index + 1) {
      throw new Error("Codex callback route sequence history is inconsistent");
    }
    if (
      callback.envelope.routeId !== route.routeId ||
      callback.envelope.threadId !== route.threadId ||
      callback.envelope.sessionKey !== route.sessionKey ||
      callback.envelope.agentId !== route.agentId
    ) {
      throw new Error("Codex callback route envelope routing is inconsistent");
    }
    if (callback.delivery === "started" && index !== route.callbacks.length - 1) {
      throw new Error("Codex callback route has delivery after an ambiguous claim");
    }
  }

  const last = route.callbacks.at(-1);
  const expectedNextSequence = !last
    ? 1
    : last.delivery === "started"
      ? last.sequence
      : last.sequence + 1;
  if (route.nextSequence !== expectedNextSequence) {
    throw new Error("Codex callback route next sequence is inconsistent");
  }
  const completedCallback = last?.delivery === "delivered" && last.envelope.status === "complete";
  if ((route.completedAtMs !== undefined) !== completedCallback) {
    throw new Error("Codex callback route completion state is inconsistent");
  }
  if (route.completedAtMs !== undefined && route.retiredAtMs !== undefined) {
    throw new Error("Codex callback route cannot be completed and retired");
  }
  if (
    (route.completedAtMs !== undefined || route.retiredAtMs !== undefined) &&
    (route.activeTurnId || route.activeRelayId)
  ) {
    throw new Error("Codex callback route is both complete and active");
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  preserveWhitespace = false,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  return preserveWhitespace ? value : value.trim();
}

function requireStoredString(value: unknown, field: string): string {
  return requireBoundedString(value, field, 16_000);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function isCallbackStatus(value: unknown): value is CodexDurableCallbackStatus {
  return (
    value === "progress" ||
    value === "blocked" ||
    value === "decision-needed" ||
    value === "complete"
  );
}

function isReceiptOnly(message: string): boolean {
  return /^(ok|ack|acknowledged|received|callback (received|delivered)|thanks)[.!\s]*$/i.test(
    message.trim(),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function malformed(field: string): never {
  throw new Error(`Codex callback route registry contains invalid ${field}`);
}
