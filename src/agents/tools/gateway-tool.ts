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
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;

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
      "Restart, arm restart confirmation for the current chat, inspect a specific config schema path, apply config, or update the gateway in-place (SIGUSR1). Use restart.request_confirmation before restart-capable actions in live chat. Use config.schema.lookup with a targeted dot path before config edits. Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Both trigger restart after writing. Always pass a human-readable completion message via the `note` parameter so the system can deliver it to the user after restart.",
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
            `The pending restart confirmation expired. Ask again: "${RESTART_CONFIRMATION_RECOMMENDED_PROMPT}" and record it with action="restart.request_confirmation".`,
          );
        }
        throw new Error(
          `Restart confirmation required for live chat sessions. Ask: "${RESTART_CONFIRMATION_RECOMMENDED_PROMPT}" then call gateway with action="restart.request_confirmation" for this session before attempting restart-capable actions.`,
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
        await requirePendingRestartConfirmation();
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
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
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
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

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

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
