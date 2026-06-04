import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { detectChangedScope, listChangedPaths } =
  (await import("../../scripts/ci-changed-scope.mjs")) as unknown as {
    detectChangedScope: (paths: string[]) => {
      runNode: boolean;
      runMacos: boolean;
      runAndroid: boolean;
      runWindows: boolean;
      runSkillsPython: boolean;
      runCiScopeTests: boolean;
      runBrowserAgent: boolean;
    };
    listChangedPaths: (base: string, head?: string) => string[];
  };

const markerPaths: string[] = [];

afterEach(() => {
  for (const markerPath of markerPaths) {
    try {
      fs.unlinkSync(markerPath);
    } catch {}
  }
  markerPaths.length = 0;
});

describe("detectChangedScope", () => {
  it("fails safe when no paths are provided", () => {
    expect(detectChangedScope([])).toEqual({
      runNode: true,
      runMacos: true,
      runAndroid: true,
      runWindows: true,
      runSkillsPython: true,
      runCiScopeTests: true,
      runBrowserAgent: false,
    });
  });

  it("keeps all lanes off for docs-only changes", () => {
    expect(detectChangedScope(["docs/ci.md", "README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("enables node lane for node-relevant files", () => {
    expect(detectChangedScope(["src/plugins/runtime/index.ts"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("keeps node lane off for native-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
    expect(detectChangedScope(["apps/shared/OpenClawKit/Sources/Foo.swift"])).toEqual({
      runNode: false,
      runMacos: true,
      runAndroid: true,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("does not force native lanes for generated protocol model-only changes", () => {
    expect(detectChangedScope(["apps/macos/Sources/OpenClawProtocol/GatewayModels.swift"])).toEqual(
      {
        runNode: false,
        runMacos: false,
        runAndroid: false,
        runWindows: false,
        runSkillsPython: false,
        runCiScopeTests: false,
        runBrowserAgent: false,
      },
    );
    expect(
      detectChangedScope(["apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift"]),
    ).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("enables node lane for non-native non-doc files by fallback", () => {
    expect(detectChangedScope(["README.md"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });

    expect(detectChangedScope(["assets/icon.png"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("keeps windows lane off for non-runtime GitHub metadata files", () => {
    expect(detectChangedScope([".github/labeler.yml"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("runs Python skill tests when skills change", () => {
    expect(detectChangedScope(["skills/openai-image-gen/scripts/test_gen.py"])).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: true,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("keeps product lanes off for workflow-only changes", () => {
    expect(detectChangedScope([".github/workflows/ci.yml"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("runs only focused scope tests for the CI scope detector", () => {
    expect(detectChangedScope(["scripts/ci-changed-scope.mjs"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: true,
      runBrowserAgent: false,
    });

    expect(detectChangedScope(["src/scripts/ci-changed-scope.test.ts"])).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: true,
      runBrowserAgent: false,
    });
  });

  it("runs the focused browser-agent lane for browser-agent-only changes", () => {
    expect(
      detectChangedScope([
        "src/browser/chrome-mcp.ts",
        "src/browser/routes/agent.act.ts",
        "src/browser/routes/agent.existing-session.test.ts",
        "src/browser/chrome-mcp.test.ts",
        "src/agents/tools/browser-tool.ts",
        "src/agents/tools/browser-tool.schema.ts",
        "src/agents/tools/browser-tool.test.ts",
        "docs/agent-guides/browser-agent-e2e.md",
        "apps/macos/Sources/OpenClawProtocol/GatewayModels.swift",
        "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
      ]),
    ).toEqual({
      runNode: false,
      runMacos: false,
      runAndroid: false,
      runWindows: false,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: true,
    });
  });

  it("falls back to broad Node and Windows CI when browser-agent changes include unrelated runtime files", () => {
    expect(
      detectChangedScope(["src/browser/chrome-mcp.ts", "src/plugins/runtime/index.ts"]),
    ).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });

    expect(
      detectChangedScope(["src/browser/chrome-mcp.ts", "extensions/browser/package.json"]),
    ).toEqual({
      runNode: true,
      runMacos: false,
      runAndroid: false,
      runWindows: true,
      runSkillsPython: false,
      runCiScopeTests: false,
      runBrowserAgent: false,
    });
  });

  it("treats base and head as literal git args", () => {
    const markerPath = path.join(
      os.tmpdir(),
      `openclaw-ci-changed-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    markerPaths.push(markerPath);

    const injectedBase =
      process.platform === "win32"
        ? `HEAD & echo injected > "${markerPath}" & rem`
        : `HEAD; touch "${markerPath}" #`;

    expect(() => listChangedPaths(injectedBase, "HEAD")).toThrow();
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
