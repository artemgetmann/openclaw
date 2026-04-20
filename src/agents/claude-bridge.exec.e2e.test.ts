import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { clearClaudeBridgeSessionsForTests } from "./claude-bridge.js";
import { runCliAgent } from "./cli-runner.js";

const E2E_TIMEOUT_MS = 20_000;
const require = createRequire(import.meta.url);
const SDK_CLIENT_INDEX_PATH = require.resolve("@modelcontextprotocol/sdk/client/index.js");
const SDK_CLIENT_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/client/stdio.js");

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

async function writeFakeClaudeBridgeCli(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { Client } from ${JSON.stringify(SDK_CLIENT_INDEX_PATH)};
import { StdioClientTransport } from ${JSON.stringify(SDK_CLIENT_STDIO_PATH)};

function readArg(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) {
      return args[i + 1];
    }
    if (arg.startsWith(name + "=")) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function extractText(result) {
  return Array.isArray(result.content)
    ? result.content
        .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
        .map((entry) => entry.text)
        .join("\\n")
    : "";
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.once("line", async () => {
  const mcpConfigPath = readArg("--mcp-config");
  if (!mcpConfigPath) {
    throw new Error("missing --mcp-config");
  }

  const raw = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
  const server = raw?.mcpServers?.openclawNativeTools;
  if (!server || typeof server !== "object") {
    throw new Error("missing openclawNativeTools MCP server");
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: Array.isArray(server.args) ? server.args : [],
    env:
      server.env && typeof server.env === "object"
        ? { ...process.env, ...server.env }
        : process.env,
    cwd:
      typeof server.cwd === "string"
        ? server.cwd
        : typeof server.workingDirectory === "string"
          ? server.workingDirectory
          : undefined,
  });
  const client = new Client({ name: "fake-claude-bridge", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "exec")) {
    throw new Error("native exec tool not exposed");
  }

  const markerPath = process.env.EXEC_PROBE_MARKER;
  const nonce = process.env.EXEC_PROBE_NONCE ?? "missing-nonce";
  if (!markerPath) {
    throw new Error("missing EXEC_PROBE_MARKER");
  }

  const command = [
    process.execPath,
    "-e",
    "const fs = require('node:fs'); fs.writeFileSync(process.env.EXEC_PROBE_MARKER, process.env.EXEC_PROBE_NONCE, 'utf8'); process.stdout.write(JSON.stringify({ nonce: process.env.EXEC_PROBE_NONCE, marker: process.env.EXEC_PROBE_MARKER, cwd: process.cwd() }));",
  ];
  const result = await client.callTool({
    name: "exec",
    arguments: {
      command: command.map((part) => JSON.stringify(part)).join(" "),
      workdir: process.cwd(),
      timeout: 5,
    },
  });
  await transport.close();

  const text = extractText(result);
  const message = "CLAUDE BRIDGE NATIVE EXEC OK\\n" + text + "\\nNONCE=" + nonce;
  const sessionId = readArg("--session-id") ?? randomUUID();

  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: message }] },
    }) + "\\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      session_id: sessionId,
      result: message,
    }) + "\\n",
  );

  setTimeout(() => process.exit(0), 250);
});
`,
  );
}

describe("runCliAgent claude-bridge native exec e2e", () => {
  it(
    "injects native OpenClaw exec into claude-bridge and proves a real command wrote a nonce file",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv(["HOME", "EXEC_PROBE_MARKER", "EXEC_PROBE_NONCE"]);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-bridge-exec-"));
      process.env.HOME = tempHome;

      const nonce = randomUUID();
      const workspaceDir = path.join(tempHome, "workspace");
      const sessionFile = path.join(tempHome, "session.jsonl");
      const binDir = path.join(tempHome, "bin");
      const markerPath = path.join(tempHome, "exec-proof-marker.txt");
      const fakeClaudePath = path.join(binDir, "fake-claude-bridge.mjs");
      process.env.EXEC_PROBE_MARKER = markerPath;
      process.env.EXEC_PROBE_NONCE = nonce;
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeFakeClaudeBridgeCli(fakeClaudePath);

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            cliBackends: {
              "claude-bridge": {
                command: "node",
                args: [fakeClaudePath],
                clearEnv: [],
              },
            },
          },
        },
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
      };

      try {
        const result = await runCliAgent({
          sessionId: "session:claude-bridge-native-exec",
          sessionFile,
          workspaceDir,
          config,
          prompt: "Use the native OpenClaw exec tool exposed through the bridge and prove it ran.",
          provider: "claude-bridge",
          model: "test-native-exec",
          timeoutMs: E2E_TIMEOUT_MS,
          runId: "claude-bridge-native-exec",
        });

        const assistantText = result.payloads?.[0]?.text ?? "";
        expect(assistantText).toContain("CLAUDE BRIDGE NATIVE EXEC OK");
        expect(assistantText).toContain(nonce);
        await expect(fs.readFile(markerPath, "utf-8")).resolves.toBe(nonce);
      } finally {
        await clearClaudeBridgeSessionsForTests();
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
  );
});
