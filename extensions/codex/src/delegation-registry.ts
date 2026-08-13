import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_REGISTRY_RECORDS = 1_000;

export const CODEX_RELAY_MAX_RECONCILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type CodexRelayLifecycle =
  | "starting"
  | "accepted"
  | "terminal"
  | "recovery-started"
  | "recovered"
  | "delivery-started"
  | "delivered"
  | "decision-needed";

export type CodexRelayTerminalStatus = "completed" | "failed" | "interrupted";
export type CodexRelayDeliveryKind = "terminal" | "callback" | "decision";
export type CodexRelayJarvisRunPurpose = "terminal" | "callback" | "decision";
export type CodexRelayRecoveryPolicy = "local-safe";

export type CodexRelayRecord = {
  delegationId: string;
  sessionKey: string;
  agentId?: string;
  threadId: string;
  turnId?: string;
  lifecycle: CodexRelayLifecycle;
  deliveryKey: string;
  createdAtMs: number;
  updatedAtMs: number;
  acceptedAtMs?: number;
  terminalAtMs?: number;
  terminalStatus?: CodexRelayTerminalStatus;
  deliveryKind?: CodexRelayDeliveryKind;
  deliveryStartedAtMs?: number;
  lastJarvisRunId?: string;
  lastJarvisRunPurpose?: CodexRelayJarvisRunPurpose;
  jarvisRunAcceptedAtMs?: number;
  heartbeatQueuedAtMs?: number;
  overdueProgressStartedAtMs?: number;
  overdueProgressDeliveredAtMs?: number;
  overdueProgressSuppressedAtMs?: number;
  deliveredAtMs?: number;
  decisionNeededAtMs?: number;
  recoveryPolicy?: CodexRelayRecoveryPolicy;
  recoveryDelegationId?: string;
  recoveryStartedAtMs?: number;
  recoveredAtMs?: number;
  recoveryOfDelegationId?: string;
};

export type CodexRelayRegistryIssue = {
  index: number;
  reason: string;
};

export type CodexRelayRegistrySnapshot = {
  records: CodexRelayRecord[];
  issues: CodexRelayRegistryIssue[];
};

type RegistryDocument = {
  version: typeof REGISTRY_VERSION;
  records: CodexRelayRecord[];
};

type CreateStartingRelay = Pick<
  CodexRelayRecord,
  "delegationId" | "sessionKey" | "agentId" | "threadId" | "deliveryKey"
> &
  Pick<CodexRelayRecord, "recoveryPolicy" | "recoveryOfDelegationId">;

/**
 * Small durable registry for Jarvis-owned native Codex relays.
 *
 * The file is intentionally extension-local and contains routing identity, not
 * task prompts or credentials. Mutations are serialized within the Gateway and
 * replaced atomically with owner-only permissions so a restart sees either the
 * complete previous document or the complete next document.
 */
export class CodexDelegationRegistry {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async createStarting(input: CreateStartingRelay): Promise<CodexRelayRecord> {
    return await this.mutate((records) => {
      if (records.some((record) => record.delegationId === input.delegationId)) {
        throw new Error(`Codex relay ${input.delegationId} already exists`);
      }
      const timestamp = this.now();
      const record: CodexRelayRecord = {
        delegationId: requireStoredString(input.delegationId, "delegationId"),
        sessionKey: requireStoredString(input.sessionKey, "sessionKey"),
        ...(input.agentId ? { agentId: requireStoredString(input.agentId, "agentId") } : {}),
        threadId: requireStoredString(input.threadId, "threadId"),
        lifecycle: "starting",
        deliveryKey: requireStoredString(input.deliveryKey, "deliveryKey"),
        ...(input.recoveryPolicy ? { recoveryPolicy: input.recoveryPolicy } : {}),
        ...(input.recoveryOfDelegationId
          ? {
              recoveryOfDelegationId: requireStoredString(
                input.recoveryOfDelegationId,
                "recoveryOfDelegationId",
              ),
            }
          : {}),
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      };
      records.push(record);
      return record;
    });
  }

  async markAccepted(delegationId: string, turnId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle !== "starting") {
        throw invalidTransition(record, "accepted");
      }
      return {
        ...record,
        turnId: requireStoredString(turnId, "turnId"),
        lifecycle: "accepted",
        acceptedAtMs: timestamp,
        updatedAtMs: timestamp,
      };
    });
  }

  /** Persist an explicit recovery grant before steering the exact accepted turn. */
  async authorizeRecovery(input: {
    delegationId: string;
    threadId: string;
    turnId: string;
    policy: CodexRelayRecoveryPolicy;
  }): Promise<CodexRelayRecord> {
    return await this.update(input.delegationId, (record, timestamp) => {
      if (
        record.lifecycle !== "accepted" ||
        record.threadId !== input.threadId ||
        record.turnId !== input.turnId
      ) {
        throw new Error(
          `Codex relay ${record.delegationId} exact accepted identity does not match recovery grant`,
        );
      }
      return {
        ...record,
        recoveryPolicy: input.policy,
        updatedAtMs: timestamp,
      };
    });
  }

  async markTerminal(
    delegationId: string,
    terminalStatus: CodexRelayTerminalStatus,
  ): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (
        record.lifecycle !== "accepted" &&
        record.lifecycle !== "terminal" &&
        record.lifecycle !== "delivery-started"
      ) {
        throw invalidTransition(record, "terminal");
      }
      if (record.terminalStatus && record.terminalStatus !== terminalStatus) {
        throw new Error(
          `Codex relay ${record.delegationId} terminal status changed from ${record.terminalStatus} to ${terminalStatus}`,
        );
      }
      return {
        ...record,
        lifecycle: record.lifecycle === "delivery-started" ? "delivery-started" : "terminal",
        terminalStatus,
        terminalAtMs: record.terminalAtMs ?? timestamp,
        updatedAtMs: timestamp,
      };
    });
  }

  /** Claim the sole restart recovery before crossing into native turn/start. */
  async claimRecovery(
    delegationId: string,
    recoveryDelegationId: string,
  ): Promise<CodexRelayRecord | undefined> {
    return await this.mutate((records) => {
      const index = findRecordIndex(records, delegationId);
      const record = records[index];
      if (record.lifecycle === "recovery-started" || record.lifecycle === "recovered") {
        return undefined;
      }
      if (
        record.lifecycle !== "terminal" ||
        record.terminalStatus !== "interrupted" ||
        record.recoveryPolicy !== "local-safe"
      ) {
        throw invalidTransition(record, "recovery-started");
      }
      const timestamp = this.now();
      const claimed: CodexRelayRecord = {
        ...record,
        lifecycle: "recovery-started",
        recoveryDelegationId: requireStoredString(recoveryDelegationId, "recoveryDelegationId"),
        recoveryStartedAtMs: timestamp,
        updatedAtMs: timestamp,
      };
      records[index] = claimed;
      return claimed;
    });
  }

  async markRecovered(delegationId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle !== "recovery-started" || !record.recoveryDelegationId) {
        throw invalidTransition(record, "recovered");
      }
      return {
        ...record,
        lifecycle: "recovered",
        recoveredAtMs: timestamp,
        updatedAtMs: timestamp,
      };
    });
  }

  /**
   * Claim the one permitted terminal-result delivery attempt.
   *
   * Persisting delivery-started before dispatch is the fail-closed boundary:
   * after a crash, reconciliation reports ambiguity instead of replaying a
   * possibly delivered result.
   */
  async claimTerminalDelivery(delegationId: string): Promise<CodexRelayRecord | undefined> {
    return await this.mutate((records) => {
      const index = findRecordIndex(records, delegationId);
      const record = records[index];
      if (record.lifecycle === "delivery-started" || record.lifecycle === "delivered") {
        return undefined;
      }
      if (record.lifecycle !== "terminal" || record.terminalStatus !== "completed") {
        throw invalidTransition(record, "delivery-started");
      }
      const timestamp = this.now();
      const claimed: CodexRelayRecord = {
        ...record,
        lifecycle: "delivery-started",
        deliveryKind: "terminal",
        deliveryStartedAtMs: timestamp,
        // A prior progress callback or heartbeat attempt is unrelated to this
        // newly claimed terminal handback. Clear its evidence so a later crash
        // report describes the exact delivery attempt that became ambiguous.
        lastJarvisRunId: undefined,
        lastJarvisRunPurpose: undefined,
        jarvisRunAcceptedAtMs: undefined,
        heartbeatQueuedAtMs: undefined,
        updatedAtMs: timestamp,
      };
      records[index] = claimed;
      return claimed;
    });
  }

  async claimCallbackDelivery(delegationId: string): Promise<CodexRelayRecord | undefined> {
    return await this.mutate((records) => {
      const index = findRecordIndex(records, delegationId);
      const record = records[index];
      if (record.lifecycle === "delivery-started" || record.lifecycle === "delivered") {
        return undefined;
      }
      if (record.lifecycle !== "accepted") {
        throw invalidTransition(record, "delivery-started");
      }
      const timestamp = this.now();
      const claimed: CodexRelayRecord = {
        ...record,
        lifecycle: "delivery-started",
        deliveryKind: "callback",
        deliveryStartedAtMs: timestamp,
        lastJarvisRunId: undefined,
        lastJarvisRunPurpose: undefined,
        jarvisRunAcceptedAtMs: undefined,
        heartbeatQueuedAtMs: undefined,
        updatedAtMs: timestamp,
      };
      records[index] = claimed;
      return claimed;
    });
  }

  /**
   * Irreversibly classify this relay as decision-only and claim its sole
   * decision handback attempt before invoking Jarvis.
   *
   * A crash after this atomic write is ambiguous by design. Startup must not
   * inspect Codex again or resend the report because either could duplicate a
   * handback whose first dispatch crossed the process boundary.
   */
  async claimDecisionDelivery(delegationId: string): Promise<CodexRelayRecord | undefined> {
    return await this.mutate((records) => {
      const index = findRecordIndex(records, delegationId);
      const record = records[index];
      if (
        record.lifecycle === "delivered" ||
        record.lifecycle === "decision-needed" ||
        (record.lifecycle === "delivery-started" && record.deliveryKind === "decision")
      ) {
        return undefined;
      }
      const timestamp = this.now();
      const claimed: CodexRelayRecord = {
        ...record,
        lifecycle: "delivery-started",
        deliveryKind: "decision",
        deliveryStartedAtMs: timestamp,
        // Prior run/heartbeat fields remain diagnostic only. deliveryKind is
        // the durable authority: once it is decision, no evidence field can
        // make this relay eligible for native inspection or result delivery.
        updatedAtMs: timestamp,
      };
      records[index] = claimed;
      return claimed;
    });
  }

  async markDelivered(delegationId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle !== "delivery-started" || record.deliveryKind === "decision") {
        throw invalidTransition(record, "delivered");
      }
      return {
        ...record,
        lifecycle: "delivered",
        deliveredAtMs: timestamp,
        updatedAtMs: timestamp,
      };
    });
  }

  async markJarvisRunAccepted(
    delegationId: string,
    runId: string,
    purpose: CodexRelayJarvisRunPurpose,
  ): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle === "delivered" || record.lifecycle === "decision-needed") {
        throw new Error(
          `Codex relay ${record.delegationId} cannot record a Jarvis run after ${record.lifecycle}`,
        );
      }
      return {
        ...record,
        lastJarvisRunId: requireStoredString(runId, "runId"),
        lastJarvisRunPurpose: purpose,
        jarvisRunAcceptedAtMs: timestamp,
        // Direct run acceptance supersedes any earlier volatile heartbeat
        // attempt for this record, while still leaving lifecycle non-final.
        heartbeatQueuedAtMs: undefined,
        // Diagnostic evidence must not refresh the lifecycle clock. Otherwise
        // an old relay can appear fresh and become eligible for native
        // inspection after its decision handback fails.
        updatedAtMs: record.updatedAtMs,
      };
    });
  }

  async markHeartbeatQueued(delegationId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle === "delivered" || record.lifecycle === "decision-needed") {
        throw new Error(
          `Codex relay ${record.delegationId} cannot queue heartbeat after ${record.lifecycle}`,
        );
      }
      return {
        ...record,
        heartbeatQueuedAtMs: timestamp,
        // Queueing is diagnostic only and is not a lifecycle transition.
        updatedAtMs: record.updatedAtMs,
      };
    });
  }

  /**
   * Claim the one launcher-owned overdue progress handback.
   *
   * This does not change relay lifecycle or terminal authority. Persisting the
   * claim only makes the informational update at-most-once across timer races
   * and process restarts; completion remains independently deliverable.
   */
  async claimOverdueProgress(delegationId: string): Promise<CodexRelayRecord | undefined> {
    return await this.mutate((records) => {
      const index = findRecordIndex(records, delegationId);
      const record = records[index];
      if (
        record.lifecycle !== "accepted" ||
        record.overdueProgressStartedAtMs !== undefined ||
        record.overdueProgressSuppressedAtMs !== undefined
      ) {
        return undefined;
      }
      const timestamp = this.now();
      const claimed = {
        ...record,
        overdueProgressStartedAtMs: timestamp,
        // An informational claim must not refresh reconciliation age. The
        // acceptance clock remains the authority for stale-relay decisions.
        updatedAtMs: record.updatedAtMs,
      };
      records[index] = claimed;
      return claimed;
    });
  }

  /**
   * Suppress the informational timer without consuming terminal authority.
   *
   * Failure cleanup uses this before clearing callback-route activity. If that
   * later local write fails, startup reconciliation still sees an accepted
   * relay and retains its normal exact-turn decision path.
   */
  async suppressOverdueProgress(delegationId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle !== "accepted") {
        return record;
      }
      return {
        ...record,
        overdueProgressSuppressedAtMs: record.overdueProgressSuppressedAtMs ?? timestamp,
        updatedAtMs: record.updatedAtMs,
      };
    });
  }

  async markOverdueProgressDelivered(delegationId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.overdueProgressStartedAtMs === undefined) {
        throw new Error(`Codex relay ${record.delegationId} has no overdue progress claim`);
      }
      if (record.overdueProgressDeliveredAtMs !== undefined) {
        return record;
      }
      return {
        ...record,
        overdueProgressDeliveredAtMs: timestamp,
        updatedAtMs: record.updatedAtMs,
      };
    });
  }

  async markDecisionNeeded(delegationId: string): Promise<CodexRelayRecord> {
    return await this.update(delegationId, (record, timestamp) => {
      if (record.lifecycle !== "delivery-started" || record.deliveryKind !== "decision") {
        throw invalidTransition(record, "decision-needed");
      }
      return {
        ...record,
        lifecycle: "decision-needed",
        decisionNeededAtMs: timestamp,
        updatedAtMs: timestamp,
      };
    });
  }

  async snapshot(): Promise<CodexRelayRegistrySnapshot> {
    return await this.readSnapshot();
  }

  async get(delegationId: string): Promise<CodexRelayRecord | undefined> {
    const snapshot = await this.readSnapshot();
    return snapshot.records.find((record) => record.delegationId === delegationId);
  }

  private async update(
    delegationId: string,
    change: (record: CodexRelayRecord, timestamp: number) => CodexRelayRecord,
  ): Promise<CodexRelayRecord> {
    return await this.mutate((records) => {
      const index = findRecordIndex(records, delegationId);
      const updated = change(records[index], this.now());
      records[index] = updated;
      return updated;
    });
  }

  private async mutate<T>(change: (records: CodexRelayRecord[]) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = await this.readSnapshot();
      // Never rewrite a partially understood registry: doing so could silently
      // discard the only durable reference to accepted side-effecting work.
      if (snapshot.issues.length > 0) {
        throw new Error(
          `Codex relay registry has ${snapshot.issues.length} malformed entr${
            snapshot.issues.length === 1 ? "y" : "ies"
          }; refusing to overwrite it`,
        );
      }
      const records = snapshot.records.map((record) => ({ ...record }));
      const result = change(records);
      if (records.length > MAX_REGISTRY_RECORDS) {
        throw new Error(`Codex relay registry exceeds ${MAX_REGISTRY_RECORDS} records`);
      }
      await this.writeDocument({ version: REGISTRY_VERSION, records });
      return result;
    };

    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async readSnapshot(): Promise<CodexRelayRegistrySnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { records: [], issues: [] };
      }
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) {
      throw new Error(`Codex relay registry exceeds ${MAX_REGISTRY_BYTES} bytes`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Codex relay registry is not valid JSON");
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== REGISTRY_VERSION ||
      !Array.isArray(parsed.records)
    ) {
      throw new Error(`Codex relay registry has an unsupported document shape`);
    }
    if (parsed.records.length > MAX_REGISTRY_RECORDS) {
      throw new Error(`Codex relay registry exceeds ${MAX_REGISTRY_RECORDS} records`);
    }

    const records: CodexRelayRecord[] = [];
    const issues: CodexRelayRegistryIssue[] = [];
    const delegationIds = new Set<string>();
    for (const [index, value] of parsed.records.entries()) {
      const validated = validateRecord(value);
      if (typeof validated === "string") {
        issues.push({ index, reason: validated });
        continue;
      }
      if (delegationIds.has(validated.delegationId)) {
        issues.push({ index, reason: "duplicate delegationId" });
        continue;
      }
      delegationIds.add(validated.delegationId);
      records.push(validated);
    }
    return { records, issues };
  }

  private async writeDocument(document: RegistryDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, payload, {
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

function validateRecord(value: unknown): CodexRelayRecord | string {
  if (!isRecord(value)) {
    return "entry is not an object";
  }
  const requiredStrings = [
    "delegationId",
    "sessionKey",
    "threadId",
    "deliveryKey",
    "lifecycle",
  ] as const;
  for (const field of requiredStrings) {
    if (!isStoredString(value[field])) {
      return `${field} is missing or invalid`;
    }
  }
  if (!isLifecycle(value.lifecycle)) {
    return "lifecycle is invalid";
  }
  if (value.agentId !== undefined && !isStoredString(value.agentId)) {
    return "agentId is invalid";
  }
  if (value.turnId !== undefined && !isStoredString(value.turnId)) {
    return "turnId is invalid";
  }
  if (value.recoveryPolicy !== undefined && value.recoveryPolicy !== "local-safe") {
    return "recoveryPolicy is invalid";
  }
  for (const field of ["recoveryDelegationId", "recoveryOfDelegationId"] as const) {
    if (value[field] !== undefined && !isStoredString(value[field])) {
      return `${field} is invalid`;
    }
  }
  const requiredTimestamps = ["createdAtMs", "updatedAtMs"] as const;
  for (const field of requiredTimestamps) {
    if (!isTimestamp(value[field])) {
      return `${field} is missing or invalid`;
    }
  }
  const optionalTimestamps = [
    "acceptedAtMs",
    "terminalAtMs",
    "deliveryStartedAtMs",
    "jarvisRunAcceptedAtMs",
    "heartbeatQueuedAtMs",
    "overdueProgressStartedAtMs",
    "overdueProgressDeliveredAtMs",
    "overdueProgressSuppressedAtMs",
    "deliveredAtMs",
    "decisionNeededAtMs",
    "recoveryStartedAtMs",
    "recoveredAtMs",
  ] as const;
  for (const field of optionalTimestamps) {
    if (value[field] !== undefined && !isTimestamp(value[field])) {
      return `${field} is invalid`;
    }
  }
  if (value.terminalStatus !== undefined && !isTerminalStatus(value.terminalStatus)) {
    return "terminalStatus is invalid";
  }
  if (value.deliveryKind !== undefined && !isDeliveryKind(value.deliveryKind)) {
    return "deliveryKind is invalid";
  }
  if (value.lastJarvisRunId !== undefined && !isStoredString(value.lastJarvisRunId)) {
    return "lastJarvisRunId is invalid";
  }
  if (value.lastJarvisRunPurpose !== undefined && !isJarvisRunPurpose(value.lastJarvisRunPurpose)) {
    return "lastJarvisRunPurpose is invalid";
  }
  if ((value.lastJarvisRunId === undefined) !== (value.lastJarvisRunPurpose === undefined)) {
    return "Jarvis run identity is incomplete";
  }
  if (
    value.overdueProgressDeliveredAtMs !== undefined &&
    value.overdueProgressStartedAtMs === undefined
  ) {
    return "overdue progress delivery is missing its claim";
  }
  if (
    (["accepted", "terminal", "recovery-started", "recovered", "delivered"].includes(
      value.lifecycle,
    ) ||
      (value.lifecycle === "delivery-started" && value.deliveryKind !== "decision")) &&
    !isStoredString(value.turnId)
  ) {
    return "accepted lifecycle is missing turnId";
  }
  if (value.lifecycle === "terminal" && !isTerminalStatus(value.terminalStatus)) {
    return "terminal lifecycle is missing terminalStatus";
  }
  if (
    (value.lifecycle === "recovery-started" || value.lifecycle === "recovered") &&
    (!isStoredString(value.recoveryDelegationId) || value.terminalStatus !== "interrupted")
  ) {
    return "recovery lifecycle is missing interrupted recovery identity";
  }
  if (
    ["delivery-started", "delivered"].includes(value.lifecycle) &&
    !isDeliveryKind(value.deliveryKind)
  ) {
    return "delivered lifecycle is missing deliveryKind";
  }
  if (value.lifecycle === "decision-needed" && value.deliveryKind !== "decision") {
    return "decision-needed lifecycle is missing decision delivery classification";
  }
  if (value.lifecycle === "delivered" && value.deliveryKind === "decision") {
    return "decision delivery cannot use delivered lifecycle";
  }
  if (
    ["delivery-started", "delivered"].includes(value.lifecycle) &&
    value.deliveryKind === "terminal" &&
    !isTerminalStatus(value.terminalStatus)
  ) {
    return "terminal delivery is missing terminalStatus";
  }
  return value as CodexRelayRecord;
}

function findRecordIndex(records: CodexRelayRecord[], delegationId: string): number {
  const normalized = requireStoredString(delegationId, "delegationId");
  const index = records.findIndex((record) => record.delegationId === normalized);
  if (index < 0) {
    throw new Error(`Codex relay ${normalized} is not registered`);
  }
  return index;
}

function invalidTransition(record: CodexRelayRecord, target: CodexRelayLifecycle): Error {
  return new Error(
    `Codex relay ${record.delegationId} cannot transition from ${record.lifecycle} to ${target}`,
  );
}

function requireStoredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!isStoredString(normalized)) {
    throw new Error(`${field} is required and must be at most 4096 characters`);
  }
  return normalized;
}

function isStoredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLifecycle(value: unknown): value is CodexRelayLifecycle {
  return (
    value === "starting" ||
    value === "accepted" ||
    value === "terminal" ||
    value === "recovery-started" ||
    value === "recovered" ||
    value === "delivery-started" ||
    value === "delivered" ||
    value === "decision-needed"
  );
}

function isTerminalStatus(value: unknown): value is CodexRelayTerminalStatus {
  return value === "completed" || value === "failed" || value === "interrupted";
}

function isDeliveryKind(value: unknown): value is CodexRelayDeliveryKind {
  return value === "terminal" || value === "callback" || value === "decision";
}

function isJarvisRunPurpose(value: unknown): value is CodexRelayJarvisRunPurpose {
  return value === "terminal" || value === "callback" || value === "decision";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
