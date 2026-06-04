import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { clearClaudeBridgeSessionsForTests, runClaudeBridgeAgent } from "./claude-bridge.js";
import { prepareCliBundleMcpConfig } from "./cli-runner/bundle-mcp.js";
import { OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV } from "./cli-runner/native-mcp.js";

const E2E_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
const SDK_CLIENT_INDEX_PATH = require.resolve("@modelcontextprotocol/sdk/client/index.js");
const SDK_CLIENT_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/client/stdio.js");

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

async function startFakeBrowserControlServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/profiles") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          profiles: [
            {
              name: "openclaw",
              cdpPort: 9222,
              cdpUrl: "http://127.0.0.1:9222",
              color: "#0F9D58",
              driver: "openclaw",
              running: false,
              tabCount: 0,
              isDefault: true,
              isRemote: false,
            },
            {
              name: "signed-in",
              cdpPort: 9333,
              cdpUrl: "http://127.0.0.1:9333",
              color: "#1A73E8",
              driver: "existing-session",
              running: false,
              tabCount: 0,
              isDefault: false,
              isRemote: false,
            },
          ],
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          enabled: true,
          profile: "openclaw",
          driver: "openclaw",
          transport: "cdp",
          running: false,
          tabCount: 0,
          pid: null,
          cdpPort: 9222,
          cdpUrl: "http://127.0.0.1:9222",
          chosenBrowser: "Google Chrome",
          userDataDir: "/tmp/fake-openclaw-browser",
          color: "#0F9D58",
          headless: false,
          attachOnly: false,
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", path: url.pathname }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve fake browser server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
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

function emitResult(sessionId, message) {
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
}

function readStructured(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = Array.isArray(result.content)
    ? result.content
        .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
        .map((entry) => entry.text)
        .join("\\n")
    : "";
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.once("line", async () => {
  const sessionId = readArg("--session-id") ?? randomUUID();
  try {
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
    if (!tools.tools.some((tool) => tool.name === "browser")) {
      throw new Error("native browser tool not exposed");
    }

    const profiles = readStructured(
      await client.callTool({
        name: "browser",
        arguments: { action: "profiles" },
      }),
    );
    const status = readStructured(
      await client.callTool({
        name: "browser",
        arguments: { action: "status", target: "sandbox" },
      }),
    );
    await transport.close();

    const profileList = Array.isArray(profiles.profiles) ? profiles.profiles : [];
    if (profileList.length === 0) {
      throw new Error("native browser profiles payload missing");
    }
    if (typeof status.driver !== "string") {
      throw new Error("native browser status payload missing");
    }

    const message = [
      "CLAUDE BRIDGE BROWSER PROOF OK",
      "profiles=" + profileList.map((profile) => profile?.name ?? "unknown").join(","),
      "statusDriver=" + status.driver,
      "statusRunning=" + String(status.running),
      "statusTabs=" + String(status.tabCount),
    ].join(" ");
    emitResult(sessionId, message);
    setTimeout(() => process.exit(0), 250);
  } catch (error) {
    const message =
      "CLAUDE BRIDGE NATIVE BROWSER ERROR " +
      (error instanceof Error ? error.stack ?? error.message : String(error));
    emitResult(sessionId, message);
    setTimeout(() => process.exit(0), 250);
  }
});
`,
  );
}

describe("claude-bridge native browser e2e", () => {
  it(
    "injects the internal native MCP server and proves deterministic browser profiles and status calls",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv(["HOME", OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV]);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-bridge-browser-"));
      process.env.HOME = tempHome;

      const fakeBrowserServer = await startFakeBrowserControlServer();
      process.env[OPENCLAW_NATIVE_MCP_BROWSER_BASE_URL_ENV] = fakeBrowserServer.baseUrl;

      const workspaceDir = path.join(tempHome, "workspace");
      const binDir = path.join(tempHome, "bin");
      const fakeClaudePath = path.join(binDir, "fake-claude-bridge-browser.mjs");
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeFakeClaudeBridgeCli(fakeClaudePath);

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            sandbox: {
              browser: {
                enabled: true,
              },
            },
            cliBackends: {
              "claude-bridge": {
                command: "node",
                args: [fakeClaudePath],
                clearEnv: [],
              },
            },
          },
        },
        browser: {
          enabled: true,
        },
      };

      const backend = config.agents?.defaults?.cliBackends?.["claude-bridge"];
      if (!backend) {
        throw new Error("missing claude-bridge backend config");
      }

      const prepared = await prepareCliBundleMcpConfig({
        backendId: "claude-bridge",
        backend,
        workspaceDir,
        config,
      });

      try {
        const sessionId = "session:claude-bridge-native-browser";
        const result = await runClaudeBridgeAgent({
          sessionId,
          workspaceDir,
          configBackend: prepared.backend,
          prompt:
            "Use the native OpenClaw browser tool exposed through the bridge and prove profiles plus status work.",
          provider: "claude-bridge",
          model: "test-native-browser",
          timeoutMs: 45_000,
          systemPrompt: "",
          systemPromptReport: {
            source: "run",
            generatedAt: Date.now(),
            sessionId,
            provider: "claude-bridge",
            model: "test-native-browser",
            workspaceDir,
            bootstrapMaxChars: 1,
            bootstrapTotalMaxChars: 1,
            sandbox: { mode: "off", sandboxed: false },
            systemPrompt: "",
            bootstrapFiles: [],
            injectedFiles: [],
            skillsPrompt: "",
            tools: [],
          },
        });

        const assistantText = result.payloads?.[0]?.text ?? "";
        expect(assistantText).toContain("CLAUDE BRIDGE BROWSER PROOF OK");
        expect(assistantText).toContain("profiles=openclaw,signed-in");
        expect(assistantText).toContain("statusDriver=openclaw");
        expect(assistantText).toContain("statusRunning=false");
        expect(assistantText).toContain("statusTabs=0");
      } finally {
        await clearClaudeBridgeSessionsForTests();
        await prepared.cleanup?.();
        await fakeBrowserServer.close();
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
  );
});
