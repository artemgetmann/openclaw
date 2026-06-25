import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { migrateJarvisWorkspacePointers } from "./jarvis-workspace-migration.js";

function jarvisConfigPath(home: string): string {
  return path.join(home, "Library", "Application Support", "Jarvis", ".jarvis", "openclaw.json");
}

function legacyWorkspace(home: string): string {
  return path.join(home, "Library", "Application Support", "OpenClaw", ".openclaw", "workspace");
}

function canonicalWorkspace(home: string): string {
  return path.join(home, "Library", "Application Support", "Jarvis", ".jarvis", "workspace");
}

describe("migrateJarvisWorkspacePointers", () => {
  it("repairs stale Jarvis workspace pointers in defaults and listed agents", () => {
    const home = "/tmp/openclaw-test-home";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: legacyWorkspace(home),
        },
        list: [
          { id: "main", workspace: legacyWorkspace(home) },
          { id: "research", workspace: "/tmp/research-workspace" },
          { id: "codex", workspace: `~/${path.relative(home, legacyWorkspace(home))}` },
        ],
      },
    };

    const result = migrateJarvisWorkspacePointers({
      config: cfg,
      configPath: jarvisConfigPath(home),
      env: { HOME: home } as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result.changes).toHaveLength(3);
    expect(result.config.agents?.defaults?.workspace).toBe(canonicalWorkspace(home));
    expect(result.config.agents?.list?.[0]?.workspace).toBe(canonicalWorkspace(home));
    expect(result.config.agents?.list?.[1]?.workspace).toBe("/tmp/research-workspace");
    expect(result.config.agents?.list?.[2]?.workspace).toBe(canonicalWorkspace(home));
    expect(cfg.agents?.defaults?.workspace).toBe(legacyWorkspace(home));
  });

  it("uses the OS user home instead of OPENCLAW_HOME in packaged Jarvis", () => {
    const home = "/tmp/openclaw-test-home";
    const jarvisRuntimeRoot = path.join(home, "Library", "Application Support", "Jarvis");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: legacyWorkspace(home),
        },
      },
    };

    const result = migrateJarvisWorkspacePointers({
      config: cfg,
      configPath: jarvisConfigPath(home),
      env: {
        HOME: home,
        OPENCLAW_HOME: jarvisRuntimeRoot,
        OPENCLAW_STATE_DIR: path.join(jarvisRuntimeRoot, ".jarvis"),
      } as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result.changes).toHaveLength(1);
    expect(result.config.agents?.defaults?.workspace).toBe(canonicalWorkspace(home));
  });

  it("does not repair non-Jarvis configs", () => {
    const home = "/tmp/openclaw-test-home";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: legacyWorkspace(home),
        },
      },
    };

    const result = migrateJarvisWorkspacePointers({
      config: cfg,
      configPath: path.join(home, ".openclaw", "openclaw.json"),
      env: { HOME: home } as NodeJS.ProcessEnv,
      homedir: () => home,
    });

    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
  });
});
