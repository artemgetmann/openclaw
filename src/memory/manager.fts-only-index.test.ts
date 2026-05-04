import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryIndexManager } from "./index.js";
import { createMemoryManagerOrThrow } from "./test-manager.js";

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available in test.",
  }),
}));

describe("memory manager FTS-only indexing", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "## Smoke memory\n\nFTS_ONLY_MEMORY_NEEDLE_20260503 is searchable without embeddings.\n",
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function buildConfig(): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "auto",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: true } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  it("indexes MEMORY.md for keyword search when no embedding provider is available", async () => {
    manager = await createMemoryManagerOrThrow(buildConfig());

    await manager.sync?.({ reason: "test", force: true });
    const results = await manager.search("FTS_ONLY_MEMORY_NEEDLE_20260503", {
      maxResults: 3,
      minScore: 0,
    });

    expect(results[0]?.path).toBe("MEMORY.md");
    expect(results[0]?.snippet).toContain("FTS_ONLY_MEMORY_NEEDLE_20260503");
  });
});
