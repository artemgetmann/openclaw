import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.js";

describe("MediaAttachmentCache state-relative paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads packaged Telegram audio paths relative to the OpenClaw state dir", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-relative-home-"));
    const stateDir = path.join(tempHome, ".openclaw");
    const mediaDir = path.join(stateDir, "media", "inbound");
    const fileName = "file_0---c0fd3a32-aed1-44fb-b990-71e15d468c8b.ogg";
    const mediaPath = path.join(mediaDir, fileName);
    const mediaBytes = Buffer.alloc(MIN_AUDIO_FILE_BYTES + 1, 0xab);

    vi.stubEnv("OPENCLAW_HOME", tempHome);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(mediaPath, mediaBytes);
    vi.resetModules();

    try {
      const { MediaAttachmentCache } = await import("./attachments.cache.js");
      const cache = new MediaAttachmentCache([
        {
          index: 0,
          path: `.openclaw/media/inbound/${fileName}`,
          mime: "audio/ogg; codecs=opus",
        },
      ]);

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: mediaBytes.byteLength + 10,
        timeoutMs: 1000,
      });

      expect(result.fileName).toBe(fileName);
      expect(result.mime).toBe("audio/ogg; codecs=opus");
      expect(result.buffer.equals(mediaBytes)).toBe(true);
      await cache.cleanup();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("reads media/inbound paths relative to the OpenClaw state dir", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-relative-"));
    const mediaDir = path.join(stateDir, "media", "inbound");
    const fileName = "voice.ogg";
    const mediaPath = path.join(mediaDir, fileName);
    const mediaBytes = Buffer.alloc(MIN_AUDIO_FILE_BYTES + 1, 0xcd);

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(mediaPath, mediaBytes);
    vi.resetModules();

    try {
      const { MediaAttachmentCache } = await import("./attachments.cache.js");
      const cache = new MediaAttachmentCache([
        {
          index: 0,
          path: `media/inbound/${fileName}`,
          mime: "audio/ogg",
        },
      ]);

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: mediaBytes.byteLength + 10,
        timeoutMs: 1000,
      });

      expect(result.fileName).toBe(fileName);
      expect(result.buffer.equals(mediaBytes)).toBe(true);
      await cache.cleanup();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
