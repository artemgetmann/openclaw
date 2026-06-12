import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ tools: { media: { audio: { enabled: true } } } })),
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
  transcribeAudioFile: vi.fn(),
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: mocks.resolveOpenClawAgentDir,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../media-understanding/transcribe-audio.js", () => ({
  transcribeAudioFile: mocks.transcribeAudioFile,
}));

const { mediaTranscribeCommand } = await import("./media.js");

describe("media commands", () => {
  let tempDir = "";
  const runtime: RuntimeEnv = {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-command-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("transcribes a local file through the configured media audio provider path", async () => {
    const filePath = path.join(tempDir, "voice.oga");
    await fs.writeFile(filePath, "audio");
    mocks.transcribeAudioFile.mockResolvedValueOnce({ text: "hello from voice" });

    await mediaTranscribeCommand(filePath, { json: true, mime: "audio/ogg" }, runtime);

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      cfg: { tools: { media: { audio: { enabled: true } } } },
      filePath,
      mime: "audio/ogg",
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"text": "hello from voice"'));
  });

  it("accepts --file as the path source for agent-safe command execution", async () => {
    const filePath = path.join(tempDir, "voice.oga");
    await fs.writeFile(filePath, "audio");
    mocks.transcribeAudioFile.mockResolvedValueOnce({ text: "from flag" });

    await mediaTranscribeCommand(undefined, { file: filePath }, runtime);

    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("from flag");
  });

  it("rejects missing file input before provider selection", async () => {
    await expect(mediaTranscribeCommand(undefined, {}, runtime)).rejects.toThrow(
      /requires a file path/i,
    );
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
  });
});
