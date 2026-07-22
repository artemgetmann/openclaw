import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OpenComputerUseRuntime,
  formatOpenComputerUseTccRecoveryGuidance,
  parseOpenComputerUseActionResult,
  parseOpenComputerUseApps,
  parseOpenComputerUseSnapshot,
  parseOpenComputerUseVirtualPointerEvidence,
  parseOpenComputerUseWindows,
  resolveOpenComputerUseCommand,
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
  it("parses live list_apps text into app-level frontmost placeholders", () => {
    expect(
      parseOpenComputerUseWindows({
        isError: false,
        content: [
          {
            type: "text",
            text: "Terminal — com.apple.Terminal [running, last-used=2026-06-12, uses=7780]\nClaude — com.anthropic.claudefordesktop [running, frontmost, uses=59]",
          },
        ],
      }),
    ).toEqual([
      {
        appName: "Terminal",
        focused: false,
      },
      {
        appName: "Claude",
        focused: true,
      },
    ]);
  });

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

  it("accepts focused flag aliases from structured windows", () => {
    expect(
      parseOpenComputerUseWindows({
        windows: [
          { appName: "Focused", focused: true },
          { appName: "IsFocused", is_focused: true },
          { appName: "Frontmost", frontmost: true },
          { appName: "Background" },
        ],
      }).map((window) => ({ appName: window.appName, focused: window.focused })),
    ).toEqual([
      { appName: "Focused", focused: true },
      { appName: "IsFocused", focused: true },
      { appName: "Frontmost", focused: true },
      { appName: "Background", focused: false },
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
                actions: ["AXPress"],
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
          secondaryActions: ["AXPress"],
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
              "\t124 button Send Secondary Actions: AXPress Frame: x=320, y=20, w=32, h=32",
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
          secondaryActions: ["AXPress"],
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

  it("uses the last batched tool result as the action result", () => {
    const result = parseOpenComputerUseActionResult(
      [
        {
          tool: "get_app_state",
          result: { isError: false, content: [{ type: "text", text: "state" }] },
        },
        {
          tool: "click",
          result: {
            isError: true,
            content: [{ type: "text", text: "invalidArguments(\"unknown element_index '71'\")" }],
          },
        },
      ],
      true,
      "ocuBatchedStateAction",
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        actionCount: 1,
        activationPath: "ocuBatchedStateAction",
        message: "invalidArguments(\"unknown element_index '71'\")",
      }),
    );
  });
});

describe("parseOpenComputerUseVirtualPointerEvidence", () => {
  it("accepts non-hidden visual cursor observations with cursor geometry", () => {
    const evidence = parseOpenComputerUseVirtualPointerEvidence(
      {
        phase: "idle",
        tipPosition: { x: 120, y: 240 },
        restingTipPosition: { x: 120, y: 240 },
        rotation: 0.02,
      },
      "/tmp/ocu-visual-cursor.json",
    );

    expect(evidence).toEqual(
      expect.objectContaining({
        present: true,
        source: "open-computer-use-visual-cursor-observation-file",
        evidencePath: "/tmp/ocu-visual-cursor.json",
        phase: "idle",
      }),
    );
  });

  it("fails closed for hidden or geometry-free observations", () => {
    expect(
      parseOpenComputerUseVirtualPointerEvidence({
        phase: "hidden",
        tipPosition: null,
        restingTipPosition: null,
      }),
    ).toEqual(
      expect.objectContaining({
        present: false,
        source: "open-computer-use-visual-cursor-observation-file",
      }),
    );
  });
});

describe("formatOpenComputerUseTccRecoveryGuidance", () => {
  it("explains stale dev-app TCC grants without auto-resetting them", () => {
    const guidance = formatOpenComputerUseTccRecoveryGuidance({
      command:
        "/Users/user/Applications/Open Computer Use (Dev).app/Contents/MacOS/OpenComputerUse",
      stderr: "Accessibility missing; ScreenCapture permission missing.",
    });

    expect(guidance).toContain("Exact app: /Users/user/Applications/Open Computer Use (Dev).app");
    expect(guidance).toContain("Bundle id: com.ifuryst.opencomputeruse.dev");
    expect(guidance).toContain("tccutil reset Accessibility com.ifuryst.opencomputeruse.dev");
    expect(guidance).toContain("tccutil reset ScreenCapture com.ifuryst.opencomputeruse.dev");
    expect(guidance).toContain("ad-hoc signed");
    expect(guidance).toContain("CDHash");
    expect(guidance).toContain("open '/Users/user/Applications/Open Computer Use (Dev).app'");
  });

  it("stays quiet for unrelated command failures", () => {
    expect(
      formatOpenComputerUseTccRecoveryGuidance({
        command: "open-computer-use",
        stderr: "network request failed",
      }),
    ).toBeUndefined();
  });

  it("does not invent a TCC identity for custom or PATH commands", () => {
    const guidance = formatOpenComputerUseTccRecoveryGuidance({
      command: "open-computer-use",
      stderr: "Accessibility permission missing.",
    });

    expect(guidance).toContain("Bundle identity could not be verified");
    expect(guidance).toContain("Do not run tccutil reset");
    expect(guidance).not.toContain("com.ifuryst.opencomputeruse.dev");
  });

  it("reports the packaged release app identity for permission failures", () => {
    const guidance = formatOpenComputerUseTccRecoveryGuidance({
      command:
        "/Applications/Jarvis.app/Contents/Resources/OpenClawRuntime/openclaw/native/Open Computer Use.app/Contents/MacOS/OpenComputerUse",
      stderr: "Accessibility permission missing.",
    });

    expect(guidance).toContain(
      "Exact app: /Applications/Jarvis.app/Contents/Resources/OpenClawRuntime/openclaw/native/Open Computer Use.app",
    );
    expect(guidance).toContain("Bundle id: com.ifuryst.opencomputeruse");
    expect(guidance).not.toContain("Dev builds are often ad-hoc signed");
  });
});

async function createPackagedOpenComputerUse(
  packageRoot: string,
  bundleIdentifier = "com.ifuryst.opencomputeruse",
): Promise<string> {
  const appRoot = path.join(packageRoot, "native", "Open Computer Use.app");
  const packagedCommand = path.join(appRoot, "Contents", "MacOS", "OpenComputerUse");
  await fs.mkdir(path.dirname(packagedCommand), { recursive: true });
  await fs.writeFile(packagedCommand, "");
  await fs.writeFile(
    path.join(appRoot, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist><dict>",
      "<key>CFBundleIdentifier</key>",
      `<string>${bundleIdentifier}</string>`,
      "</dict></plist>",
    ].join("\n"),
  );
  return packagedCommand;
}

describe("OpenComputerUseRuntime", () => {
  it("uses an explicit OCU command before discovery", () => {
    expect(
      resolveOpenComputerUseCommand("/tmp/custom-ocu", {
        HOME: "/tmp/home",
        OPENCLAW_OPEN_COMPUTER_USE_BIN: "/tmp/env-ocu",
      }),
    ).toBe("/tmp/custom-ocu");
  });

  it("uses the OCU env override before default app discovery", () => {
    expect(
      resolveOpenComputerUseCommand(
        undefined,
        {
          HOME: "/tmp/home",
          OPENCLAW_OPEN_COMPUTER_USE_BIN: "/tmp/env-ocu",
        },
        null,
      ),
    ).toBe("/tmp/env-ocu");
  });

  it("keeps packaged consumer resolution on the production app despite an env override", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-package-root-"));
    const packagedCommand = await createPackagedOpenComputerUse(packageRoot);

    expect(
      resolveOpenComputerUseCommand(
        undefined,
        {
          HOME: "/tmp/home",
          OPENCLAW_OPEN_COMPUTER_USE_BIN: "/tmp/env-ocu",
        },
        packageRoot,
      ),
    ).toBe(packagedCommand);
  });

  it("does not let an explicit Dev command override the packaged consumer app", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-package-root-"));
    const packagedCommand = await createPackagedOpenComputerUse(packageRoot);

    expect(
      resolveOpenComputerUseCommand(
        "/private/tmp/Open Computer Use Socket Test Dev v2.app/Contents/MacOS/OpenComputerUse",
        { OPENCLAW_ALLOW_DEV_OPEN_COMPUTER_USE: "1" },
        packageRoot,
      ),
    ).toBe(packagedCommand);
  });

  it("prefers the release app embedded in the resolved package root by default", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-package-root-"));
    const packagedCommand = await createPackagedOpenComputerUse(packageRoot);

    expect(
      resolveOpenComputerUseCommand(
        undefined,
        {
          HOME: "/tmp/home",
        },
        packageRoot,
      ),
    ).toBe(packagedCommand);
  });

  it("reads the nested OCU identity instead of an outer Jarvis app identity", async () => {
    const outerAppRoot = await fs.mkdtemp(path.join(os.tmpdir(), "Jarvis.app-"));
    const packageRoot = path.join(
      outerAppRoot,
      "Jarvis.app",
      "Contents",
      "Resources",
      "OpenClawRuntime",
      "openclaw",
    );
    await fs.mkdir(path.join(outerAppRoot, "Jarvis.app", "Contents"), { recursive: true });
    await fs.writeFile(
      path.join(outerAppRoot, "Jarvis.app", "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>ai.jarvis.mac</string></dict></plist>",
    );
    const packagedCommand = await createPackagedOpenComputerUse(packageRoot);

    expect(resolveOpenComputerUseCommand(undefined, {}, packageRoot)).toBe(packagedCommand);
  });

  it.runIf(process.platform === "darwin")(
    "validates the production identity from a binary Info.plist",
    async () => {
      const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-package-root-"));
      const packagedCommand = await createPackagedOpenComputerUse(packageRoot);
      const infoPlistPath = path.join(
        packageRoot,
        "native",
        "Open Computer Use.app",
        "Contents",
        "Info.plist",
      );
      execFileSync("/usr/bin/plutil", ["-convert", "binary1", infoPlistPath]);

      expect(resolveOpenComputerUseCommand(undefined, {}, packageRoot)).toBe(packagedCommand);
    },
  );

  it("rejects a packaged app whose Info.plist carries the Dev bundle identity", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-package-root-"));
    await createPackagedOpenComputerUse(packageRoot, "com.ifuryst.opencomputeruse.dev");

    expect(() => resolveOpenComputerUseCommand(undefined, {}, packageRoot)).toThrow(
      "expected com.ifuryst.opencomputeruse",
    );
  });

  it("fails closed when a packaged native payload is missing production OCU", async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-package-root-"));
    await fs.mkdir(path.join(packageRoot, "native"));

    expect(() => resolveOpenComputerUseCommand(undefined, {}, packageRoot)).toThrow(
      "refusing PATH or development fallback",
    );
  });

  it("does not auto-discover an installed dev app", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-command-test-"));
    const appCommand = path.join(
      tempDir,
      "Applications",
      "Open Computer Use (Dev).app",
      "Contents",
      "MacOS",
      "OpenComputerUse",
    );
    await fs.mkdir(path.dirname(appCommand), { recursive: true });
    await fs.writeFile(appCommand, "");

    expect(resolveOpenComputerUseCommand(undefined, { HOME: tempDir }, null)).toBe(
      "open-computer-use",
    );
  });

  it("rejects a Dev-named app override without explicit developer intent", () => {
    expect(() =>
      resolveOpenComputerUseCommand(
        "/private/tmp/Open Computer Use Socket Test Dev v2.app/Contents/MacOS/OpenComputerUse",
        {},
        null,
      ),
    ).toThrow("OPENCLAW_ALLOW_DEV_OPEN_COMPUTER_USE=1");
  });

  it("rejects a .dev bundle identity supplied through the environment", () => {
    expect(() =>
      resolveOpenComputerUseCommand(
        undefined,
        {
          OPENCLAW_OPEN_COMPUTER_USE_BIN:
            "/tmp/com.ifuryst.opencomputeruse.dev/Contents/MacOS/OpenComputerUse",
        },
        null,
      ),
    ).toThrow("explicit developer intent");
  });

  it("rejects a renamed app when Info.plist carries the Dev bundle identity", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-renamed-dev-"));
    const appRoot = path.join(tempDir, "Open Computer Use.app");
    const command = path.join(appRoot, "Contents", "MacOS", "OpenComputerUse");
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "");
    await fs.writeFile(
      path.join(appRoot, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.ifuryst.opencomputeruse.dev</string></dict></plist>",
    );

    expect(() => resolveOpenComputerUseCommand(command, {}, null)).toThrow(
      "explicit developer intent",
    );
  });

  it("allows an explicitly opted-in Dev helper for isolated engineering runs", () => {
    const devCommand =
      "/Users/user/Applications/Open Computer Use (Dev).app/Contents/MacOS/OpenComputerUse";

    expect(
      resolveOpenComputerUseCommand(
        devCommand,
        { OPENCLAW_ALLOW_DEV_OPEN_COMPUTER_USE: "1" },
        null,
      ),
    ).toBe(devCommand);
  });

  it("falls back to the PATH shim when OCU is not otherwise discoverable", () => {
    expect(
      resolveOpenComputerUseCommand(undefined, { HOME: "/path/that/does/not/exist" }, null),
    ).toBe("open-computer-use");
  });

  it("preserves stderr from failed OCU snapshot commands", async () => {
    const runtime = new OpenComputerUseRuntime({
      command: process.execPath,
      baseArgs: [
        "-e",
        [
          "console.error('Accessibility permission is required. Run `open-computer-use doctor`.');",
          "process.exit(3);",
        ].join(""),
      ],
    });

    await expect(runtime.observe({ appName: "TextEdit" })).rejects.toThrow(
      "Accessibility permission is required",
    );
  });

  it("fails closed when a permission error comes from an unknown helper identity", async () => {
    const runtime = new OpenComputerUseRuntime({
      command: process.execPath,
      baseArgs: [
        "-e",
        [
          "console.error('Accessibility missing; ScreenCapture permission missing.');",
          "process.exit(3);",
        ].join(""),
      ],
    });

    await expect(runtime.observe({ appName: "TextEdit" })).rejects.toThrow(
      "Bundle identity could not be verified",
    );
  });

  it("clicks element-index targets through direct OCU actions without raw coordinates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-runtime-test-"));
    const argsPath = path.join(tempDir, "argv.json");
    const runtime = new OpenComputerUseRuntime({
      command: process.execPath,
      baseArgs: [
        "-e",
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(1)));`,
          "console.log(JSON.stringify({ isError: false, content: [{ type: 'text', text: 'ok' }] }));",
        ].join(""),
      ],
    });

    const result = await runtime.click({
      ref: "@123",
      appName: "Claude",
      windowTitle: "Claude",
    });
    const argv = JSON.parse(await fs.readFile(argsPath, "utf8"));

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        usedClipboard: false,
        rawCoordinatesUsed: false,
        activationPath: "ocuDirectAction",
      }),
    );
    expect(argv).toEqual([
      "call",
      "click",
      "--args",
      JSON.stringify({ app: "Claude", window: "Claude", element_index: 123 }),
    ]);
  });

  it("maps secondary actions to direct OCU actions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-runtime-test-"));
    const argsPath = path.join(tempDir, "argv.json");
    const runtime = new OpenComputerUseRuntime({
      command: process.execPath,
      baseArgs: [
        "-e",
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(1)));`,
          "console.log(JSON.stringify({ isError: false, content: [{ type: 'text', text: 'ok' }] }));",
        ].join(""),
      ],
    });

    await runtime.performSecondaryAction(
      { ref: "@124", appName: "Claude", windowTitle: "Claude" },
      "AXPress",
    );
    const argv = JSON.parse(await fs.readFile(argsPath, "utf8"));

    expect(argv).toEqual([
      "call",
      "perform_secondary_action",
      "--args",
      JSON.stringify({
        app: "Claude",
        window: "Claude",
        element_index: 124,
        action: "AXPress",
      }),
    ]);
  });

  it("restores focus by raising the target app window through OCU secondary actions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-runtime-test-"));
    const callsPath = path.join(tempDir, "calls.json");
    const runtime = new OpenComputerUseRuntime({
      command: process.execPath,
      baseArgs: [
        "-e",
        [
          "const fs = require('node:fs');",
          `const callsPath = ${JSON.stringify(callsPath)};`,
          "const args = process.argv.slice(1);",
          "const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];",
          "calls.push(args);",
          "fs.writeFileSync(callsPath, JSON.stringify(calls));",
          "const tool = args[1];",
          "if (tool === 'get_app_state') {",
          "  console.log(JSON.stringify({ isError: false, content: [{ type: 'text', text: 'App=com.apple.Terminal (pid 42)\\nWindow: \"Terminal\", App: Terminal.\\n0 standard window Terminal, Secondary Actions: Raise' }] }));",
          "} else if (tool === 'perform_secondary_action') {",
          "  console.log(JSON.stringify({ isError: false, content: [{ type: 'text', text: 'raised' }] }));",
          "} else if (tool === 'list_apps') {",
          "  console.log(JSON.stringify({ isError: false, content: [{ type: 'text', text: 'Terminal — com.apple.Terminal [frontmost, running]\\nClaude — com.anthropic.claudefordesktop [running]' }] }));",
          "} else {",
          "  console.log(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'unexpected tool ' + tool }] }));",
          "}",
        ].join(""),
      ],
    });

    const result = await runtime.focusWindow({ appName: "Terminal", focused: true });
    const calls = JSON.parse(await fs.readFile(callsPath, "utf8"));

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        actionCount: 1,
        movedFocus: true,
      }),
    );
    expect(calls).toEqual([
      ["call", "get_app_state", "--args", JSON.stringify({ app: "Terminal" })],
      [
        "call",
        "perform_secondary_action",
        "--args",
        JSON.stringify({ app: "Terminal", window: "Terminal", element_index: 0, action: "Raise" }),
      ],
      ["call", "list_apps", "--args", JSON.stringify({})],
    ]);
  });

  it("fails closed when OCU does not expose a Raise action for the target app", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocu-runtime-test-"));
    const callsPath = path.join(tempDir, "calls.json");
    const runtime = new OpenComputerUseRuntime({
      command: process.execPath,
      baseArgs: [
        "-e",
        [
          "const fs = require('node:fs');",
          `const callsPath = ${JSON.stringify(callsPath)};`,
          "const args = process.argv.slice(1);",
          "const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];",
          "calls.push(args);",
          "fs.writeFileSync(callsPath, JSON.stringify(calls));",
          "console.log(JSON.stringify({ isError: false, content: [{ type: 'text', text: 'App=com.apple.Terminal (pid 42)\\nWindow: \"Terminal\", App: Terminal.\\n0 standard window Terminal' }] }));",
        ].join(""),
      ],
    });

    const result = await runtime.focusWindow({ appName: "Terminal", focused: true });
    const calls = JSON.parse(await fs.readFile(callsPath, "utf8"));

    expect(result).toEqual({
      ok: false,
      actionCount: 0,
      movedFocus: false,
      usedClipboard: false,
      rawCoordinatesUsed: false,
      message: "OpenComputerUse did not expose a Raise secondary action for Terminal.",
      raw: expect.objectContaining({
        unsupported: "focusWindow",
        reason: "missing-raise-action",
        target: { appName: "Terminal", focused: true },
      }),
    });
    expect(calls).toEqual([
      ["call", "get_app_state", "--args", JSON.stringify({ app: "Terminal" })],
    ]);
  });
});
