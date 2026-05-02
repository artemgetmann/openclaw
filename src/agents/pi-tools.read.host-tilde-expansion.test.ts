import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedEditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
};

type CapturedWriteOperations = {
  mkdir: (dir: string) => Promise<void>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  editOps: undefined as CapturedEditOperations | undefined,
  writeOps: undefined as CapturedWriteOperations | undefined,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createEditTool: (_cwd: string, options?: { operations?: CapturedEditOperations }) => {
      mocks.editOps = options?.operations;
      return {
        name: "edit",
        description: "test edit tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
    createWriteTool: (_cwd: string, options?: { operations?: CapturedWriteOperations }) => {
      mocks.writeOps = options?.operations;
      return {
        name: "write",
        description: "test write tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      };
    },
  };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./pi-tools.read.js");

describe("host tool tilde expansion", () => {
  let tmpDir = "";
  let osHome = "";
  let openclawHome = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-tilde-"));
    osHome = path.join(tmpDir, "os-home");
    openclawHome = path.join(tmpDir, "openclaw-home");
    await fs.mkdir(osHome, { recursive: true });
    await fs.mkdir(openclawHome, { recursive: true });
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("USERPROFILE", osHome);
    vi.stubEnv("OPENCLAW_HOME", openclawHome);
    mocks.editOps = undefined;
    mocks.writeOps = undefined;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    mocks.editOps = undefined;
    mocks.writeOps = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  function toTildePath(absolutePath: string): string {
    return absolutePath.replace(osHome, "~");
  }

  it("expands edit readFile ~ paths to OS home, not OPENCLAW_HOME", async () => {
    const testFile = path.join(osHome, "read.txt");
    await fs.writeFile(testFile, "OS home content", "utf8");

    createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });
    const content = await mocks.editOps!.readFile(toTildePath(testFile));

    expect(content.toString("utf8")).toBe("OS home content");
    await expect(fs.access(path.join(openclawHome, "read.txt"))).rejects.toBeDefined();
  });

  it("expands edit access ~ paths to OS home, not OPENCLAW_HOME", async () => {
    const testFile = path.join(osHome, "access.txt");
    await fs.writeFile(testFile, "exists", "utf8");

    createHostWorkspaceEditTool(openclawHome, { workspaceOnly: false });

    await expect(mocks.editOps!.access(toTildePath(testFile))).resolves.toBeUndefined();
    await expect(fs.access(path.join(openclawHome, "access.txt"))).rejects.toBeDefined();
  });

  it("expands writeFile ~ paths to OS home, not OPENCLAW_HOME", async () => {
    const testFile = path.join(osHome, "write.txt");

    createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
    await mocks.writeOps!.writeFile(toTildePath(testFile), "written via tilde");

    expect(await fs.readFile(testFile, "utf8")).toBe("written via tilde");
    await expect(fs.access(path.join(openclawHome, "write.txt"))).rejects.toBeDefined();
  });

  it("expands mkdir ~ paths to OS home, not OPENCLAW_HOME", async () => {
    const testDir = path.join(osHome, "created-dir");

    createHostWorkspaceWriteTool(openclawHome, { workspaceOnly: false });
    await mocks.writeOps!.mkdir(toTildePath(testDir));

    expect((await fs.stat(testDir)).isDirectory()).toBe(true);
    await expect(fs.access(path.join(openclawHome, "created-dir"))).rejects.toBeDefined();
  });
});
