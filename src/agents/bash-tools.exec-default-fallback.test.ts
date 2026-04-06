import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { processGatewayAllowlistMock, runExecProcessMock } = vi.hoisted(() => ({
  processGatewayAllowlistMock: vi.fn(),
  runExecProcessMock: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const config = {
    tools: {
      exec: {
        host: "gateway",
      },
    },
  } satisfies OpenClawConfig;
  return {
    ...actual,
    loadConfig: vi.fn(() => config),
  };
});

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...actual,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  };
});

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: processGatewayAllowlistMock,
}));

vi.mock("./bash-tools.exec-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
    "./bash-tools.exec-runtime.js",
  );
  return {
    ...actual,
    runExecProcess: runExecProcessMock,
  };
});

const { createExecTool } = await import("./bash-tools.exec.js");

describe("createExecTool permission defaults fallback", () => {
  it("resolves gateway exec to full/off when callers omit security and ask", async () => {
    processGatewayAllowlistMock.mockReset();
    runExecProcessMock.mockReset();
    processGatewayAllowlistMock.mockResolvedValue({
      execCommandOverride: undefined,
    });
    runExecProcessMock.mockResolvedValue({
      startedAt: Date.now(),
      kill: vi.fn(),
      session: {
        id: "exec-session-1",
        cwd: "/tmp/test",
        tail: "",
        backgrounded: false,
      },
      promise: Promise.resolve({
        status: "completed",
        exitCode: 0,
        durationMs: 5,
        aggregated: "",
      }),
    });

    const tool = createExecTool({
      host: "gateway",
      sessionKey: "agent:main:telegram:group:-1003783709877:topic:3030",
    });

    await tool.execute("tc1", { command: "pwd" });

    expect(processGatewayAllowlistMock).toHaveBeenCalledWith(
      expect.objectContaining({
        security: "full",
        ask: "off",
      }),
    );
  });
});
