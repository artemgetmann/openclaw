import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { captureEnv } from "../../test-utils/env.js";

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];

const serviceMock = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn(async (_opts?: { environment?: Record<string, string | undefined> }) => {}),
  uninstall: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  isLoaded: vi.fn(async () => false),
  readCommand: vi.fn<GatewayService["readCommand"]>(async () => null),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => serviceMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (message: string) => runtimeLogs.push(message),
    error: (message: string) => runtimeErrors.push(message),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

const { runDaemonInstall } = await import("./install.js");
const { clearConfigCache } = await import("../../config/config.js");

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("runDaemonInstall integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let configPath: string;

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "CLAWDBOT_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "CLAWDBOT_GATEWAY_PASSWORD",
      "GOOGLE_PLACES_API_KEY",
      "HIMALAYA_CONFIG",
    ]);
    tempHome = await makeTempWorkspace("openclaw-daemon-install-int-");
    configPath = path.join(tempHome, "openclaw.json");
    process.env.HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    vi.clearAllMocks();
    // Keep these defined-but-empty so dotenv won't repopulate from local .env.
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.CLAWDBOT_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    process.env.CLAWDBOT_GATEWAY_PASSWORD = "";
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.HIMALAYA_CONFIG;
    serviceMock.isLoaded.mockResolvedValue(false);
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    clearConfigCache();
  });

  it("fails closed when token SecretRef is required but unresolved", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_GATEWAY_TOKEN",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await expect(runDaemonInstall({ json: true })).rejects.toThrow("__exit__:1");
    expect(serviceMock.install).not.toHaveBeenCalled();
    const joined = runtimeLogs.join("\n");
    expect(joined).toContain("SecretRef is configured but unresolved");
    expect(joined).toContain("MISSING_GATEWAY_TOKEN");
  });

  it("auto-mints token when no source exists without embedding it into service env", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: {
            auth: {
              mode: "token",
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await runDaemonInstall({ json: true });

    expect(serviceMock.install).toHaveBeenCalledTimes(1);
    const updated = await readJson(configPath);
    const gateway = (updated.gateway ?? {}) as { auth?: { token?: string } };
    const persistedToken = gateway.auth?.token;
    expect(typeof persistedToken).toBe("string");
    expect((persistedToken ?? "").length).toBeGreaterThan(0);

    const installEnv = serviceMock.install.mock.calls[0]?.[0]?.environment;
    expect(installEnv?.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("passes allowlisted skill env vars into the service install environment", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-google-places-key";
    process.env.HIMALAYA_CONFIG = "/tmp/himalaya-empty.toml";

    await runDaemonInstall({ json: true });

    expect(serviceMock.install).toHaveBeenCalledTimes(1);
    const installEnv = serviceMock.install.mock.calls[0]?.[0]?.environment;
    expect(installEnv?.GOOGLE_PLACES_API_KEY).toBe("test-google-places-key");
    expect(installEnv?.HIMALAYA_CONFIG).toBe("/tmp/himalaya-empty.toml");
  });

  it("fails closed when the default shared service already belongs to another runtime", async () => {
    serviceMock.readCommand.mockResolvedValue({
      programArguments: [
        "/opt/homebrew/bin/node",
        "/tmp/other/dist/index.js",
        "gateway",
        "--port",
        "31197",
      ],
      workingDirectory: "/tmp/other",
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/other/.openclaw",
        OPENCLAW_CONFIG_PATH: "/tmp/other/.openclaw/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "31197",
      },
    });

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.install).not.toHaveBeenCalled();
    const joined = runtimeLogs.join("\n");
    expect(joined).toContain(
      "default shared gateway service already belongs to another runtime/config",
    );
    expect(joined).toContain("--allow-shared-service-takeover");
  });

  it("allows explicit takeover of the default shared service", async () => {
    serviceMock.readCommand.mockResolvedValue({
      programArguments: [
        "/opt/homebrew/bin/node",
        "/tmp/other/dist/index.js",
        "gateway",
        "--port",
        "31197",
      ],
      workingDirectory: "/tmp/other",
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/other/.openclaw",
        OPENCLAW_CONFIG_PATH: "/tmp/other/.openclaw/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "31197",
      },
    });

    await runDaemonInstall({ json: true, force: true, allowSharedServiceTakeover: true });

    expect(serviceMock.install).toHaveBeenCalledTimes(1);
  });
});
