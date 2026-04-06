import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../config/config.js";

const { processGatewayAllowlistMock, runExecProcessMock } = vi.hoisted(() => ({
  processGatewayAllowlistMock: vi.fn(),
  runExecProcessMock: vi.fn(),
}));

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

import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools exec defaults", () => {
  it("defaults gateway exec to full/off when config does not narrow permissions", async () => {
    processGatewayAllowlistMock.mockReset();
    runExecProcessMock.mockReset();
    processGatewayAllowlistMock.mockResolvedValue({
      warnings: [],
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

    const config = {
      tools: {
        exec: {
          host: "gateway",
        },
      },
    } satisfies OpenClawConfig;

    const tools = createOpenClawCodingTools({
      config,
      sessionKey: "agent:main:telegram:group:-1003705521086:topic:1",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    if (!execTool) {
      throw new Error("exec tool missing");
    }

    await execTool.execute("tc1", { command: "pwd" });

    expect(processGatewayAllowlistMock).toHaveBeenCalledWith(
      expect.objectContaining({
        security: "full",
        ask: "off",
      }),
    );
  });
});
