import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";

describe("resolveOAuthRefreshLockPath", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-refresh-lock-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps arbitrary provider and profile IDs inside the refresh-lock directory", () => {
    const resolved = resolveOAuthRefreshLockPath("../../openai", "../openai-codex:default");

    expect(path.dirname(resolved)).toBe(path.join(stateDir, "locks", "oauth-refresh"));
    expect(path.basename(resolved)).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("uses distinct deterministic paths for provider/profile pairs", () => {
    const first = resolveOAuthRefreshLockPath("openai-codex", "shared:default");

    expect(resolveOAuthRefreshLockPath("openai-codex", "shared:default")).toBe(first);
    expect(resolveOAuthRefreshLockPath("anthropic", "shared:default")).not.toBe(first);
    expect(resolveOAuthRefreshLockPath("openai-codex", "other:default")).not.toBe(first);
  });
});
