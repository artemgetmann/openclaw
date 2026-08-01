import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerCodexCallbackCli } from "./callback-cli.js";

describe("codex-callback CLI", () => {
  it("takes native thread identity from the process environment and forwards a natural envelope", async () => {
    const program = new Command();
    program.exitOverride();
    const send = vi.fn(async () => ({ status: "delivered" }));
    const print = vi.fn();
    registerCodexCallbackCli({
      program,
      config: {},
      env: { CODEX_THREAD_ID: "thread-1" },
      send,
      print,
    });

    await program.parseAsync(
      [
        "node",
        "openclaw",
        "codex-callback",
        "--route-id",
        "route-1",
        "--capability",
        "capability-1",
        "--callback-id",
        "progress-1",
        "--sequence",
        "1",
        "--status",
        "progress",
        "--message",
        "The focused proof passed; review is next.",
        "--proof",
        "12 focused tests passed",
        "--work-continues",
        "true",
      ],
      { from: "node" },
    );

    expect(send).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        routeId: "route-1",
        capability: "capability-1",
        sourceThreadId: "thread-1",
        callbackId: "progress-1",
        sequence: 1,
        status: "progress",
        message: "The focused proof passed; review is next.",
        proof: ["12 focused tests passed"],
        workContinues: true,
      }),
    );
    expect(print).toHaveBeenCalledWith('{"status":"delivered"}');
  });

  it("fails closed when the native thread identity is unavailable", async () => {
    const program = new Command();
    program.exitOverride();
    registerCodexCallbackCli({
      program,
      config: {},
      env: {},
      send: vi.fn(),
      print: vi.fn(),
    });

    await expect(
      program.parseAsync(
        [
          "node",
          "openclaw",
          "codex-callback",
          "--route-id",
          "route-1",
          "--capability",
          "capability-1",
          "--callback-id",
          "progress-1",
          "--sequence",
          "1",
          "--status",
          "progress",
          "--message",
          "Useful progress.",
        ],
        { from: "node" },
      ),
    ).rejects.toThrow("CODEX_THREAD_ID");
  });
});
