import { describe, expect, it } from "vitest";
import {
  parseAgentDesktopApps,
  parseAgentDesktopSnapshot,
  parseAgentDesktopWindows,
} from "./agent-desktop-runtime.js";

describe("parseAgentDesktopSnapshot", () => {
  it("flattens agent-desktop data.tree nodes that use ref_id", () => {
    const snapshot = parseAgentDesktopSnapshot(
      {
        command: "snapshot",
        data: {
          app: "Safari",
          snapshot_id: "s123",
          window: { id: "w-99", title: "X / Home" },
          tree: {
            role: "window",
            name: "X / Home",
            children: [
              {
                ref_id: "@e1",
                role: "textfield",
                name: "Post text",
                value: "",
                bounds: { x: 10, y: 20, width: 300, height: 40 },
              },
              {
                role: "staticText",
                value: "Claude replied with a summary.",
              },
              {
                role: "group",
                children: [
                  {
                    ref_id: "@e2",
                    role: "button",
                    description: "Send",
                  },
                ],
              },
            ],
          },
        },
      },
      { appName: "Safari", windowTitle: "X" },
    );

    expect(snapshot.id).toBe("s123");
    expect(snapshot.appName).toBe("Safari");
    expect(snapshot.windowId).toBe("w-99");
    expect(snapshot.windowTitle).toBe("X / Home");
    expect(snapshot.elements).toEqual([
      {
        ref: "@e1",
        snapshotId: "s123",
        role: "textfield",
        name: "Post text",
        title: "",
        label: "Post text",
        description: "",
        value: "",
        bounds: { x: 10, y: 20, width: 300, height: 40 },
        appName: "Safari",
        windowTitle: "X / Home",
      },
      {
        ref: "@e2",
        snapshotId: "s123",
        role: "button",
        name: "",
        title: "",
        label: "Send",
        description: "Send",
        value: "",
        bounds: undefined,
        appName: "Safari",
        windowTitle: "X / Home",
      },
    ]);
    expect(snapshot.visibleText).toContain("Claude replied with a summary.");
    expect(snapshot.visibleText).toContain("Send");
  });
});

describe("parseAgentDesktopApps", () => {
  it("marks the focused app using agent-desktop v2 list-windows output", () => {
    const apps = parseAgentDesktopApps(
      {
        command: "list-apps",
        data: {
          apps: [
            { name: "Terminal", pid: 123 },
            { name: "Claude", pid: 456 },
          ],
        },
        ok: true,
      },
      {
        command: "list-windows",
        data: [
          { app_name: "Terminal", id: "w-1", is_focused: true, pid: 123, title: "tmux" },
          { app_name: "Claude", id: "w-2", is_focused: false, pid: 456, title: "Claude" },
        ],
        ok: true,
      },
    );

    expect(apps).toEqual([
      {
        appName: "Terminal",
        pid: 123,
        frontmost: true,
        windows: [{ appName: "Terminal", focused: true, id: "w-1", pid: 123, title: "tmux" }],
      },
      {
        appName: "Claude",
        pid: 456,
        frontmost: false,
        windows: [{ appName: "Claude", focused: false, id: "w-2", pid: 456, title: "Claude" }],
      },
    ]);
  });

  it("still returns apps when focused-window telemetry is unavailable", () => {
    const apps = parseAgentDesktopApps({
      command: "list-apps",
      data: {
        apps: [{ name: "Safari", pid: 789 }],
      },
      ok: true,
    });

    expect(apps).toEqual([{ appName: "Safari", pid: 789, frontmost: false, windows: [] }]);
  });

  it("parses focused windows from agent-desktop v2 list-windows output", () => {
    expect(
      parseAgentDesktopWindows({
        command: "list-windows",
        data: [{ app_name: "Safari", id: "w-99", is_focused: true, pid: 789, title: "Home / X" }],
        ok: true,
      }),
    ).toEqual([{ appName: "Safari", focused: true, id: "w-99", pid: 789, title: "Home / X" }]);
  });
});
