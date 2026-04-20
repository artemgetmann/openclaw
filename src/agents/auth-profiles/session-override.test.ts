import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { resolveSessionAuthProfileOverride } from "./session-override.js";

async function writeAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "zai:work": { type: "api_key", provider: "zai", key: "sk-test" },
    },
    order: {
      zai: ["zai:work"],
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

async function writeOpenAiAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "openai:p1": { type: "api_key", provider: "openai", key: "sk-p1" },
      "openai:p2": { type: "api_key", provider: "openai", key: "sk-p2" },
    },
    usageStats: {
      "openai:p1": { lastUsed: 1 },
      "openai:p2": { lastUsed: 2 },
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

async function writeCodexAuthStore(agentDir: string) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "api_key",
        provider: "openai-codex",
        key: "sk-default",
      },
      "openai-codex:notblockedamazon": {
        type: "api_key",
        provider: "openai-codex",
        key: "sk-stale-store-first",
      },
    },
    order: {
      "openai-codex": ["openai-codex:notblockedamazon", "openai-codex:default"],
    },
  };
  await fs.writeFile(authPath, JSON.stringify(payload), "utf-8");
}

describe("resolveSessionAuthProfileOverride", () => {
  it("keeps user override when provider alias differs", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "zai:work",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "z.ai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("zai:work");
      expect(sessionEntry.authProfileOverride).toBe("zai:work");
    });
  });

  it("pins codex auto override to the canonical default instead of stale store order", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeCodexAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s-codex",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:codex": sessionEntry };
      const cfg = {
        auth: {
          profiles: {
            "openai-codex:default": { provider: "openai-codex", mode: "api_key" },
            "openai-codex:notblockedamazon": {
              provider: "openai-codex",
              mode: "api_key",
            },
          },
          order: {
            "openai-codex": ["openai-codex:default", "openai-codex:notblockedamazon"],
          },
        },
      } as OpenClawConfig;

      const resolved = await resolveSessionAuthProfileOverride({
        cfg,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:codex",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai-codex:default");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:default");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("keeps explicit codex user override intact", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeCodexAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s-codex-user",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:notblockedamazon",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:codex-user": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai-codex",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:codex-user",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai-codex:notblockedamazon");
      expect(sessionEntry.authProfileOverride).toBe("openai-codex:notblockedamazon");
      expect(sessionEntry.authProfileOverrideSource).toBe("user");
    });
  });

  it("keeps non-codex providers on round-robin auto selection", async () => {
    await withStateDirEnv("openclaw-auth-", async ({ stateDir }) => {
      const agentDir = path.join(stateDir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await writeOpenAiAuthStore(agentDir);

      const sessionEntry: SessionEntry = {
        sessionId: "s-openai",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:openai": sessionEntry };

      const resolved = await resolveSessionAuthProfileOverride({
        cfg: {} as OpenClawConfig,
        provider: "openai",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:openai",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("openai:p1");
      expect(sessionEntry.authProfileOverride).toBe("openai:p1");
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });
});
