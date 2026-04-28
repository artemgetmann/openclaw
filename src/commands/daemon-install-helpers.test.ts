import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolvePreferredNodePath: vi.fn(),
  resolveGatewayProgramArguments: vi.fn(),
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
  buildServiceEnvironment: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: mocks.loadAuthProfileStoreForSecretsRuntime,
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: mocks.resolveGatewayProgramArguments,
}));

vi.mock("../daemon/service-env.js", () => ({
  buildServiceEnvironment: mocks.buildServiceEnvironment,
  resolveGatewayRuntimeIdentityEnv: (env: Record<string, string | undefined>) => ({ ...env }),
}));

import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
  resolveGatewayDevMode,
} from "./daemon-install-helpers.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveGatewayDevMode", () => {
  it("detects dev mode for src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\openclaw\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

function mockNodeGatewayPlanFixture(
  params: {
    workingDirectory?: string;
    version?: string;
    supported?: boolean;
    warning?: string;
    serviceEnvironment?: Record<string, string>;
  } = {},
) {
  const {
    workingDirectory = "/Users/me",
    version = "22.0.0",
    supported = true,
    warning,
    serviceEnvironment = { OPENCLAW_PORT: "3000" },
  } = params;
  mocks.resolvePreferredNodePath.mockResolvedValue("/opt/node");
  mocks.resolveGatewayProgramArguments.mockResolvedValue({
    programArguments: ["node", "gateway"],
    workingDirectory,
  });
  mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
    version: 1,
    profiles: {},
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/opt/node",
    version,
    supported,
  });
  mocks.renderSystemNodeWarning.mockReturnValue(warning);
  mocks.buildServiceEnvironment.mockReturnValue(serviceEnvironment);
}

describe("buildGatewayInstallPlan", () => {
  it("uses provided nodePath and returns plan", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      nodePath: "/custom/node",
    });

    expect(plan.programArguments).toEqual(["node", "gateway"]);
    expect(plan.workingDirectory).toBe("/Users/me");
    expect(plan.environment).toEqual({ OPENCLAW_PORT: "3000" });
    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
  });

  it("emits warnings when renderSystemNodeWarning returns one", async () => {
    const warn = vi.fn();
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      version: "18.0.0",
      supported: false,
      warning: "Node too old",
      serviceEnvironment: {},
    });

    await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      warn,
    });

    expect(warn).toHaveBeenCalledWith("Node too old", "Gateway runtime");
    expect(mocks.resolvePreferredNodePath).toHaveBeenCalled();
  });

  it("does not persist config env vars into the daemon environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
        HOME: "/Users/me",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            GOOGLE_API_KEY: "test-key", // pragma: allowlist secret
          },
          CUSTOM_VAR: "custom-value",
        },
      },
    });

    expect(plan.environment.GOOGLE_API_KEY).toBeUndefined();
    expect(plan.environment.CUSTOM_VAR).toBeUndefined();
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.HOME).toBe("/Users/me");
  });

  it("still omits dangerous config env vars from the daemon environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            NODE_OPTIONS: "--require /tmp/evil.js",
            SAFE_KEY: "safe-value",
          },
        },
      },
    });

    expect(plan.environment.NODE_OPTIONS).toBeUndefined();
    expect(plan.environment.SAFE_KEY).toBeUndefined();
  });

  it("ignores config env vars even when they are non-empty", async () => {
    mockNodeGatewayPlanFixture();

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            VALID_KEY: "valid",
            EMPTY_KEY: "",
          },
        },
      },
    });

    expect(plan.environment.VALID_KEY).toBeUndefined();
    expect(plan.environment.EMPTY_KEY).toBeUndefined();
  });

  it("ignores config env inline keys too", async () => {
    mockNodeGatewayPlanFixture({ serviceEnvironment: {} });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            VALID_KEY: "valid",
          },
          TRIMMED_KEY: "  ",
        },
      },
    });

    expect(plan.environment.VALID_KEY).toBeUndefined();
    expect(plan.environment.TRIMMED_KEY).toBeUndefined();
  });

  it("keeps service env values without config env fallback", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        HOME: "/Users/service",
        OPENCLAW_PORT: "3000",
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
      config: {
        env: {
          HOME: "/Users/config",
          vars: {
            OPENCLAW_PORT: "9999",
          },
        },
      },
    });

    expect(plan.environment.HOME).toBe("/Users/service");
    expect(plan.environment.OPENCLAW_PORT).toBe("3000");
    expect(plan.environment.OPENCLAW_PORT).not.toBe("9999");
  });

  it("fills canonical shared gateway markers from the default service install plan", async () => {
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      serviceEnvironment: {
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        OPENCLAW_CONFIG_PATH:
          "/Users/me/Library/Application Support/OpenClaw/.openclaw/openclaw.json",
      },
    });
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/opt/node", "/Users/me/Programming_Projects/openclaw/dist/index.js"],
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 18789,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH).toBe(
      "/Users/me/Library/Application Support/OpenClaw/.openclaw/openclaw.json",
    );
    expect(plan.environment.OPENCLAW_MAIN_REPO).toBe("/Users/me/Programming_Projects/openclaw");
  });

  it("does not assign canonical shared gateway markers to isolated profile services", async () => {
    mockNodeGatewayPlanFixture({
      workingDirectory: undefined,
      serviceEnvironment: {
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.tester",
        OPENCLAW_CONFIG_PATH: "/tmp/tester/openclaw.json",
      },
    });
    mocks.resolveGatewayProgramArguments.mockResolvedValue({
      programArguments: ["/opt/node", "/Users/me/openclaw/dist/index.js"],
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 19001,
      runtime: "node",
    });

    expect(plan.environment.OPENCLAW_CANONICAL_SHARED_GATEWAY_CONFIG_PATH).toBeUndefined();
    expect(plan.environment.OPENCLAW_MAIN_REPO).toBeUndefined();
  });

  it("merges env-backed auth-profile refs into the service environment", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
        ANTHROPIC_TOKEN: "ant-test-token",
      },
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.ANTHROPIC_TOKEN).toBe("ant-test-token");
  });

  it("keeps env-backed auth refs while excluding config env vars", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {
        OPENAI_API_KEY: "sk-openai-test", // pragma: allowlist secret
      },
      port: 3000,
      runtime: "node",
      config: {
        env: {
          vars: {
            GOOGLE_API_KEY: "cfg-key", // pragma: allowlist secret
          },
          CUSTOM_VAR: "custom-value",
        },
      },
    });

    expect(plan.environment.OPENAI_API_KEY).toBe("sk-openai-test");
    expect(plan.environment.GOOGLE_API_KEY).toBeUndefined();
    expect(plan.environment.CUSTOM_VAR).toBeUndefined();
  });

  it("skips unresolved auth-profile env refs", async () => {
    mockNodeGatewayPlanFixture({
      serviceEnvironment: {
        OPENCLAW_PORT: "3000",
      },
    });
    mocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });

    const plan = await buildGatewayInstallPlan({
      env: {},
      port: 3000,
      runtime: "node",
    });

    expect(plan.environment.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("gatewayInstallErrorHint", () => {
  it("returns platform-specific hints", () => {
    expect(gatewayInstallErrorHint("win32")).toContain("Startup-folder login item");
    expect(gatewayInstallErrorHint("win32")).toContain("elevated PowerShell");
    expect(gatewayInstallErrorHint("linux")).toMatch(
      /(?:openclaw|openclaw)( --profile isolated)? gateway install/,
    );
  });
});
