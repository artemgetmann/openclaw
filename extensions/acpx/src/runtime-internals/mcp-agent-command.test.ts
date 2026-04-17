import { describe, expect, it, vi } from "vitest";

const { spawnAndCollectMock } = vi.hoisted(() => ({
  spawnAndCollectMock: vi.fn(),
}));

vi.mock("./process.js", () => ({
  spawnAndCollect: spawnAndCollectMock,
}));

import { __testing, resolveAcpxAgentCommand } from "./mcp-agent-command.js";

describe("resolveAcpxAgentCommand", () => {
  it("threads stripProviderAuthEnvVars through the config show probe", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        agents: {
          codex: {
            command: "custom-codex",
          },
        },
      }),
      stderr: "",
      code: 0,
      error: null,
    });

    const command = await resolveAcpxAgentCommand({
      acpxCommand: "/plugin/node_modules/.bin/acpx",
      cwd: "/plugin",
      agent: "codex",
      stripProviderAuthEnvVars: true,
    });

    expect(command).toBe("custom-codex");
    expect(spawnAndCollectMock).toHaveBeenCalledWith(
      {
        command: "/plugin/node_modules/.bin/acpx",
        args: ["--cwd", "/plugin", "config", "show"],
        cwd: "/plugin",
        stripProviderAuthEnvVars: true,
      },
      undefined,
    );
  });
});

describe("buildMcpProxyAgentCommand", () => {
  it("falls back to the source helper when the bundled dist helper is missing", () => {
    const resolved = __testing.resolveMcpProxyPath(
      "file:///repo/dist/extensions/acpx/index.js",
      (candidate) => candidate === "/repo/extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
    );

    expect(resolved).toBe("/repo/extensions/acpx/src/runtime-internals/mcp-proxy.mjs");
  });

  it("escapes Windows-style proxy paths without double-escaping backslashes", () => {
    const quoted = __testing.quoteCommandPart(
      "C:\\repo\\extensions\\acpx\\src\\runtime-internals\\mcp-proxy.mjs",
    );

    expect(quoted).toBe(
      '"C:\\\\repo\\\\extensions\\\\acpx\\\\src\\\\runtime-internals\\\\mcp-proxy.mjs"',
    );
    expect(quoted).not.toContain("\\\\\\");
  });
});
