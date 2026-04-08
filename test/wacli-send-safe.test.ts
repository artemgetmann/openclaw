import { describe, expect, it, vi } from "vitest";
import {
  buildSendArgs,
  runOwnerSafeSend,
  type Flags,
} from "../skills/wacli/scripts/wacli-send-safe.ts";

function makeFlags(overrides: Partial<Flags> = {}): Flags {
  return {
    command: "text",
    json: false,
    storeDir: "/tmp/wacli-store",
    to: "+15555550123",
    message: "hello",
    timeoutMs: 1_000,
    settleMs: 1_000,
    graceMs: 1_000,
    ...overrides,
  } as Flags;
}

describe("wacli-send-safe", () => {
  it("builds the raw wacli send args for text", () => {
    expect(buildSendArgs(makeFlags())).toEqual([
      "--store",
      "/tmp/wacli-store",
      "send",
      "text",
      "--to",
      "+15555550123",
      "--message",
      "hello",
    ]);
  });

  it("builds the raw wacli send args for file", () => {
    expect(
      buildSendArgs(
        makeFlags({
          command: "file",
          file: "/tmp/report.pdf",
          caption: "agenda",
          message: undefined,
        }),
      ),
    ).toEqual([
      "--store",
      "/tmp/wacli-store",
      "send",
      "file",
      "--to",
      "+15555550123",
      "--file",
      "/tmp/report.pdf",
      "--caption",
      "agenda",
    ]);
  });

  it("pauses and restores the recorded owner around a send", async () => {
    const calls: Array<[string, string[]]> = [];
    let statusCalls = 0;
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, args]);
      if (args[0] === "status") {
        statusCalls += 1;
        if (statusCalls === 1) {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              ownerRunning: true,
              ownerCommandMatches: true,
              lockHeldByOwner: true,
              connected: true,
            }),
            stderr: "",
            timedOut: false,
          };
        }
        if (statusCalls === 2) {
          return {
            ok: true,
            exitCode: 0,
            stdout: JSON.stringify({
              ownerRunning: false,
              ownerCommandMatches: true,
              lockHeldByOwner: false,
              connected: false,
            }),
            stderr: "",
            timedOut: false,
          };
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: true,
            ownerCommandMatches: true,
            lockHeldByOwner: true,
            connected: true,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (args[0] === "stop") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: false,
            ownerCommandMatches: true,
            lockHeldByOwner: false,
            connected: false,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (args[0] === "ensure") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: true,
            ownerCommandMatches: true,
            lockHeldByOwner: true,
            connected: true,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: "sent",
        stderr: "",
        timedOut: false,
      };
    });

    const report = await runOwnerSafeSend(makeFlags(), {
      runCommand,
      sleep: async () => undefined,
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("sent_with_owner_restored");
    expect(report.ownerPaused).toBe(true);
    expect(report.ownerRestored).toBe(true);
    expect(calls.map(([, args]) => (args[0] === "--store" ? args[2] : args[0]))).toEqual([
      "status",
      "stop",
      "status",
      "send",
      "ensure",
      "status",
    ]);
  });

  it("sends directly when no recorded owner is running", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (args[0] === "status") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({
            ownerRunning: false,
            ownerCommandMatches: false,
            lockHeldByOwner: false,
            connected: false,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: "sent",
        stderr: "",
        timedOut: false,
      };
    });

    const report = await runOwnerSafeSend(makeFlags(), {
      runCommand,
      sleep: async () => undefined,
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("sent");
    expect(report.ownerPaused).toBe(false);
    expect(report.ownerRestored).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
