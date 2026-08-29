import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { isRestartEnabled } from "../../config/commands.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfigSnapshotHash } from "../../config/io.js";
import {
  consumePendingRestartConfirmationForSession,
  extractDeliveryInfo,
  recordPendingRestartConfirmationForSession,
  RESTART_CONFIRMATION_RECOMMENDED_PROMPT,
  resolveAgentIdFromSessionKey,
} from "../../config/sessions.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { requestGatewayToolRestart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { listNodes } from "./nodes-utils.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_APP_UPDATE_CHECK_TIMEOUT_MS = 45_000;

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: typeof hashValue === "string" ? hashValue : undefined,
    raw: typeof rawValue === "string" ? rawValue : undefined,
  });
  return hash ?? undefined;
}

const GATEWAY_ACTIONS = [
  "restart",
  "restart.request_confirmation",
  "config.get",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "update.run",
  "app.update.check",
  "app.update.status",
  "app.update.install",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema.lookup, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
  // app.update.check, app.update.status, app.update.install
  node: Type.Optional(Type.String()),
  expectedVersion: Type.Optional(Type.String()),
  expectedBuild: Type.Optional(Type.String()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: true,
    description:
      "Restart, arm restart confirmation for the current chat, inspect or change gateway config, update gateway source, or check/inspect/install a signed Sparkle app update. A plain action=restart is a routine service-lifecycle step and does not require a separate confirmation turn when it is explicitly requested or necessary to complete the current authorized task. It never broadens the task's authority. Before asking the user to confirm any other restart-capable action in live chat, first call restart.request_confirmation. Only after that action succeeds, ask the confirmation question returned by the tool, end the turn, and wait for the user's reply. app.update.check asks Sparkle to refresh in the background without installing. app.update.status is read-only. app.update.install requires the exact version/build returned by status and a later-turn confirmation. Use config.schema.lookup with a targeted dot path before config edits. Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Always pass a human-readable completion message via the note parameter so the system can deliver it after restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const liveChatSessionKey = opts?.agentSessionKey?.trim() || undefined;
      const liveChatAgentId = resolveAgentIdFromSessionKey(liveChatSessionKey);
      const storePath = resolveStorePath(opts?.config?.session?.store, {
        agentId: liveChatAgentId,
      });
      const resolveCurrentSessionKey = (): string | undefined =>
        liveChatSessionKey ||
        (typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : undefined);
      const requirePendingRestartConfirmation = async () => {
        if (!liveChatSessionKey) {
          return;
        }
        const consumed = await consumePendingRestartConfirmationForSession({
          storePath,
          sessionKey: liveChatSessionKey,
        });
        if (consumed.status === "ready") {
          return;
        }
        if (consumed.status === "awaiting-next-user-turn") {
          throw new Error(
            "Restart confirmation is armed for this chat, but you cannot consume it in the same turn. Ask the user, wait for the next reply, and only proceed if that reply clearly confirms the restart-capable action.",
          );
        }
        if (consumed.status === "expired") {
          throw new Error(
            `The pending restart confirmation expired. First call the gateway tool with action="restart.request_confirmation". Only after that action succeeds, ask exactly: "${RESTART_CONFIRMATION_RECOMMENDED_PROMPT}" Then end the turn and wait for the user's reply.`,
          );
        }
        throw new Error(
          `Restart confirmation required for live chat sessions. First call the gateway tool with action="restart.request_confirmation" for this session. Only after that action succeeds, ask exactly: "${RESTART_CONFIRMATION_RECOMMENDED_PROMPT}" Then end the turn and wait for the user's reply before attempting restart-capable actions.`,
        );
      };
      if (action === "restart.request_confirmation") {
        if (!liveChatSessionKey) {
          throw new Error(
            "restart.request_confirmation is only available from a live chat session with a current session key.",
          );
        }
        const entry = await recordPendingRestartConfirmationForSession({
          storePath,
          sessionKey: liveChatSessionKey,
        });
        if (!entry) {
          throw new Error(
            "Could not arm restart confirmation because the current session entry was not found.",
          );
        }
        return jsonResult({
          ok: true,
          sessionKey: liveChatSessionKey,
          prompt: RESTART_CONFIRMATION_RECOMMENDED_PROMPT,
          expiresAt: entry.pendingRestartConfirmation?.expiresAt ?? null,
        });
      }
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        // Restarting the service is a routine execution detail inside the caller's
        // existing task authority. The confirmation gate remains on mutations that
        // also change config, source, or the installed application.
        const sessionKey = resolveCurrentSessionKey();
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim().slice(0, 200)
            : undefined;
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        // Extract channel + threadId for routing after restart
        // Supports both :thread: (most channels) and :topic: (Telegram)
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "requested",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
            phase: "requested",
            verified: false,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = await requestGatewayToolRestart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

      const resolveAppUpdateNode = async (
        requiredCommands = ["system.appUpdate.status", "system.appUpdate.install"],
      ) => {
        const requestedNode =
          typeof params.node === "string" && params.node.trim() ? params.node.trim() : undefined;
        const nodes = await listNodes(gatewayOpts);
        const capable = nodes.filter(
          (node) =>
            node.connected === true &&
            requiredCommands.every((command) => node.commands?.includes(command) === true),
        );
        if (requestedNode) {
          const normalized = requestedNode.toLowerCase();
          const match = capable.find(
            (node) =>
              node.nodeId.toLowerCase() === normalized ||
              node.displayName?.toLowerCase() === normalized,
          );
          if (!match) {
            throw new Error(
              `The requested node is not connected with app-update support: ${requestedNode}`,
            );
          }
          return match;
        }
        if (capable.length === 0) {
          throw new Error("No connected Jarvis Mac app supports signed app updates.");
        }
        if (capable.length > 1) {
          throw new Error(
            "Multiple Jarvis Mac apps support updates. Pass the exact node id or display name.",
          );
        }
        return capable[0];
      };

      const invokeAppUpdateNode = async (
        nodeId: string,
        command: "system.appUpdate.check" | "system.appUpdate.status" | "system.appUpdate.install",
        commandParams: Record<string, unknown> = {},
        commandGatewayOpts = gatewayOpts,
      ) => {
        const result = await callGatewayTool<{ payload?: unknown }>(
          "node.invoke",
          commandGatewayOpts,
          {
            nodeId,
            command,
            params: commandParams,
            idempotencyKey: randomUUID(),
          },
        );
        return result?.payload ?? {};
      };

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey = resolveCurrentSessionKey();
        const note =
          typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", {
          required: true,
          label: "path",
        });
        const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        await requirePendingRestartConfirmation();
        const { raw, baseHash, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.patch") {
        await requirePendingRestartConfirmation();
        const { raw, baseHash, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        await requirePendingRestartConfirmation();
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "app.update.status") {
        const node = await resolveAppUpdateNode();
        const result = await invokeAppUpdateNode(node.nodeId, "system.appUpdate.status");
        return jsonResult({ ok: true, nodeId: node.nodeId, result });
      }
      if (action === "app.update.check") {
        const node = await resolveAppUpdateNode([
          "system.appUpdate.check",
          "system.appUpdate.status",
          "system.appUpdate.install",
        ]);
        const result = await invokeAppUpdateNode(
          node.nodeId,
          "system.appUpdate.check",
          {},
          {
            ...gatewayOpts,
            timeoutMs: Math.max(gatewayOpts.timeoutMs ?? 0, DEFAULT_APP_UPDATE_CHECK_TIMEOUT_MS),
          },
        );
        return jsonResult({ ok: true, nodeId: node.nodeId, result });
      }
      if (action === "app.update.install") {
        const expectedVersion = readStringParam(params, "expectedVersion", { required: true });
        const expectedBuild = readStringParam(params, "expectedBuild", { required: true });
        const node = await resolveAppUpdateNode();

        // Re-read the app-owned Sparkle state before consuming consent. This
        // prevents a stale prompt from authorizing a newly published build.
        const status = (await invokeAppUpdateNode(
          node.nodeId,
          "system.appUpdate.status",
        )) as Record<string, unknown>;
        if (
          status.readyToInstall !== true ||
          status.version !== expectedVersion ||
          status.build !== expectedBuild
        ) {
          throw new Error(
            "The approved app update is no longer ready or has changed. Check status and ask again.",
          );
        }
        if (typeof status.gatewayRestartRequired !== "boolean") {
          throw new Error(
            "The Jarvis Mac app did not report its gateway restart mode. Update status and try again.",
          );
        }
        await requirePendingRestartConfirmation();

        const { sessionKey, note } = resolveGatewayWriteMeta();
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload | undefined = status.gatewayRestartRequired
          ? {
              kind: "update",
              // "ok" means the restart-capable update operation was accepted.
              // The sentinel watcher still verifies the replacement process
              // after Sparkle relaunches the app and its managed gateway.
              status: "ok",
              ts: Date.now(),
              sessionKey,
              deliveryContext,
              threadId,
              message:
                note ??
                `Jarvis updated to ${expectedVersion} (${expectedBuild}) and resumed this chat.`,
              doctorHint: formatDoctorNonInteractiveHint(),
              stats: {
                mode: "app.update.install",
                phase: "requested",
                verified: false,
                after: {
                  version: expectedVersion,
                  build: expectedBuild,
                },
              },
            }
          : undefined;
        if (payload) {
          await writeRestartSentinel(payload);
        }
        let result: unknown;
        try {
          result = await invokeAppUpdateNode(node.nodeId, "system.appUpdate.install", {
            expectedVersion,
            expectedBuild,
          });
        } catch (error) {
          if (payload) {
            // Replace the active operation so the detached watcher cannot
            // report a false recovery when the app rejected the install.
            await writeRestartSentinel({
              ...payload,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
        return jsonResult({
          ok: true,
          accepted: true,
          gatewayRestartRequired: status.gatewayRestartRequired,
          nodeId: node.nodeId,
          version: expectedVersion,
          build: expectedBuild,
          result,
        });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
