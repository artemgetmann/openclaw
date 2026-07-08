import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { ProcessSession } from "./bash-process-registry.js";
import { buildProcessExitMonitorEvent, emitExecSystemEvent } from "./bash-tools.exec-runtime.js";

const requestHeartbeatNowMock = vi.mocked(requestHeartbeatNow);
const enqueueSystemEventMock = vi.mocked(enqueueSystemEvent);

describe("emitExecSystemEvent", () => {
  beforeEach(() => {
    requestHeartbeatNowMock.mockClear();
    enqueueSystemEventMock.mockClear();
  });

  it("scopes heartbeat wake to the event session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
      sessionKey: "agent:ops:main",
    });
  });

  it("keeps wake unscoped for non-agent session keys", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "exec-event",
    });
  });

  it("ignores events without a session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "  ",
      contextKey: "exec:run-2",
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});

describe("buildProcessExitMonitorEvent", () => {
  it("keeps routing keys stable and puts command/output data in evidence", () => {
    const session: ProcessSession = {
      id: "exec-session-1",
      command: "pnpm test",
      scopeKey: "agent:main",
      sessionKey: "agent:main:telegram:direct:user-1",
      processExitMonitorEvent: true,
      processExitMonitorEventEmitted: false,
      startedAt: 10,
      cwd: "/tmp/project",
      maxOutputChars: 1000,
      pendingStdout: [],
      pendingStderr: [],
      pendingStdoutChars: 0,
      pendingStderrChars: 0,
      totalOutputChars: 42,
      aggregated: "passed",
      tail: "passed",
      exitCode: 0,
      exitSignal: null,
      exited: true,
      truncated: false,
      backgrounded: true,
    };

    const event = buildProcessExitMonitorEvent({
      session,
      status: "completed",
      receivedAtMs: 123,
    });

    expect(event).toEqual({
      triggerKind: "process_exit",
      sourceType: "exec",
      sourceTarget: {
        sessionId: "exec-session-1",
        scopeKey: "agent:main",
        sessionKey: "agent:main:telegram:direct:user-1",
      },
      eventType: "completed",
      idempotencyKey: "exec:exec-session-1:exit",
      receivedAtMs: 123,
      evidence: {
        sessionId: "exec-session-1",
        command: "pnpm test",
        cwd: "/tmp/project",
        startedAt: 10,
        exitCode: 0,
        exitSignal: null,
        status: "completed",
        totalOutputChars: 42,
        truncated: false,
        tail: "passed",
      },
    });
  });
});
