import { describe, expect, it } from "vitest";
import {
  parseOpenComputerUseActionResult,
  parseOpenComputerUseApps,
  parseOpenComputerUseSnapshot,
  parseOpenComputerUseWindows,
} from "./open-computer-use-runtime.js";

describe("parseOpenComputerUseApps", () => {
  it("parses MCP text envelopes from list_apps", () => {
    const apps = parseOpenComputerUseApps({
      isError: false,
      content: [
        {
          type: "text",
          text: "Terminal — com.apple.Terminal [running, last-used=2026-06-12, uses=7780]\nClaude — com.anthropic.claudefordesktop [running, frontmost, uses=59]",
        },
      ],
    });

    expect(apps.map((app) => app.appName)).toEqual(["Terminal", "Claude"]);
    expect(apps[1]?.frontmost).toBe(true);
  });

  it("parses structured app and window arrays when OCU returns JSON", () => {
    const apps = parseOpenComputerUseApps(
      {
        structuredContent: {
          apps: [{ name: "TextEdit", pid: 42, frontmost: true }],
        },
      },
      {
        data: {
          windows: [{ id: "w-1", appName: "TextEdit", pid: 42, title: "Draft", focused: true }],
        },
      },
    );

    expect(apps).toEqual([
      {
        appName: "TextEdit",
        pid: 42,
        frontmost: true,
        windows: [
          {
            id: "w-1",
            appName: "TextEdit",
            pid: 42,
            title: "Draft",
            focused: true,
          },
        ],
      },
    ]);
  });
});

describe("parseOpenComputerUseWindows", () => {
  it("accepts common window envelope keys", () => {
    expect(
      parseOpenComputerUseWindows({
        result: {
          windows: [
            {
              window_id: 100,
              app_name: "Safari",
              processId: "123",
              name: "X / Home",
              is_focused: true,
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: "100",
        appName: "Safari",
        pid: 123,
        title: "X / Home",
        focused: true,
      },
    ]);
  });
});

describe("parseOpenComputerUseSnapshot", () => {
  it("walks AX tree shapes and preserves visible text", () => {
    const snapshot = parseOpenComputerUseSnapshot(
      {
        structuredContent: {
          id: "snap-1",
          app: "Claude",
          window: { id: "w-9", title: "Claude" },
          accessibility_tree: {
            role: "window",
            title: "Claude",
            children: [
              {
                role: "textField",
                element_index: 7,
                label: "Write a message",
                value: "",
                frame: { x: 10, y: 20, width: 300, height: 40 },
              },
              {
                role: "button",
                name: "Send",
                bounds: { left: 320, top: 20, right: 352, bottom: 52 },
              },
            ],
          },
        },
      },
      { appName: "Claude" },
    );

    expect(snapshot.id).toBe("snap-1");
    expect(snapshot.windowId).toBe("w-9");
    expect(snapshot.visibleText).toEqual(
      expect.arrayContaining(["Claude", "Write a message", "Send"]),
    );
    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "@7",
          role: "textField",
          label: "Write a message",
          bounds: { x: 10, y: 20, width: 300, height: 40 },
        }),
        expect.objectContaining({
          ref: "@1",
          role: "button",
          name: "Send",
          bounds: { x: 320, y: 20, width: 32, height: 32 },
        }),
      ]),
    );
  });

  it("parses JSON embedded in MCP text content", () => {
    const snapshot = parseOpenComputerUseSnapshot(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              snapshot_id: "snap-text",
              tree: [{ role: "button", index: 3, name: "OK" }],
            }),
          },
        ],
      },
      { appName: "System Settings" },
    );

    expect(snapshot.id).toBe("snap-text");
    expect(snapshot.elements).toEqual([
      expect.objectContaining({ ref: "@3", role: "button", name: "OK" }),
    ]);
  });

  it("parses live OCU accessibility text dumps into element refs", () => {
    const snapshot = parseOpenComputerUseSnapshot(
      {
        isError: false,
        content: [
          {
            type: "text",
            text: [
              "App=com.anthropic.claudefordesktop (pid 26436)",
              'Window: "Claude", App: Claude.',
              "0 standard window Claude, Secondary Actions: Raise",
              "\t121 text entry area (settable, string) Description: Write your prompt to Claude Write a message…",
              "\t124 button Copy Frame: x=320, y=20, w=32, h=32",
              "\t130 text Claude reply token JARVIS_OPEN_CU_TEST",
            ].join("\n"),
          },
        ],
      },
      { appName: "Claude" },
    );

    expect(snapshot.appName).toBe("Claude");
    expect(snapshot.windowTitle).toBe("Claude");
    expect(snapshot.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "@121",
          label: "text entry area (settable, string)",
          description: "Write your prompt to Claude Write a message…",
        }),
        expect.objectContaining({
          ref: "@124",
          bounds: { x: 320, y: 20, width: 32, height: 32 },
        }),
      ]),
    );
    expect(snapshot.visibleText).toEqual(
      expect.arrayContaining(["Write your prompt to Claude Write a message…"]),
    );
  });
});

describe("parseOpenComputerUseActionResult", () => {
  it("marks successful element-index actions as no clipboard and no raw coordinates by default", () => {
    expect(
      parseOpenComputerUseActionResult({ isError: false, content: [{ type: "text", text: "ok" }] }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        actionCount: 1,
        usedClipboard: false,
        rawCoordinatesUsed: false,
      }),
    );
  });

  it("preserves OCU error messages and safety telemetry", () => {
    const result = parseOpenComputerUseActionResult(
      {
        isError: true,
        content: [{ type: "text", text: "element not found" }],
        data: { usedClipboard: true, rawCoordinatesUsed: true },
      },
      false,
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        staleRef: true,
        usedClipboard: true,
        rawCoordinatesUsed: true,
        message: "element not found",
      }),
    );
  });
});
