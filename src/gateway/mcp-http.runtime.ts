import { applyOwnerOnlyToolPolicy } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import {
  buildMcpToolSchema,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

function shouldLogMcpLoopbackRuntime(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT) ||
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG)
  );
}

function logMcpLoopbackRuntime(step: string, details: Record<string, unknown>): void {
  if (!shouldLogMcpLoopbackRuntime()) {
    return;
  }
  console.error(`[mcp-loopback] ${step} ${JSON.stringify(details)}`);
}

type CachedScopedTools = {
  agentId: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  configRef: OpenClawConfig;
  time: number;
};

export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();

  resolve(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
    senderIsOwner: boolean | undefined;
  }): CachedScopedTools {
    const cacheKey = [
      params.sessionKey,
      params.messageProvider ?? "",
      params.accountId ?? "",
      params.senderIsOwner === true ? "owner" : "non-owner",
    ].join("\u0000");
    const now = Date.now();
    const cached = this.#entries.get(cacheKey);
    if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
      logMcpLoopbackRuntime("tool-cache-hit", {
        sessionKey: params.sessionKey,
        toolCount: cached.toolSchema.length,
      });
      return cached;
    }

    logMcpLoopbackRuntime("resolve-gateway-tools-start", {
      sessionKey: params.sessionKey,
      senderIsOwner: params.senderIsOwner,
    });
    const next = resolveGatewayScopedTools({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      accountId: params.accountId,
      senderIsOwner: params.senderIsOwner,
      surface: "loopback",
      excludeToolNames: NATIVE_TOOL_EXCLUDE,
    });
    logMcpLoopbackRuntime("resolve-gateway-tools-end", {
      sessionKey: params.sessionKey,
      toolCount: next.tools.length,
      agentId: next.agentId,
    });
    const tools = applyOwnerOnlyToolPolicy(next.tools, params.senderIsOwner === true);
    logMcpLoopbackRuntime("build-tool-schema-start", {
      sessionKey: params.sessionKey,
      toolCount: tools.length,
    });
    const nextEntry: CachedScopedTools = {
      agentId: next.agentId,
      tools,
      toolSchema: buildMcpToolSchema(tools),
      configRef: params.cfg,
      time: now,
    };
    logMcpLoopbackRuntime("build-tool-schema-end", {
      sessionKey: params.sessionKey,
      toolCount: nextEntry.toolSchema.length,
    });
    this.#entries.set(cacheKey, nextEntry);
    for (const [key, entry] of this.#entries) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        this.#entries.delete(key);
      }
    }
    return nextEntry;
  }
}

export {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
};
