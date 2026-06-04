import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isRecord } from "../../utils.js";
import {
  OPENCLAW_NATIVE_MCP_AGENT_ID_ENV,
  OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV,
  OPENCLAW_NATIVE_MCP_CONFIG_ENV,
  OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV,
  OPENCLAW_NATIVE_MCP_WORKSPACE_ENV,
} from "./native-mcp.js";

type NativeToolDefinition = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    input: unknown,
    context?: unknown,
    signal?: unknown,
    options?: unknown,
  ) => unknown;
};

const STATIC_TOOL_DEFINITIONS = [
  {
    name: "exec",
    title: "exec",
    description: "Run a shell command in the OpenClaw workspace.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run.",
        },
      },
      required: ["command"],
      additionalProperties: true,
    },
  },
  {
    name: "process",
    title: "process",
    description: "Inspect or manage OpenClaw background processes.",
    inputSchema: defaultInputSchema(),
  },
  {
    name: "browser",
    title: "browser",
    description: "Use the OpenClaw browser tool.",
    inputSchema: defaultInputSchema(),
  },
] as const;

async function withSuppressedStdout<T>(task: () => Promise<T>): Promise<T> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await task();
  } finally {
    process.stdout.write = originalWrite;
  }
}

function readEnvString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function readInjectedConfig(): Promise<OpenClawConfig | undefined> {
  const configPath = readEnvString(OPENCLAW_NATIVE_MCP_CONFIG_ENV);
  if (!configPath) {
    return undefined;
  }
  return JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
}

function defaultInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

async function buildToolDefinitions(params: {
  workspaceDir: string;
  sessionKey?: string;
  explicitAgentId?: string;
  browserBaseUrl?: string;
  toolName?: string;
}): Promise<NativeToolDefinition[]> {
  const injectedConfig = await readInjectedConfig();
  const [
    { resolveMergedSafeBinProfileFixtures },
    { resolvePermissionDefaults },
    { resolveAgentConfig, resolveSessionAgentIds },
    { toToolDefinitions },
  ] = await Promise.all([
    import("../../infra/exec-safe-bin-runtime-policy.js"),
    import("../../infra/permissions-mode.js"),
    import("../agent-scope.js"),
    import("../pi-tool-definition-adapter.js"),
  ]);

  const config =
    injectedConfig ??
    (await withSuppressedStdout(async () => {
      const { loadConfig } = await import("../../config/config.js");
      return loadConfig();
    }));
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config,
    agentId: params.explicitAgentId,
  });

  const globalExec = config.tools?.exec;
  const agentExec = sessionAgentId
    ? resolveAgentConfig(config, sessionAgentId)?.tools?.exec
    : undefined;
  const permissionDefaults = resolvePermissionDefaults({
    config,
    agentId: sessionAgentId,
  });
  const scopeKey = params.sessionKey ?? (sessionAgentId ? `agent:${sessionAgentId}` : undefined);

  const tools: unknown[] = [];
  if (!params.toolName || params.toolName === "exec" || params.toolName === "process") {
    const { createExecTool, createProcessTool } = await import("../bash-tools.js");
    if (!params.toolName || params.toolName === "exec") {
      tools.push(
        createExecTool({
          agentId: sessionAgentId,
          cwd: params.workspaceDir,
          host: agentExec?.host ?? globalExec?.host,
          security: agentExec?.security ?? globalExec?.security ?? permissionDefaults.execSecurity,
          ask: agentExec?.ask ?? globalExec?.ask ?? permissionDefaults.execAsk,
          node: agentExec?.node ?? globalExec?.node,
          pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
          safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
          safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
          safeBinProfiles: resolveMergedSafeBinProfileFixtures({
            global: globalExec,
            local: agentExec,
          }),
          backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
          timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
          approvalRunningNoticeMs:
            agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
          notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
          notifyOnExitEmptySuccess:
            agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
          sessionKey: params.sessionKey,
          scopeKey,
        }) as never,
      );
    }
    if (!params.toolName || params.toolName === "process") {
      tools.push(
        createProcessTool({
          cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
          scopeKey,
        }) as never,
      );
    }
  }
  if (!params.toolName || params.toolName === "browser") {
    const { createBrowserTool } = await import("../tools/browser-tool.js");
    tools.push(
      createBrowserTool(
        params.browserBaseUrl
          ? {
              agentSessionKey: params.sessionKey,
              sandboxBridgeUrl: params.browserBaseUrl,
              allowHostControl: false,
            }
          : {
              agentSessionKey: params.sessionKey,
            },
      ) as never,
    );
  }

  return toToolDefinitions(tools as never[]) as NativeToolDefinition[];
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function sanitizeMcpContentBlock(block: unknown): Record<string, unknown> {
  if (!isRecord(block)) {
    return { type: "text", text: stringifyUnknown(block) };
  }
  const type = typeof block.type === "string" ? block.type : "";
  if (type === "text" && typeof block.text === "string") {
    return { type, text: block.text };
  }
  if (type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return { type, data: block.data, mimeType: block.mimeType };
  }
  if (type === "audio" && typeof block.data === "string" && typeof block.mimeType === "string") {
    return { type, data: block.data, mimeType: block.mimeType };
  }
  if (type === "resource" && isRecord(block.resource)) {
    return { type, resource: block.resource };
  }
  return {
    type: "text",
    text: stringifyUnknown(block),
  };
}

function sanitizeToolResult(result: unknown): {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  if (!isRecord(result)) {
    return {
      content: [{ type: "text", text: stringifyUnknown(result) }],
    };
  }

  const content = Array.isArray(result.content)
    ? result.content.map((block) => sanitizeMcpContentBlock(block))
    : [];
  const structuredContent =
    isRecord(result.details) && !Array.isArray(result.details) ? result.details : undefined;
  const isError = typeof result.isError === "boolean" ? result.isError : undefined;

  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
}

async function main(): Promise<void> {
  const workspaceDir = readEnvString(OPENCLAW_NATIVE_MCP_WORKSPACE_ENV) ?? process.cwd();
  const sessionKey = readEnvString(OPENCLAW_NATIVE_MCP_SESSION_KEY_ENV);
  const explicitAgentId = readEnvString(OPENCLAW_NATIVE_MCP_AGENT_ID_ENV);
  const browserBaseUrl = readEnvString(OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV);
  let toolDefinitionsPromise: Promise<NativeToolDefinition[]> | undefined;
  const getToolDefinitions = () => {
    toolDefinitionsPromise ??= buildToolDefinitions({
      workspaceDir,
      sessionKey,
      explicitAgentId,
      browserBaseUrl,
    });
    return toolDefinitionsPromise;
  };

  const server = new Server(
    { name: "openclaw-native-tools", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...STATIC_TOOL_DEFINITIONS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolDefinitions =
      request.params.name === "exec" || request.params.name === "process"
        ? await buildToolDefinitions({
            workspaceDir,
            sessionKey,
            explicitAgentId,
            browserBaseUrl,
            toolName: request.params.name,
          })
        : await getToolDefinitions();
    const definition = toolDefinitions.find((tool) => tool.name === request.params.name);
    if (!definition) {
      return {
        content: [{ type: "text", text: `Tool not available: ${request.params.name}` }],
        isError: true,
      };
    }

    const toolCallId =
      typeof request.params._meta?.progressToken === "string"
        ? request.params._meta.progressToken
        : randomUUID();
    const result = await withSuppressedStdout(async () =>
      definition.execute(
        toolCallId,
        request.params.arguments ?? {},
        undefined,
        undefined,
        undefined,
      ),
    );
    return sanitizeToolResult(result);
  });

  await server.connect(new StdioServerTransport());
}

void main();
