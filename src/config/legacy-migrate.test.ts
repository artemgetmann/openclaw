import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";
import { WHISPER_BASE_AUDIO_MODEL } from "./legacy-migrate.test-helpers.js";

function makeStaleJarvisConsumerConfig(overrides: Record<string, unknown> = {}) {
  return {
    jarvis: {
      managedServices: { mode: "managed" },
      backend: { baseUrl: "https://jarvis.example.invalid" },
    },
    auth: {
      profiles: {
        "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
      },
      order: {
        "openai-codex": ["openai-codex:default"],
      },
    },
    agents: {
      defaults: {
        model: { primary: "openai-codex/gpt-5.4" },
        models: {
          "anthropic/claude-haiku-4-5": {},
          "anthropic/claude-opus-4-6": {},
          "anthropic/claude-sonnet-4-6": {},
          "openai-codex/gpt-5.3-codex": {},
          "openai-codex/gpt-5.4": {},
        },
      },
    },
    ...overrides,
  };
}

describe("legacy migrate Jarvis consumer model defaults", () => {
  it("adds GPT-5.5 and promotes the managed GPT-5.4 primary", () => {
    const res = migrateLegacyConfig(makeStaleJarvisConsumerConfig());

    expect(res.changes).toContain("Added openai-codex/gpt-5.5 to Jarvis consumer model allowlist.");
    expect(res.changes).toContain(
      "Updated Jarvis consumer primary model openai-codex/gpt-5.4 → openai-codex/gpt-5.5.",
    );
    expect(res.config?.agents?.defaults?.model).toEqual({ primary: "openai-codex/gpt-5.5" });
    expect(res.config?.agents?.defaults?.models?.["openai-codex/gpt-5.5"]).toEqual({});
    expect(res.config?.agents?.defaults?.models?.["openai-codex/gpt-5.4"]).toEqual({});
    expect(res.config?.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]).toBeDefined();
  });

  it("preserves a custom primary while refreshing the stale allowlist", () => {
    const res = migrateLegacyConfig(
      makeStaleJarvisConsumerConfig({
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: {
              "openai-codex/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      }),
    );

    expect(res.config?.agents?.defaults?.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
    expect(res.config?.agents?.defaults?.models?.["openai-codex/gpt-5.5"]).toEqual({});
  });

  it("adds Claude Sonnet entries only when matching Claude auth exists", () => {
    const res = migrateLegacyConfig(
      makeStaleJarvisConsumerConfig({
        auth: {
          profiles: {
            "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
            "anthropic:claude-cli": { provider: "anthropic", mode: "oauth" },
          },
          order: {
            "openai-codex": ["openai-codex:default"],
            anthropic: ["anthropic:claude-cli"],
          },
        },
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.4" },
            models: {
              "openai-codex/gpt-5.4": {},
            },
          },
        },
      }),
    );

    expect(res.config?.agents?.defaults?.models?.["claude-cli/sonnet"]).toEqual({});
    expect(res.config?.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]).toBeDefined();
  });

  it("does not rewrite non-Jarvis configs with similar model keys", () => {
    const res = migrateLegacyConfig({
      auth: {
        profiles: {
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.4" },
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toEqual([]);
  });
});

describe("legacy migrate audio transcription", () => {
  it("removes legacy inline apiKey values from media understanding models", () => {
    const res = migrateLegacyConfig({
      tools: {
        media: {
          models: [{ provider: "openai", model: "gpt-5-mini", apiKey: "global-key" }],
          audio: {
            models: [
              {
                provider: "openai",
                model: "whisper-1",
                apiKey: "audio-key",
                timeoutSeconds: 30,
              },
            ],
          },
        },
      },
    });

    expect(res.changes).toContain("Removed tools.media.models[].apiKey (1).");
    expect(res.changes).toContain("Removed tools.media.audio.models[].apiKey (1).");
    expect(res.config?.tools?.media?.models).toEqual([{ provider: "openai", model: "gpt-5-mini" }]);
    expect(res.config?.tools?.media?.audio?.models).toEqual([
      { provider: "openai", model: "whisper-1", timeoutSeconds: 30 },
    ]);
  });

  it("moves routing.transcribeAudio into tools.media.audio.models", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });

    expect(res.changes).toContain("Moved routing.transcribeAudio → tools.media.audio.models.");
    expect(res.config?.tools?.media?.audio).toEqual(WHISPER_BASE_AUDIO_MODEL);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("keeps existing tools media model and drops legacy routing value", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "tiny"],
        },
      },
      tools: {
        media: {
          audio: {
            models: [{ command: "existing", type: "cli" }],
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Removed routing.transcribeAudio (tools.media.audio.models already set).",
    );
    expect(res.config?.tools?.media?.audio?.models).toEqual([{ command: "existing", type: "cli" }]);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("drops invalid audio.transcription payloads", () => {
    const res = migrateLegacyConfig({
      audio: {
        transcription: {
          command: [{}],
        },
      },
    });

    expect(res.changes).toContain("Removed audio.transcription (invalid or empty command).");
    expect(res.config?.audio).toBeUndefined();
    expect(res.config?.tools?.media?.audio).toBeUndefined();
  });
});

describe("legacy migrate mention routing", () => {
  it("moves routing.groupChat.requireMention into channel group defaults", () => {
    const res = migrateLegacyConfig({
      routing: {
        groupChat: {
          requireMention: true,
        },
      },
    });

    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(true);
    expect(res.config?.channels?.imessage?.groups?.["*"]?.requireMention).toBe(true);
    expect((res.config as { routing?: unknown } | null)?.routing).toBeUndefined();
  });

  it("moves channels.telegram.requireMention into groups.*.requireMention", () => {
    const res = migrateLegacyConfig({
      channels: {
        telegram: {
          requireMention: false,
        },
      },
    });

    expect(res.changes).toContain(
      'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(
      (res.config?.channels?.telegram as { requireMention?: unknown } | undefined)?.requireMention,
    ).toBeUndefined();
  });
});

describe("legacy migrate heartbeat config", () => {
  it("moves top-level heartbeat into agents.defaults.heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
    });

    expect(res.changes).toContain("Moved heartbeat → agents.defaults.heartbeat.");
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      model: "anthropic/claude-3-5-haiku-20241022",
      every: "30m",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("moves top-level heartbeat visibility into channels.defaults.heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        showOk: true,
        showAlerts: false,
        useIndicator: false,
      },
    });

    expect(res.changes).toContain("Moved heartbeat visibility → channels.defaults.heartbeat.");
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({
      showOk: true,
      showAlerts: false,
      useIndicator: false,
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("keeps explicit agents.defaults.heartbeat values when merging top-level heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            target: "telegram",
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values).",
    );
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-3-5-haiku-20241022",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("keeps explicit channels.defaults.heartbeat values when merging top-level heartbeat visibility", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        showOk: true,
        showAlerts: true,
      },
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
            useIndicator: false,
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values).",
    );
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: false,
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("preserves agent.heartbeat precedence over top-level heartbeat legacy key", () => {
    const res = migrateLegacyConfig({
      agent: {
        heartbeat: {
          every: "1h",
          target: "telegram",
        },
      },
      heartbeat: {
        every: "30m",
        target: "discord",
        model: "anthropic/claude-3-5-haiku-20241022",
      },
    });

    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-3-5-haiku-20241022",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
    expect((res.config as { agent?: unknown } | null)?.agent).toBeUndefined();
  });

  it("drops blocked prototype keys when migrating top-level heartbeat", () => {
    const res = migrateLegacyConfig(
      JSON.parse(
        '{"heartbeat":{"every":"30m","__proto__":{"polluted":true},"showOk":true}}',
      ) as Record<string, unknown>,
    );

    const heartbeat = res.config?.agents?.defaults?.heartbeat as
      | Record<string, unknown>
      | undefined;
    expect(heartbeat?.every).toBe("30m");
    expect((heartbeat as { polluted?: unknown } | undefined)?.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(heartbeat ?? {}, "__proto__")).toBe(false);
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({ showOk: true });
  });

  it("records a migration change when removing empty top-level heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {},
    });

    expect(res.changes).toContain("Removed empty top-level heartbeat.");
    expect(res.config).not.toBeNull();
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });
});

describe("legacy migrate controlUi.allowedOrigins seed (issue #29385)", () => {
  it("seeds allowedOrigins for bind=lan with no existing controlUi config", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes.some((c) => c.includes("gateway.controlUi.allowedOrigins"))).toBe(true);
    expect(res.changes.some((c) => c.includes("bind=lan"))).toBe(true);
  });

  it("seeds allowedOrigins using configured port", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        port: 9000,
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:9000",
      "http://127.0.0.1:9000",
    ]);
  });

  it("seeds allowedOrigins including custom bind host for bind=custom", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.100",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toContain("http://192.168.1.100:18789");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:18789");
  });

  it("does not overwrite existing allowedOrigins — returns null (no migration needed)", () => {
    // When allowedOrigins already exists, the migration is a no-op.
    // applyLegacyMigrations returns next=null when changes.length===0, so config is null.
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { allowedOrigins: ["https://control.example.com"] },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("does not migrate when dangerouslyAllowHostHeaderOriginFallback is set — returns null", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("seeds allowedOrigins when existing entries are blank strings", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { allowedOrigins: ["", "   "] },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes.some((c) => c.includes("gateway.controlUi.allowedOrigins"))).toBe(true);
  });

  it("does not migrate loopback bind — returns null", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("preserves existing controlUi fields when seeding allowedOrigins", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { basePath: "/app" },
      },
    });
    expect(res.config?.gateway?.controlUi?.basePath).toBe("/app");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });
});
