import fsCallback from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { loadEnabledBundleMcpConfig, loadEnabledBundleMcpConfigAsync } from "./bundle-mcp.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearPluginManifestRegistryCache();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("loadEnabledBundleMcpConfig", () => {
  it("loads enabled Claude bundle MCP config and absolutizes relative args", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await createTempDir("openclaw-bundle-mcp-home-");
      const workspaceDir = await createTempDir("openclaw-bundle-mcp-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "bundle-probe");
      const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.dirname(serverPath), { recursive: true });
      await fs.writeFile(serverPath, "export {};\n", "utf-8");
      await fs.writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              bundleProbe: {
                command: "node",
                args: ["./servers/probe.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: config,
      });
      const resolvedServerPath = await fs.realpath(serverPath);

      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.config.mcpServers.bundleProbe?.command).toBe("node");
      expect(loaded.config.mcpServers.bundleProbe?.args).toEqual([resolvedServerPath]);
    } finally {
      env.restore();
    }
  });

  it("merges inline bundle MCP servers and skips disabled bundles", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await createTempDir("openclaw-bundle-inline-home-");
      const workspaceDir = await createTempDir("openclaw-bundle-inline-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const enabledRoot = path.join(homeDir, ".openclaw", "extensions", "inline-enabled");
      const disabledRoot = path.join(homeDir, ".openclaw", "extensions", "inline-disabled");
      await fs.mkdir(path.join(enabledRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(disabledRoot, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(enabledRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-enabled",
            mcpServers: {
              enabledProbe: {
                command: "node",
                args: ["./enabled.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(disabledRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            name: "inline-disabled",
            mcpServers: {
              disabledProbe: {
                command: "node",
                args: ["./disabled.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "inline-enabled": { enabled: true },
            "inline-disabled": { enabled: false },
          },
        },
      };

      const loaded = loadEnabledBundleMcpConfig({
        workspaceDir,
        cfg: config,
      });

      expect(loaded.config.mcpServers.enabledProbe).toBeDefined();
      expect(loaded.config.mcpServers.disabledProbe).toBeUndefined();
    } finally {
      env.restore();
    }
  });

  it("loads independent enabled bundle MCP configs in parallel waves", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    const originalReadFile = fsCallback.readFile.bind(fsCallback) as (
      fd: unknown,
      options: unknown,
      callback: unknown,
    ) => void;
    const pendingReads: Array<{
      released: boolean;
      release: () => void;
    }> = [];
    const waiters: Array<() => void> = [];
    const notifyReadQueued = () => {
      for (const waiter of waiters.splice(0, waiters.length)) {
        waiter();
      }
    };
    const waitForReadCount = async (count: number) => {
      while (pendingReads.length < count) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    };
    const releaseReads = (reads: Array<{ released: boolean; release: () => void }>) => {
      for (const read of reads) {
        if (read.released) {
          continue;
        }
        read.released = true;
        read.release();
      }
    };
    const readSpy = vi.spyOn(fsCallback, "readFile").mockImplementation(((
      fd: unknown,
      options: unknown,
      callback: unknown,
    ) => {
      // The async loader reads from boundary-verified file descriptors. Holding
      // callbacks here gives the test exact control over "slow" plugin files:
      // sequential code would queue one read at a time, while parallel code
      // queues every independent plugin read before the first one completes.
      pendingReads.push({
        released: false,
        release: () => {
          originalReadFile(fd, options, callback);
        },
      });
      notifyReadQueued();
    }) as typeof fsCallback.readFile);

    try {
      const homeDir = await createTempDir("openclaw-bundle-parallel-home-");
      const workspaceDir = await createTempDir("openclaw-bundle-parallel-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const entries: NonNullable<OpenClawConfig["plugins"]>["entries"] = {};
      for (const suffix of ["alpha", "bravo", "charlie"]) {
        const pluginId = `parallel-${suffix}`;
        entries[pluginId] = { enabled: true };
        const pluginRoot = path.join(homeDir, ".openclaw", "extensions", pluginId);
        await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
        await fs.writeFile(
          path.join(pluginRoot, ".claude-plugin", "plugin.json"),
          `${JSON.stringify({ name: pluginId }, null, 2)}\n`,
          "utf-8",
        );
        await fs.writeFile(
          path.join(pluginRoot, ".mcp.json"),
          `${JSON.stringify(
            {
              mcpServers: {
                [`${suffix}Probe`]: {
                  command: "node",
                  args: [`./${suffix}.mjs`],
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf-8",
        );
      }

      const loadedPromise = loadEnabledBundleMcpConfigAsync({
        workspaceDir,
        cfg: {
          plugins: {
            entries,
          },
        },
      });

      await waitForReadCount(3);
      expect(pendingReads.filter((read) => !read.released)).toHaveLength(3);
      releaseReads(pendingReads.slice(0, 3));

      await waitForReadCount(6);
      expect(pendingReads.slice(3).filter((read) => !read.released)).toHaveLength(3);
      releaseReads(pendingReads.slice(3));

      const loaded = await loadedPromise;
      expect(Object.keys(loaded.config.mcpServers).toSorted()).toEqual([
        "alphaProbe",
        "bravoProbe",
        "charlieProbe",
      ]);
    } finally {
      releaseReads(pendingReads);
      readSpy.mockRestore();
      env.restore();
    }
  });
});
