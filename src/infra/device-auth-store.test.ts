import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth-store.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

function deviceAuthFile(stateDir: string): string {
  return path.join(stateDir, "identity", "device-auth.json");
}

function legacyDeviceAuthFile(stateDir: string): string {
  return path.join(path.dirname(stateDir), "identity", "device-auth.json");
}

async function writeAuthFile(
  filePath: string,
  payload: {
    deviceId: string;
    tokens: Record<string, { token: string; role: string; scopes: string[]; updatedAtMs: number }>;
  },
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ version: 1, deviceId: payload.deviceId, tokens: payload.tokens }, null, 2)}\n`,
    "utf8",
  );
}

describe("infra/device-auth-store", () => {
  it("stores and loads device auth tokens under the configured state dir", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      vi.spyOn(Date, "now").mockReturnValue(1234);

      const entry = storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "secret",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env: createEnv(stateDir),
      });

      expect(entry).toEqual({
        token: "secret",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        updatedAtMs: 1234,
      });
      expect(
        loadDeviceAuthToken({
          deviceId: "device-1",
          role: "operator",
          env: createEnv(stateDir),
        }),
      ).toEqual(entry);

      const raw = await fs.readFile(deviceAuthFile(stateDir), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual({
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: entry,
        },
      });
    });
  });

  it("keeps healthy canonical operator auth and repairs stale legacy mirror", async () => {
    await withTempDir("openclaw-device-auth-", async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const canonicalEntry = {
        token: "canonical-operator",
        role: "operator",
        scopes: ["operator.admin"],
        updatedAtMs: 10,
      };
      const nodeEntry = {
        token: "canonical-node",
        role: "node",
        scopes: ["node.invoke"],
        updatedAtMs: 11,
      };

      await writeAuthFile(deviceAuthFile(stateDir), {
        deviceId: "device-1",
        tokens: { operator: canonicalEntry, node: nodeEntry },
      });
      await writeAuthFile(legacyDeviceAuthFile(stateDir), {
        deviceId: "legacy-device",
        tokens: {
          operator: {
            token: "stale-legacy",
            role: "operator",
            scopes: ["operator.admin"],
            updatedAtMs: 1,
          },
        },
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toEqual(
        canonicalEntry,
      );
      expect(JSON.parse(await fs.readFile(legacyDeviceAuthFile(stateDir), "utf8"))).toEqual({
        version: 1,
        deviceId: "device-1",
        tokens: { operator: canonicalEntry, node: nodeEntry },
      });
    });
  });

  it("imports legacy auth once when canonical cannot authenticate", async () => {
    await withTempDir("openclaw-device-auth-", async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const legacyOperator = {
        token: "legacy-operator",
        role: "operator",
        scopes: ["operator.admin"],
        updatedAtMs: 21,
      };
      const legacyNode = {
        token: "legacy-node",
        role: "node",
        scopes: ["node.invoke"],
        updatedAtMs: 22,
      };

      await writeAuthFile(deviceAuthFile(stateDir), {
        deviceId: "other-device",
        tokens: {
          operator: {
            token: "wrong-canonical",
            role: "operator",
            scopes: ["operator.admin"],
            updatedAtMs: 1,
          },
        },
      });
      await writeAuthFile(legacyDeviceAuthFile(stateDir), {
        deviceId: "device-1",
        tokens: { operator: legacyOperator, node: legacyNode },
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toEqual(
        legacyOperator,
      );
      expect(JSON.parse(await fs.readFile(deviceAuthFile(stateDir), "utf8"))).toEqual({
        version: 1,
        deviceId: "device-1",
        tokens: { operator: legacyOperator, node: legacyNode },
      });
      expect(JSON.parse(await fs.readFile(legacyDeviceAuthFile(stateDir), "utf8"))).toEqual({
        version: 1,
        deviceId: "device-1",
        tokens: { operator: legacyOperator, node: legacyNode },
      });
    });
  });

  it("imports a missing legacy operator token without deleting canonical node auth", async () => {
    await withTempDir("openclaw-device-auth-", async (root) => {
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const nodeEntry = {
        token: "canonical-node",
        role: "node",
        scopes: ["node.invoke"],
        updatedAtMs: 31,
      };
      const legacyOperator = {
        token: "legacy-operator",
        role: "operator",
        scopes: ["operator.admin"],
        updatedAtMs: 32,
      };

      await writeAuthFile(deviceAuthFile(stateDir), {
        deviceId: "device-1",
        tokens: { node: nodeEntry },
      });
      await writeAuthFile(legacyDeviceAuthFile(stateDir), {
        deviceId: "device-1",
        tokens: { operator: legacyOperator },
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toEqual(
        legacyOperator,
      );
      const expected = {
        version: 1,
        deviceId: "device-1",
        tokens: { node: nodeEntry, operator: legacyOperator },
      };
      expect(JSON.parse(await fs.readFile(deviceAuthFile(stateDir), "utf8"))).toEqual(expected);
      expect(JSON.parse(await fs.readFile(legacyDeviceAuthFile(stateDir), "utf8"))).toEqual(
        expected,
      );
    });
  });

  it("rotates only operator auth while preserving node tokens in both files", async () => {
    await withTempDir("openclaw-device-auth-", async (root) => {
      vi.spyOn(Date, "now").mockReturnValue(4000);
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const nodeEntry = {
        token: "node-token",
        role: "node",
        scopes: ["node.invoke"],
        updatedAtMs: 3000,
      };

      await writeAuthFile(deviceAuthFile(stateDir), {
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "old-operator",
            role: "operator",
            scopes: ["operator.admin"],
            updatedAtMs: 1000,
          },
          node: nodeEntry,
        },
      });

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "new-operator",
        scopes: ["operator.read"],
        env,
      });

      const expected = {
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "new-operator",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 4000,
          },
          node: nodeEntry,
        },
      };
      expect(JSON.parse(await fs.readFile(deviceAuthFile(stateDir), "utf8"))).toEqual(expected);
      expect(JSON.parse(await fs.readFile(legacyDeviceAuthFile(stateDir), "utf8"))).toEqual(
        expected,
      );
    });
  });

  it("returns null for missing, invalid, or mismatched stores", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();

      await fs.mkdir(path.dirname(deviceAuthFile(stateDir)), { recursive: true });
      await fs.writeFile(deviceAuthFile(stateDir), '{"version":2,"deviceId":"device-1"}\n', "utf8");
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();

      await fs.writeFile(
        deviceAuthFile(stateDir),
        '{"version":1,"deviceId":"device-2","tokens":{"operator":{"token":"x","role":"operator","scopes":[],"updatedAtMs":1}}}\n',
        "utf8",
      );
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
    });
  });

  it("clears only the requested role and leaves unrelated tokens intact", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        token: "node-token",
        env,
      });

      clearDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "node", env })).toMatchObject({
        token: "node-token",
      });
    });
  });
});
