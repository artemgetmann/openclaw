import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  createConfigIO: vi.fn(),
  resolveStateDir: vi.fn(),
  resolveOpenClawAgentDir: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  runAuthProbes: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
    createConfigIO: mocks.createConfigIO,
    resolveStateDir: mocks.resolveStateDir,
  };
});

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  };
});

vi.mock("./list.probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./list.probe.js")>();
  return {
    ...actual,
    runAuthProbes: mocks.runAuthProbes,
  };
});

const { CONSUMER_CANONICAL_SHARED_PROFILE_ID, resolveModelsReadiness } =
  await import("./readiness.js");

function makeManagedConfig() {
  return {
    agents: {
      defaults: {
        model: "openai-codex/gpt-5.4",
      },
    },
    auth: {
      profiles: {
        [CONSUMER_CANONICAL_SHARED_PROFILE_ID]: {
          provider: "openai-codex",
          mode: "oauth",
        },
      },
    },
  };
}

function makeManagedStore(extraProfiles?: Record<string, Record<string, unknown>>) {
  return {
    version: 1,
    profiles: {
      [CONSUMER_CANONICAL_SHARED_PROFILE_ID]: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      ...extraProfiles,
    },
  };
}

beforeEach(() => {
  const config = makeManagedConfig();
  mocks.loadConfig.mockReset();
  mocks.getRuntimeConfigSourceSnapshot.mockReset();
  mocks.createConfigIO.mockReset();
  mocks.resolveStateDir.mockReset();
  mocks.resolveOpenClawAgentDir.mockReset();
  mocks.ensureAuthProfileStore.mockReset();
  mocks.resolveAuthProfileOrder.mockReset();
  mocks.runAuthProbes.mockReset();

  mocks.loadConfig.mockReturnValue(config);
  mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(null);
  mocks.createConfigIO.mockReturnValue({
    configPath: "/tmp/openclaw-consumer/.openclaw/openclaw.json",
  });
  mocks.resolveStateDir.mockReturnValue("/tmp/openclaw-consumer/.openclaw");
  mocks.resolveOpenClawAgentDir.mockReturnValue(
    "/tmp/openclaw-consumer/.openclaw/agents/main/agent",
  );
  mocks.ensureAuthProfileStore.mockReturnValue(makeManagedStore());
  mocks.resolveAuthProfileOrder.mockReturnValue([]);
  mocks.runAuthProbes.mockResolvedValue({
    startedAt: 100,
    finishedAt: 150,
    durationMs: 50,
    totalTargets: 1,
    options: {
      provider: "openai-codex",
      profileIds: [CONSUMER_CANONICAL_SHARED_PROFILE_ID],
      timeoutMs: 15_000,
      concurrency: 1,
      maxTokens: 8,
    },
    results: [
      {
        provider: "openai-codex",
        model: "openai-codex/gpt-5.4",
        profileId: CONSUMER_CANONICAL_SHARED_PROFILE_ID,
        label: CONSUMER_CANONICAL_SHARED_PROFILE_ID,
        source: "profile",
        mode: "oauth",
        status: "ok",
        latencyMs: 432,
      },
    ],
  });
});

describe("resolveModelsReadiness", () => {
  it("blocks when config and state resolve to different runtimes", async () => {
    mocks.resolveStateDir.mockReturnValue("/tmp/founder/.openclaw");

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("blocked");
    expect(readiness.reasonCodes).toEqual(["wrong_state_dir"]);
    expect(mocks.runAuthProbes).not.toHaveBeenCalled();
  });

  it("uses only the canonical managed profile for the consumer shared lane", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue(
      makeManagedStore({
        "openai-codex:other": {
          type: "oauth",
          provider: "openai-codex",
          access: "other-access",
          refresh: "other-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("ready");
    expect(readiness.mode).toBe("managed");
    expect(mocks.runAuthProbes).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          provider: "openai-codex",
          profileIds: [CONSUMER_CANONICAL_SHARED_PROFILE_ID],
        }),
      }),
    );
    const probeCfg = mocks.runAuthProbes.mock.calls[0]?.[0]?.cfg as {
      auth?: { order?: Record<string, string[]> };
    };
    expect(probeCfg.auth?.order?.["openai-codex"]).toEqual([CONSUMER_CANONICAL_SHARED_PROFILE_ID]);
  });

  it("blocks when the canonical managed profile is missing", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("blocked");
    expect(readiness.mode).toBe("managed");
    expect(readiness.reasonCodes).toEqual(["missing_auth"]);
    expect(mocks.runAuthProbes).not.toHaveBeenCalled();
  });

  it("stays in managed mode when other Codex profiles exist but the canonical shared profile is missing", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.4",
        },
      },
      auth: {},
    });
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:notblockedamazon": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: {
        "openai-codex": ["openai-codex:notblockedamazon"],
      },
    });

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("blocked");
    expect(readiness.mode).toBe("managed");
    expect(readiness.reasonCodes).toEqual(["missing_auth"]);
    expect(mocks.runAuthProbes).not.toHaveBeenCalled();
  });

  it("blocks when the canonical shared profile fails the live probe", async () => {
    mocks.runAuthProbes.mockResolvedValue({
      startedAt: 100,
      finishedAt: 160,
      durationMs: 60,
      totalTargets: 1,
      options: {
        provider: "openai-codex",
        profileIds: [CONSUMER_CANONICAL_SHARED_PROFILE_ID],
        timeoutMs: 15_000,
        concurrency: 1,
        maxTokens: 8,
      },
      results: [
        {
          provider: "openai-codex",
          model: "openai-codex/gpt-5.4",
          profileId: CONSUMER_CANONICAL_SHARED_PROFILE_ID,
          label: CONSUMER_CANONICAL_SHARED_PROFILE_ID,
          source: "profile",
          mode: "oauth",
          status: "auth",
          error: "refresh_token_reused",
          latencyMs: 500,
        },
      ],
    });

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("blocked");
    expect(readiness.reasonCodes).toEqual(["probe_auth_failed"]);
    expect(readiness.summary).toContain("shared auth");
  });

  it("treats canonical profiles excluded by auth.order as missing shared auth", async () => {
    mocks.runAuthProbes.mockResolvedValue({
      startedAt: 100,
      finishedAt: 110,
      durationMs: 10,
      totalTargets: 0,
      options: {
        provider: "openai-codex",
        profileIds: [CONSUMER_CANONICAL_SHARED_PROFILE_ID],
        timeoutMs: 15_000,
        concurrency: 1,
        maxTokens: 8,
      },
      results: [
        {
          provider: "openai-codex",
          model: "openai-codex/gpt-5.4",
          profileId: CONSUMER_CANONICAL_SHARED_PROFILE_ID,
          label: CONSUMER_CANONICAL_SHARED_PROFILE_ID,
          source: "profile",
          mode: "oauth",
          status: "unknown",
          reasonCode: "excluded_by_auth_order",
          error: "Excluded by auth.order for this provider.",
        },
      ],
    });

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("blocked");
    expect(readiness.mode).toBe("managed");
    expect(readiness.reasonCodes).toEqual(["missing_auth"]);
    expect(readiness.summary).toContain("canonical shared auth profile");
  });

  it("uses the first configured byok profile when managed auth is not selected", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      auth: {},
    });
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:me": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-api-key",
        },
        "anthropic:backup": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-backup",
        },
      },
    });
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:me", "anthropic:backup"]);
    mocks.runAuthProbes.mockResolvedValue({
      startedAt: 200,
      finishedAt: 260,
      durationMs: 60,
      totalTargets: 1,
      options: {
        provider: "anthropic",
        profileIds: ["anthropic:me"],
        timeoutMs: 15_000,
        concurrency: 1,
        maxTokens: 8,
      },
      results: [
        {
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-6",
          profileId: "anthropic:me",
          label: "anthropic:me",
          source: "profile",
          mode: "api_key",
          status: "ok",
          latencyMs: 320,
        },
      ],
    });

    const readiness = await resolveModelsReadiness();

    expect(readiness.status).toBe("ready");
    expect(readiness.mode).toBe("byok");
    expect(mocks.runAuthProbes).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          provider: "anthropic",
          profileIds: ["anthropic:me"],
        }),
      }),
    );
  });
});
