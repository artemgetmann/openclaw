import { describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;

vi.mock("../../agents/skills.js", () => {
  return {
    resolveBundledAllowlist: (config: { skills?: { allowBundled?: string[] } }) =>
      config.skills?.allowBundled,
  };
});

vi.mock("../../agents/skills-status.js", () => {
  return {
    buildWorkspaceSkillStatus: () => ({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        {
          name: "wacli",
          source: "openclaw-bundled",
          bundled: true,
          skillKey: "wacli",
        },
      ],
    }),
  };
});

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => ({
      skills: {
        entries: {},
      },
    }),
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
  };
});

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "abc\r\ndef",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
  });

  it("allowlists bundled skills when enabling them", async () => {
    writtenConfig = null;

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "wacli",
        enabled: true,
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        allowBundled: ["wacli"],
        entries: {
          wacli: {
            enabled: true,
          },
        },
      },
    });
  });
});
