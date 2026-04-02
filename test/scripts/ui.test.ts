import { describe, expect, it } from "vitest";
import {
  assertSafeWindowsShellArgs,
  resolveCorepackBinary,
  resolveRunner,
  shouldUseShellForCommand,
} from "../../scripts/ui.js";

describe("scripts/ui windows spawn behavior", () => {
  it("enables shell for Windows command launchers that require cmd.exe", () => {
    expect(
      shouldUseShellForCommand("C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.CMD", "win32"),
    ).toBe(true);
    expect(shouldUseShellForCommand("C:\\tools\\pnpm.bat", "win32")).toBe(true);
  });

  it("does not enable shell for non-shell launchers", () => {
    expect(shouldUseShellForCommand("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
    expect(shouldUseShellForCommand("/usr/local/bin/pnpm", "linux")).toBe(false);
  });

  it("allows safe forwarded args when shell mode is required on Windows", () => {
    expect(() =>
      assertSafeWindowsShellArgs(["run", "build", "--filter", "@openclaw/ui"], "win32"),
    ).not.toThrow();
  });

  it("rejects dangerous forwarded args when shell mode is required on Windows", () => {
    expect(() => assertSafeWindowsShellArgs(["run", "build", "evil&calc"], "win32")).toThrow(
      /unsafe windows shell argument/i,
    );
    expect(() => assertSafeWindowsShellArgs(["run", "build", "%PATH%"], "win32")).toThrow(
      /unsafe windows shell argument/i,
    );
  });

  it("does not reject args on non-windows platforms", () => {
    expect(() => assertSafeWindowsShellArgs(["contains&metacharacters"], "linux")).not.toThrow();
  });

  it("resolves a sibling corepack binary when pnpm is missing from PATH", () => {
    const nodeExecPath = "/tmp/node-v22/bin/node";
    const corepackPath = "/tmp/node-v22/bin/corepack";

    expect(
      resolveCorepackBinary({
        nodeExecPath,
        platform: "linux",
        existsSync: (candidate) => candidate === corepackPath,
      }),
    ).toEqual({
      corepackPath,
      nodeExecPath,
    });

    expect(
      resolveRunner({
        pnpmPath: null,
        nodeExecPath,
        platform: "linux",
        existsSync: (candidate) => candidate === corepackPath,
      }),
    ).toEqual({
      cmd: nodeExecPath,
      argvPrefix: [corepackPath, "pnpm"],
      envPatch: {
        PATH: expect.stringContaining("/tmp/node-v22/bin"),
      },
      kind: "corepack-pnpm",
    });
  });

  it("uses OPENCLAW_NODE_BIN when the launching node lacks a sibling corepack", () => {
    const launchingNode = "/tmp/node-v25/bin/node";
    const validatedNode = "/tmp/node-v22/bin/node";
    const validatedCorepack = "/tmp/node-v22/bin/corepack";

    expect(
      resolveRunner({
        pnpmPath: null,
        nodeExecPath: launchingNode,
        envNodeBin: validatedNode,
        platform: "linux",
        existsSync: (candidate) => candidate === validatedCorepack,
        realpathSync: (candidate) => candidate,
      }),
    ).toEqual({
      cmd: validatedNode,
      argvPrefix: [validatedCorepack, "pnpm"],
      envPatch: {
        PATH: expect.stringContaining("/tmp/node-v22/bin"),
      },
      kind: "corepack-pnpm",
    });
  });

  it("prefers pnpm when PATH already provides it", () => {
    expect(
      resolveRunner({
        pnpmPath: "/opt/homebrew/bin/pnpm",
        nodeExecPath: "/tmp/node-v22/bin/node",
        platform: "linux",
        existsSync: () => true,
      }),
    ).toEqual({
      cmd: "/opt/homebrew/bin/pnpm",
      argvPrefix: [],
      envPatch: undefined,
      kind: "pnpm",
    });
  });
});
