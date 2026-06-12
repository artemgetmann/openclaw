import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mediaTranscribeCommand = vi.fn().mockResolvedValue(undefined);

vi.mock("../commands/media.js", () => ({
  mediaTranscribeCommand,
}));

describe("media cli", () => {
  let registerMediaCli: (typeof import("./media-cli.js"))["registerMediaCli"];

  beforeAll(async () => {
    ({ registerMediaCli } = await import("./media-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("teaches generic media transcription in command help", async () => {
    const program = new Command();
    let help = "";

    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        help += text;
      },
      writeErr: (text) => {
        help += text;
      },
    });
    registerMediaCli(program);

    await expect(program.parseAsync(["media", "--help"], { from: "user" })).rejects.toThrow(
      "outputHelp",
    );

    expect(help).toContain("openclaw media transcribe /tmp/voice.oga --json");
    expect(help).toContain("openclaw media transcribe --file /tmp/voice.oga --json");
  });

  it("registers transcribe and forwards file options", async () => {
    const program = new Command();
    registerMediaCli(program);

    await program.parseAsync(
      [
        "media",
        "transcribe",
        "--file",
        "/tmp/voice.oga",
        "--mime",
        "audio/ogg",
        "--agent-dir",
        "/tmp/agent",
        "--json",
      ],
      { from: "user" },
    );

    expect(mediaTranscribeCommand).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        agentDir: "/tmp/agent",
        file: "/tmp/voice.oga",
        json: true,
        mime: "audio/ogg",
      }),
      expect.any(Object),
    );
  });

  it("supports the human-friendly positional file form", async () => {
    const program = new Command();
    registerMediaCli(program);

    await program.parseAsync(["media", "transcribe", "/tmp/voice.oga", "--json"], {
      from: "user",
    });

    expect(mediaTranscribeCommand).toHaveBeenCalledWith(
      "/tmp/voice.oga",
      expect.objectContaining({ json: true }),
      expect.any(Object),
    );
  });
});
