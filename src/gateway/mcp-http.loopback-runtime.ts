import type { OpenClawConfig } from "../config/types.openclaw.js";

export type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

let activeRuntime: McpLoopbackRuntime | undefined;
let nextConfigOverrideId = 1;

type McpLoopbackConfigOverride = {
  id: number;
  token: string;
  sessionKey: string;
  config: OpenClawConfig;
};

const configOverrides: McpLoopbackConfigOverride[] = [];

function normalizeConfigOverrideSessionKey(sessionKey: string | undefined): string {
  const trimmed = sessionKey?.trim();
  return !trimmed || trimmed === "main" ? "main" : trimmed;
}

export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
}

export function resolveMcpLoopbackBearerToken(
  runtime: McpLoopbackRuntime,
  senderIsOwner: boolean,
): string {
  return senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
}

export function registerMcpLoopbackConfigOverride(params: {
  ownerToken: string;
  nonOwnerToken: string;
  sessionKey: string | undefined;
  config: OpenClawConfig;
}): () => void {
  const id = nextConfigOverrideId++;
  const sessionKey = normalizeConfigOverrideSessionKey(params.sessionKey);
  configOverrides.push(
    { id, token: params.ownerToken, sessionKey, config: params.config },
    { id, token: params.nonOwnerToken, sessionKey, config: params.config },
  );
  return () => {
    for (let index = configOverrides.length - 1; index >= 0; index -= 1) {
      if (configOverrides[index]?.id === id) {
        configOverrides.splice(index, 1);
      }
    }
  };
}

export function resolveMcpLoopbackConfigOverride(params: {
  ownerToken: string;
  nonOwnerToken: string;
  senderIsOwner: boolean;
  rawSessionKey: string | undefined;
}): OpenClawConfig | undefined {
  const token = params.senderIsOwner ? params.ownerToken : params.nonOwnerToken;
  const sessionKey = normalizeConfigOverrideSessionKey(params.rawSessionKey);
  for (let index = configOverrides.length - 1; index >= 0; index -= 1) {
    const entry = configOverrides[index];
    if (entry?.token === token && entry.sessionKey === sessionKey) {
      return entry.config;
    }
  }
  return undefined;
}

export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  const nonOwnerToken =
    activeRuntime?.ownerToken === ownerToken ? activeRuntime.nonOwnerToken : undefined;
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
  }
  for (let index = configOverrides.length - 1; index >= 0; index -= 1) {
    const entry = configOverrides[index];
    if (entry?.token === ownerToken || entry?.token === nonOwnerToken) {
      configOverrides.splice(index, 1);
    }
  }
}

export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
}
