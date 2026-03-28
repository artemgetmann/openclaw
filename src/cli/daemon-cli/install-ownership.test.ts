import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSharedGatewayInstallOwnershipConflict } from "./install-ownership.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("detectSharedGatewayInstallOwnershipConflict", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (!target) {
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical targets for the default shared gateway even during explicit takeover", async () => {
    const homeDir = makeTempDir("openclaw-home-");
    const canonicalRepo = path.join(homeDir, "Programming_Projects", "openclaw");
    const otherRepo = makeTempDir("openclaw-other-");
    cleanupPaths.push(otherRepo, homeDir);

    fs.mkdirSync(path.join(canonicalRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "dist", "index.js"), "// canonical\n");
    fs.mkdirSync(path.join(otherRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(otherRepo, "dist", "index.js"), "// drifted\n");

    const conflict = await detectSharedGatewayInstallOwnershipConflict({
      env: { HOME: homeDir },
      service: {
        label: "Gateway",
        readCommand: async () => null,
      } as never,
      allowSharedServiceTakeover: true,
      programArguments: [
        process.execPath,
        path.join(otherRepo, "dist", "index.js"),
        "gateway",
        "--port",
        "18789",
      ],
    });

    expect(conflict?.message).toContain("canonical main runtime");
    expect(conflict?.hints).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join(otherRepo, "dist", "index.js")),
        expect.stringContaining(path.join(canonicalRepo, "dist", "index.js")),
      ]),
    );
  });

  it("still reports shared-service ownership drift when the proposed target is canonical", async () => {
    const homeDir = makeTempDir("openclaw-home-");
    const canonicalRepo = path.join(homeDir, "Programming_Projects", "openclaw");
    cleanupPaths.push(homeDir);

    fs.mkdirSync(path.join(canonicalRepo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(canonicalRepo, "dist", "index.js"), "// canonical\n");

    const conflict = await detectSharedGatewayInstallOwnershipConflict({
      env: { HOME: homeDir },
      service: {
        label: "Gateway",
        readCommand: async () => ({
          programArguments: [
            process.execPath,
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
        }),
      } as never,
      programArguments: [
        process.execPath,
        path.join(canonicalRepo, "dist", "index.js"),
        "gateway",
        "--port",
        "18789",
      ],
      workingDirectory: canonicalRepo,
      environment: {
        OPENCLAW_STATE_DIR: path.join(homeDir, ".openclaw"),
        OPENCLAW_CONFIG_PATH: path.join(homeDir, ".openclaw", "openclaw.json"),
        OPENCLAW_GATEWAY_PORT: "18789",
      },
    });

    expect(conflict?.message).toContain("default shared gateway service already belongs");
    expect(conflict?.hints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Current entrypoint"),
        expect.stringContaining("--allow-shared-service-takeover"),
      ]),
    );
  });
});
