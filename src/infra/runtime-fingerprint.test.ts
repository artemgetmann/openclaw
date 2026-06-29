import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { formatRuntimeFingerprint, resolveRuntimeFingerprint } from "./runtime-fingerprint.js";

async function createRepoFixture(params?: { detached?: boolean; guiCapabilities?: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-fingerprint-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf8");
  await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
  if (params?.detached) {
    await fs.writeFile(path.join(root, ".git", "HEAD"), "0123456789abcdef\n", "utf8");
  } else {
    await fs.writeFile(
      path.join(root, ".git", "HEAD"),
      "ref: refs/heads/feature/runtime-id\n",
      "utf8",
    );
  }
  if (params?.guiCapabilities) {
    await fs.mkdir(path.join(root, "src", "agents", "tools"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "gui-control"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "agents", "tools", "gui-control-tool.ts"), "");
    await fs.writeFile(path.join(root, "src", "gui-control", "benchmark.ts"), '"native-apps"');
    await fs.writeFile(
      path.join(root, "src", "gui-control", "policy.ts"),
      'const DEFAULT_GUI_TASK_POLICY = { taskId: "trusted_local_gui_control" };',
    );
  }
  return root;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe("runtime-fingerprint", () => {
  it("derives branch, paths, and platform service label from the active worktree", async () => {
    const root = await createRepoFixture({ guiCapabilities: true });
    cleanupPaths.push(root);

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: "ops",
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "config", "openclaw.json"),
      },
      async () => {
        const fingerprint = resolveRuntimeFingerprint({
          cwd: path.join(root, "src"),
          platform: "darwin",
        });

        expect(fingerprint).toEqual({
          branch: "feature/runtime-id",
          worktree: root,
          stateDir: path.join(root, ".state"),
          configPath: path.join(root, "config", "openclaw.json"),
          serviceLabel: "ai.openclaw.ops",
          runtimePackageVersion: expect.any(String),
          appProductVersion: undefined,
          launchServiceVersion: undefined,
          runtimeCommit: undefined,
          runtimeSource: "source-checkout",
          guiCapabilities: {
            guiControl: true,
            guiBenchmarkNativeApps: true,
            trustedLocalDefault: true,
          },
          openClawVersion: expect.any(String),
        });
      },
    );
  });

  it("reports GUI capabilities from the fingerprinted runtime root", async () => {
    const root = await createRepoFixture();
    cleanupPaths.push(root);

    const fingerprint = resolveRuntimeFingerprint({
      cwd: root,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
      },
    });

    expect(fingerprint.guiCapabilities).toEqual({
      guiControl: false,
      guiBenchmarkNativeApps: false,
      trustedLocalDefault: false,
    });
  });

  it("detects GUI capabilities from packaged runtime chunks", async () => {
    const root = await createRepoFixture();
    cleanupPaths.push(root);
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "setup-surface-abc123.js"),
      [
        "//#region src/agents/tools/gui-control-tool.ts",
        "const DEFAULT_GUI_TASK_POLICY = {",
        '  taskId: "trusted_local_gui_control",',
        "};",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "dist", "gui-benchmark-cli-abc123.js"),
      'program.option("--task <task>", "native-apps");',
      "utf8",
    );

    const fingerprint = resolveRuntimeFingerprint({
      cwd: root,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
      },
    });

    expect(fingerprint.guiCapabilities).toEqual({
      guiControl: true,
      guiBenchmarkNativeApps: true,
      trustedLocalDefault: true,
    });
  });

  it("falls back to HEAD for detached checkouts", async () => {
    const root = await createRepoFixture({ detached: true });
    cleanupPaths.push(root);

    const fingerprint = resolveRuntimeFingerprint({
      cwd: root,
      env: {
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
      },
      platform: "linux",
    });

    expect(fingerprint.branch).toBe("HEAD");
    expect(fingerprint.serviceLabel).toBe("openclaw-gateway.service");
  });

  it("formats a stable key=value fingerprint line", () => {
    expect(
      formatRuntimeFingerprint({
        branch: "main",
        worktree: "/repo",
        stateDir: "/state",
        configPath: "/state/openclaw.json",
        serviceLabel: "ai.openclaw.gateway",
        appProductVersion: "2026.6.24",
        launchServiceVersion: "2026.6.24",
        runtimePackageVersion: "2026.3.16",
        runtimeCommit: "eabe9d8",
        runtimeSource: "sacred-main-checkout",
        guiCapabilities: {
          guiControl: true,
          guiBenchmarkNativeApps: true,
          trustedLocalDefault: true,
        },
        openClawVersion: "1.2.3",
      }),
    ).toBe(
      "branch=main worktree=/repo stateDir=/state configPath=/state/openclaw.json serviceLabel=ai.openclaw.gateway appProductVersion=2026.6.24 launchServiceVersion=2026.6.24 runtimePackageVersion=2026.3.16 runtimeCommit=eabe9d8 runtimeSource=sacred-main-checkout guiControl=yes guiBenchmark.nativeApps=yes trustedLocalDefault=yes openClawVersion=1.2.3",
    );
  });

  it("keeps app wrapper versions separate from runtime package proof", async () => {
    const root = await createRepoFixture();
    cleanupPaths.push(root);

    const fingerprint = resolveRuntimeFingerprint({
      cwd: root,
      env: {
        OPENCLAW_VERSION: "app-wrapper-version",
        OPENCLAW_SERVICE_VERSION: "launch-service-version",
        OPENCLAW_APP_VERSION: "product-version",
        OPENCLAW_STATE_DIR: path.join(root, ".state"),
      },
      platform: "darwin",
    });

    expect(fingerprint.openClawVersion).toBe("app-wrapper-version");
    expect(fingerprint.appProductVersion).toBe("product-version");
    expect(fingerprint.launchServiceVersion).toBe("launch-service-version");
    expect(fingerprint.runtimePackageVersion).not.toBe("app-wrapper-version");
    expect(fingerprint.runtimePackageVersion).not.toBe("launch-service-version");
  });
});
