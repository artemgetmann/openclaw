import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  consumeRestartSentinel,
  consumeRestartSentinelIfTerminal,
  formatDoctorNonInteractiveHint,
  formatRestartSentinelMessage,
  markRestartContinuationConsumed,
  markRestartContinuationFailed,
  readRestartSentinel,
  resolveRestartSentinelPath,
  summarizeRestartSentinel,
  trimLogTail,
  updateRestartSentinel,
  writeRestartSentinel,
} from "./restart-sentinel.js";

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => mockSpawn(...args),
  };
});

describe("restart sentinel", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempDir: string;

  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sentinel-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue({ unref: vi.fn() });
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes and consumes a sentinel", async () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
      stats: { mode: "git" },
    };
    const filePath = await writeRestartSentinel(payload);
    expect(filePath).toBe(resolveRestartSentinelPath());

    const read = await readRestartSentinel();
    expect(read?.payload.kind).toBe("update");

    const consumed = await consumeRestartSentinel();
    expect(consumed?.payload.sessionKey).toBe(payload.sessionKey);

    const empty = await readRestartSentinel();
    expect(empty).toBeNull();
  });

  it.each([
    {
      kind: "config-apply" as const,
      status: "ok" as const,
      expectsOperation: true,
      label: "config apply ok",
    },
    {
      kind: "config-patch" as const,
      status: "ok" as const,
      expectsOperation: true,
      label: "config patch ok",
    },
    {
      kind: "update" as const,
      status: "ok" as const,
      expectsOperation: true,
      label: "update ok",
    },
    {
      kind: "restart" as const,
      status: "requested" as const,
      expectsOperation: true,
      label: "restart requested",
    },
    {
      kind: "config-apply" as const,
      status: "error" as const,
      expectsOperation: false,
      label: "config apply failed",
    },
    {
      kind: "config-patch" as const,
      status: "error" as const,
      expectsOperation: false,
      label: "config patch failed",
    },
    {
      kind: "update" as const,
      status: "error" as const,
      expectsOperation: false,
      label: "update failed",
    },
    {
      kind: "update" as const,
      status: "skipped" as const,
      expectsOperation: false,
      label: "update skipped",
    },
    {
      kind: "restart" as const,
      status: "error" as const,
      expectsOperation: false,
      label: "restart failed",
    },
  ])("builds restart operations only for restart-producing payloads: $label", async (fixture) => {
    const env = {
      OPENCLAW_STATE_DIR: tempDir,
      OPENCLAW_GATEWAY_PORT: "18789",
      NODE_ENV: "development",
    };
    await writeRestartSentinel(
      {
        kind: fixture.kind,
        status: fixture.status,
        ts: Date.now(),
        sessionKey: "agent:main:telegram:dm:+15555550123",
      } as const,
      env,
    );

    const read = await readRestartSentinel(env);
    if (fixture.expectsOperation) {
      expect(read?.operation).toBeDefined();
      expect(read?.operation?.id).toBeTruthy();
      expect(read?.operation?.delivery.receipt).toBe("pending");
      expect(read?.operation?.delivery.continuation).toBe("pending");
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } else {
      expect(read?.operation).toBeUndefined();
      expect(mockSpawn).toHaveBeenCalledTimes(0);
    }
  });

  it.each([
    { cleanup: "terminal", consume: false },
    { cleanup: "consumed", consume: true },
  ])(
    "exits the in-process watcher without a marker after startup cleanup: $cleanup",
    async ({ consume }) => {
      const env = {
        OPENCLAW_STATE_DIR: tempDir,
        OPENCLAW_GATEWAY_PORT: "18789",
        NODE_ENV: "development",
      };
      await writeRestartSentinel(
        {
          kind: "config-apply",
          status: "ok",
          ts: Date.now(),
          sessionKey: "agent:main:telegram:dm:+15555550123",
        },
        env,
      );
      const operation = (await readRestartSentinel(env))?.operation;
      expect(operation).toBeDefined();
      if (!operation) {
        throw new Error("restart operation was not created");
      }
      const markerPath = path.join(tempDir, `restart-recovery-${operation.id}.json`);

      const spawnedCall = mockSpawn.mock.calls.at(-1);
      expect(spawnedCall).toBeDefined();
      const [, watcherArgs] = spawnedCall as [
        string,
        string[],
        { env: Record<string, string | undefined> },
      ];
      expect(Array.isArray(watcherArgs)).toBe(true);
      const [flag, script, ...scriptArgs] = watcherArgs;
      expect(flag).toBe("-e");
      expect(typeof script).toBe("string");

      const watcher = new Promise<void>((resolve, reject) => {
        execFile(process.execPath, [flag, script, ...scriptArgs], { env }, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      // Let the child observe the active operation and enter its old-PID wait.
      await new Promise((resolve) => setTimeout(resolve, 25));

      await updateRestartSentinel(
        (current) => ({
          ...current,
          operation: current.operation
            ? {
                ...current.operation,
                delivery: {
                  ...current.operation.delivery,
                  receipt: "delivered",
                  continuation: "delivered",
                },
              }
            : undefined,
        }),
        env,
      );
      if (consume) {
        await expect(consumeRestartSentinelIfTerminal(operation.id, env)).resolves.toBe(true);
      }
      await watcher;
      await expect(fs.stat(markerPath)).rejects.toThrow();

      const reconciledSentinel = await readRestartSentinel(env);
      if (consume) {
        expect(reconciledSentinel).toBeNull();
      } else {
        expect(reconciledSentinel?.operation?.delivery).toEqual(
          expect.objectContaining({ receipt: "delivered", continuation: "delivered" }),
        );
      }
    },
  );

  it("drops invalid sentinel payloads", async () => {
    const filePath = resolveRestartSentinelPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "not-json", "utf-8");

    const read = await readRestartSentinel();
    expect(read).toBeNull();

    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("drops structurally invalid sentinel payloads", async () => {
    const filePath = resolveRestartSentinelPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 2, payload: null }), "utf-8");

    await expect(readRestartSentinel()).resolves.toBeNull();
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("formatRestartSentinelMessage uses custom message when present", () => {
    const payload = {
      kind: "config-apply" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Config updated successfully",
    };
    expect(formatRestartSentinelMessage(payload)).toBe("Config updated successfully");
  });

  it("formatRestartSentinelMessage falls back to summary when no message", () => {
    const payload = {
      kind: "update" as const,
      status: "ok" as const,
      ts: Date.now(),
      stats: { mode: "git" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
    expect(result).toContain("update");
    expect(result).toContain("ok");
  });

  it("formatRestartSentinelMessage falls back to summary for blank message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "   ",
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Gateway restart");
  });

  it("formats summary, distinct reason, and doctor hint together", () => {
    const payload = {
      kind: "config-patch" as const,
      status: "error" as const,
      ts: Date.now(),
      message: "Patch failed",
      doctorHint: "Run openclaw doctor",
      stats: { mode: "patch", reason: "validation failed" },
    };

    expect(formatRestartSentinelMessage(payload)).toBe(
      [
        "Gateway restart config-patch error (patch)",
        "Patch failed",
        "Reason: validation failed",
        "Run openclaw doctor",
      ].join("\n"),
    );
  });

  it("trims log tails", () => {
    const text = "a".repeat(9000);
    const trimmed = trimLogTail(text, 8000);
    expect(trimmed?.length).toBeLessThanOrEqual(8001);
    expect(trimmed?.startsWith("…")).toBe(true);
  });

  it("formats restart messages without volatile timestamps", () => {
    const payloadA = {
      kind: "restart" as const,
      status: "requested" as const,
      ts: 100,
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart", phase: "requested" as const },
    };
    const payloadB = { ...payloadA, ts: 200 };
    const textA = formatRestartSentinelMessage(payloadA);
    const textB = formatRestartSentinelMessage(payloadB);
    expect(textA).toBe(textB);
    expect(textA).toContain("Gateway restart restart requested");
    expect(textA).not.toContain('"ts"');
  });

  it("marks only the matching session continuation consumed", async () => {
    await writeRestartSentinel({
      kind: "restart",
      status: "requested",
      ts: Date.now(),
      sessionKey: "agent:main:telegram:dm:123",
    });
    const operationId = (await readRestartSentinel())?.operation?.id;
    expect(operationId).toBeTruthy();
    await updateRestartSentinel((current) => ({
      ...current,
      operation: current.operation
        ? {
            ...current.operation,
            delivery: { ...current.operation.delivery, continuation: "delivering" },
          }
        : undefined,
    }));

    await expect(
      markRestartContinuationConsumed({
        sessionKey: "agent:main:telegram:dm:other",
        contextKeys: [`restart:${operationId}`],
      }),
    ).resolves.toBe(false);
    await expect(
      markRestartContinuationConsumed({
        sessionKey: "agent:main:telegram:dm:123",
        contextKeys: [`restart:${operationId}`],
      }),
    ).resolves.toBe(true);
    expect((await readRestartSentinel())?.operation?.delivery.continuation).toBe("delivered");
  });

  it("consumes the sentinel after receipt delivery and continuation completion are terminal", async () => {
    await writeRestartSentinel({
      kind: "restart",
      status: "requested",
      ts: Date.now(),
      sessionKey: "agent:main:telegram:dm:123",
    });
    const operationId = (await readRestartSentinel())?.operation?.id;
    expect(operationId).toBeTruthy();
    await updateRestartSentinel((current) => ({
      ...current,
      operation: current.operation
        ? {
            ...current.operation,
            delivery: {
              ...current.operation.delivery,
              receipt: "delivered",
              continuation: "delivering",
            },
          }
        : undefined,
    }));

    await expect(
      markRestartContinuationConsumed({
        sessionKey: "agent:main:telegram:dm:123",
        contextKeys: [`restart:${operationId}`],
      }),
    ).resolves.toBe(true);
    await expect(readRestartSentinel()).resolves.toBeNull();
  });

  it("restores failed continuation state only before the operation expires", async () => {
    await writeRestartSentinel({
      kind: "restart",
      status: "requested",
      ts: Date.now(),
      sessionKey: "agent:main:telegram:dm:123",
    });
    const operationId = (await readRestartSentinel())?.operation?.id;
    expect(operationId).toBeTruthy();
    await updateRestartSentinel((current) => ({
      ...current,
      operation: current.operation
        ? {
            ...current.operation,
            delivery: { ...current.operation.delivery, continuation: "delivering" },
          }
        : undefined,
    }));

    await expect(
      markRestartContinuationFailed({
        sessionKey: "agent:main:telegram:dm:123",
        contextKeys: [`restart:${operationId}`],
        error: "agent execution failed",
      }),
    ).resolves.toBe(`restart:${operationId}`);
    expect((await readRestartSentinel())?.operation?.delivery).toEqual(
      expect.objectContaining({
        continuation: "pending",
        lastError: "agent execution failed",
      }),
    );

    await updateRestartSentinel((current) => ({
      ...current,
      operation: current.operation
        ? {
            ...current.operation,
            expiresAt: Date.now() - 1,
            delivery: { ...current.operation.delivery, continuation: "delivering" },
          }
        : undefined,
    }));
    await expect(
      markRestartContinuationFailed({
        sessionKey: "agent:main:telegram:dm:123",
        contextKeys: [`restart:${operationId}`],
        error: "agent execution failed again",
      }),
    ).resolves.toBeNull();
    expect((await readRestartSentinel())?.operation?.delivery).toEqual(
      expect.objectContaining({
        continuation: "skipped",
        lastError: "restart operation expired after continuation failure",
      }),
    );
  });

  it("summarizes restart payloads and trims log tails without trailing whitespace", () => {
    expect(
      summarizeRestartSentinel({
        kind: "update",
        status: "skipped",
        ts: 1,
      }),
    ).toBe("Gateway restart update skipped");
    expect(trimLogTail("hello\n")).toBe("hello");
    expect(trimLogTail(undefined)).toBeNull();
  });
});

describe("restart sentinel message dedup", () => {
  it("omits duplicate Reason: line when stats.reason matches message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Applying config changes",
      stats: { mode: "gateway.restart", reason: "Applying config changes" },
    };
    const result = formatRestartSentinelMessage(payload);
    // The message text should appear exactly once, not duplicated as "Reason: ..."
    const occurrences = result.split("Applying config changes").length - 1;
    expect(occurrences).toBe(1);
    expect(result).not.toContain("Reason:");
  });

  it("keeps Reason: line when stats.reason differs from message", () => {
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: Date.now(),
      message: "Restart requested by /restart",
      stats: { mode: "gateway.restart", reason: "/restart" },
    };
    const result = formatRestartSentinelMessage(payload);
    expect(result).toContain("Restart requested by /restart");
    expect(result).toContain("Reason: /restart");
  });

  it("formats the non-interactive doctor command", () => {
    expect(formatDoctorNonInteractiveHint({ PATH: "/usr/bin:/bin" })).toContain(
      "openclaw doctor --non-interactive",
    );
  });
});
