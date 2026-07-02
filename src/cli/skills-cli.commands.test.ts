import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const formatSkillsListMock = vi.fn();
const formatSkillInfoMock = vi.fn();
const formatSkillsCheckMock = vi.fn();
const syncBundledSkillsToSharedPersonalRootMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("../agents/skills/shared-personal-mirror.js", () => ({
  syncBundledSkillsToSharedPersonalRoot: syncBundledSkillsToSharedPersonalRootMock,
}));

vi.mock("./skills-cli.format.js", () => ({
  formatSkillsList: formatSkillsListMock,
  formatSkillInfo: formatSkillInfoMock,
  formatSkillsCheck: formatSkillsCheckMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerSkillsCli: typeof import("./skills-cli.js").registerSkillsCli;

beforeAll(async () => {
  ({ registerSkillsCli } = await import("./skills-cli.js"));
});

describe("registerSkillsCli", () => {
  const report = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/.skills",
    skills: [],
  };

  async function runCli(args: string[]) {
    const program = new Command();
    registerSkillsCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ gateway: {} });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue(report);
    formatSkillsListMock.mockReturnValue("skills-list-output");
    formatSkillInfoMock.mockReturnValue("skills-info-output");
    formatSkillsCheckMock.mockReturnValue("skills-check-output");
    syncBundledSkillsToSharedPersonalRootMock.mockResolvedValue({
      sourceDir: "/tmp/bundled",
      targetDir: "/tmp/shared",
      entries: [
        { name: "telegram-user", status: "copied", targetDir: "/tmp/shared/telegram-user" },
        { name: "wacli", status: "current", targetDir: "/tmp/shared/wacli" },
        {
          name: "local-only",
          status: "skipped-local",
          targetDir: "/tmp/shared/local-only",
        },
      ],
    });
  });

  it("runs list command with resolved report and formatter options", async () => {
    await runCli(["skills", "list", "--eligible", "--verbose", "--json"]);

    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace", {
      config: { gateway: {} },
    });
    expect(formatSkillsListMock).toHaveBeenCalledWith(
      report,
      expect.objectContaining({
        eligible: true,
        verbose: true,
        json: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("runs info command and forwards skill name", async () => {
    await runCli(["skills", "info", "peekaboo", "--json"]);

    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.objectContaining({ json: true }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("runs check command and writes formatter output", async () => {
    await runCli(["skills", "check"]);

    expect(formatSkillsCheckMock).toHaveBeenCalledWith(report, expect.any(Object));
    expect(runtime.log).toHaveBeenCalledWith("skills-check-output");
  });

  it("uses list formatter for default skills action", async () => {
    await runCli(["skills"]);

    expect(formatSkillsListMock).toHaveBeenCalledWith(report, {});
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("syncs bundled skills into the shared personal root", async () => {
    await runCli(["skills", "sync-shared"]);

    expect(syncBundledSkillsToSharedPersonalRootMock).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Shared skills root: /tmp/shared"),
    );
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("1 changed, 1 current"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Local overrides skipped: local-only"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("openclaw skills sync-shared --force <skill-name>"),
    );
  });

  it("forwards named forced skills to shared sync", async () => {
    await runCli(["skills", "sync-shared", "--force", "wacli", "--force", "skill-creator"]);

    expect(syncBundledSkillsToSharedPersonalRootMock).toHaveBeenCalledWith({
      forceSkillNames: ["wacli", "skill-creator"],
    });
  });

  it("syncs bundled skills into the shared personal root with json output", async () => {
    await runCli(["skills", "sync-shared", "--json"]);

    expect(syncBundledSkillsToSharedPersonalRootMock).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"targetDir": "/tmp/shared"'));
  });

  it("reports runtime errors when report loading fails", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config exploded");
    });

    await runCli(["skills", "list"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: config exploded");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });
});
