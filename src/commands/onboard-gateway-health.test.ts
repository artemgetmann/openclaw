import { beforeEach, describe, expect, it, vi } from "vitest";

const waitForGatewayReachable = vi.fn();
const healthCommand = vi.fn();

vi.mock("./onboard-helpers.js", () => ({
  waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommand,
}));

describe("runGatewayReachabilityHealthWorkflow", () => {
  beforeEach(() => {
    waitForGatewayReachable.mockReset();
    healthCommand.mockReset();
  });

  it("returns the probe result when reachability fails", async () => {
    waitForGatewayReachable.mockResolvedValue({
      ok: false,
      detail: "socket closed",
    });

    const { runGatewayReachabilityHealthWorkflow } = await import("./onboard-gateway-health.js");
    const result = await runGatewayReachabilityHealthWorkflow({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      wsUrl: "ws://127.0.0.1:18789",
      deadlineMs: 15_000,
    });

    expect(result).toEqual({ ok: false, detail: "socket closed" });
    expect(healthCommand).not.toHaveBeenCalled();
  });

  it("runs health after the gateway becomes reachable", async () => {
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    healthCommand.mockResolvedValue(undefined);

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { runGatewayReachabilityHealthWorkflow } = await import("./onboard-gateway-health.js");
    const result = await runGatewayReachabilityHealthWorkflow({
      runtime,
      wsUrl: "ws://127.0.0.1:18789",
      token: "abc",
      deadlineMs: 45_000,
    });

    expect(waitForGatewayReachable).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      token: "abc",
      password: undefined,
      deadlineMs: 45_000,
    });
    expect(healthCommand).toHaveBeenCalledWith({ json: false, timeoutMs: 10_000 }, runtime);
    expect(result).toEqual({ ok: true });
  });

  it("delegates health failures when a handler is provided", async () => {
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    healthCommand.mockRejectedValue(new Error("health failed"));
    const onHealthFailure = vi.fn();

    const { runGatewayReachabilityHealthWorkflow } = await import("./onboard-gateway-health.js");
    const result = await runGatewayReachabilityHealthWorkflow({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      wsUrl: "ws://127.0.0.1:18789",
      deadlineMs: 15_000,
      onHealthFailure,
    });

    expect(onHealthFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(result).toEqual({ ok: true });
  });

  it("rethrows health failures when no handler is provided", async () => {
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    healthCommand.mockRejectedValue(new Error("health failed"));

    const { runGatewayReachabilityHealthWorkflow } = await import("./onboard-gateway-health.js");

    await expect(
      runGatewayReachabilityHealthWorkflow({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        wsUrl: "ws://127.0.0.1:18789",
        deadlineMs: 15_000,
      }),
    ).rejects.toThrow("health failed");
  });
});
