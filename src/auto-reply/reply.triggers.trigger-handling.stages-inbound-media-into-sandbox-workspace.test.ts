import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_MAX_BYTES } from "../media/store.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";
import type { MsgContext, TemplateContext } from "./templating.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => sandboxMocks);
vi.mock("node:child_process", () => childProcessMocks);

import { ensureSandboxWorkspaceForSession } from "../agents/sandbox.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";

afterEach(() => {
  vi.restoreAllMocks();
  childProcessMocks.spawn.mockClear();
});

function setupSandboxWorkspace(home: string): {
  cfg: ReturnType<typeof createSandboxMediaStageConfig>;
  workspaceDir: string;
  sandboxDir: string;
} {
  const cfg = createSandboxMediaStageConfig(home);
  const workspaceDir = join(home, "openclaw");
  const sandboxDir = join(home, "sandboxes", "session");
  vi.mocked(ensureSandboxWorkspaceForSession).mockResolvedValue({
    workspaceDir: sandboxDir,
    containerWorkdir: "/work",
  });
  return { cfg, workspaceDir, sandboxDir };
}

async function writeInboundMedia(
  home: string,
  fileName: string,
  payload: string | Buffer,
): Promise<string> {
  const inboundDir = join(home, ".openclaw", "media", "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  const mediaPath = join(inboundDir, fileName);
  await fs.writeFile(mediaPath, payload);
  return mediaPath;
}

function setMediaBatch(
  ctx: MsgContext,
  sessionCtx: TemplateContext,
  entries: Array<{ path: string; url?: string; type?: string }>,
): void {
  const paths = entries.map((entry) => entry.path);
  const urls = entries.map((entry) => entry.url ?? entry.path);
  const types = entries.map((entry) => entry.type ?? "application/octet-stream");
  ctx.MediaPaths = paths;
  sessionCtx.MediaPaths = [...paths];
  ctx.MediaUrls = urls;
  sessionCtx.MediaUrls = [...urls];
  ctx.MediaTypes = types;
  sessionCtx.MediaTypes = [...types];
  ctx.MediaPath = paths[0];
  sessionCtx.MediaPath = paths[0];
  ctx.MediaUrl = urls[0];
  sessionCtx.MediaUrl = urls[0];
  ctx.MediaType = types[0];
  sessionCtx.MediaType = types[0];
}

describe("stageSandboxMedia", () => {
  it("stages allowed media and blocks unsafe paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir } = setupSandboxWorkspace(home);

      {
        const mediaPath = await writeInboundMedia(home, "photo.jpg", "test");
        const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        const stagedPath = join(home, ".openclaw", "media", "inbound", basename(mediaPath));
        expect(ctx.MediaPath).toBe(stagedPath);
        expect(sessionCtx.MediaPath).toBe(stagedPath);
        expect(ctx.MediaUrl).toBe(stagedPath);
        expect(sessionCtx.MediaUrl).toBe(stagedPath);
        await expect(
          fs.stat(join(home, ".openclaw", "media", "inbound", basename(mediaPath))),
        ).resolves.toBeTruthy();
      }

      {
        const sensitiveFile = join(home, "secrets.txt");
        await fs.writeFile(sensitiveFile, "SENSITIVE DATA");
        const { ctx, sessionCtx } = createSandboxMediaContexts(sensitiveFile);

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        await expect(
          fs.stat(join(home, ".openclaw", "media", "inbound", basename(sensitiveFile))),
        ).rejects.toThrow();
        expect(ctx.MediaPath).toBe(sensitiveFile);
      }

      {
        childProcessMocks.spawn.mockClear();
        const { ctx, sessionCtx } = createSandboxMediaContexts("/etc/passwd");
        ctx.Provider = "imessage";
        ctx.MediaRemoteHost = "user@gateway-host";
        sessionCtx.Provider = "imessage";
        sessionCtx.MediaRemoteHost = "user@gateway-host";

        await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: "agent:main:main",
          workspaceDir,
        });

        expect(childProcessMocks.spawn).not.toHaveBeenCalled();
        expect(ctx.MediaPath).toBe("/etc/passwd");
      }
    });
  });

  it("skips staging a transcribed voice note and clears exposed media paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir } = setupSandboxWorkspace(home);
      const voicePath = await writeInboundMedia(home, "voice.ogg", "voice-bytes");

      const { ctx, sessionCtx } = createSandboxMediaContexts(voicePath);
      ctx.MediaType = "audio/ogg";
      sessionCtx.MediaType = "audio/ogg";
      ctx.Transcript = "transcript text";
      sessionCtx.Transcript = "transcript text";
      ctx.MediaUnderstanding = [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "transcript text",
          provider: "whisper",
        },
      ];
      sessionCtx.MediaUnderstanding = ctx.MediaUnderstanding;

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      expect(ctx.MediaPath).toBeUndefined();
      expect(sessionCtx.MediaPath).toBeUndefined();
      expect(ctx.MediaPaths).toBeUndefined();
      expect(sessionCtx.MediaPaths).toBeUndefined();
      expect(ctx.MediaUrl).toBeUndefined();
      expect(sessionCtx.MediaUrl).toBeUndefined();
      expect(ctx.MediaUrls).toBeUndefined();
      expect(sessionCtx.MediaUrls).toBeUndefined();
      expect(ctx.Transcript).toBe("transcript text");
      expect(sessionCtx.Transcript).toBe("transcript text");
    });
  });

  it("keeps an untranscribed voice note staged for fallback", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir } = setupSandboxWorkspace(home);
      const voicePath = await writeInboundMedia(home, "voice.ogg", "voice-bytes");

      const { ctx, sessionCtx } = createSandboxMediaContexts(voicePath);
      ctx.MediaType = "audio/ogg";
      sessionCtx.MediaType = "audio/ogg";
      ctx.MediaUnderstandingDecisions = [
        {
          capability: "audio",
          outcome: "skipped",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "failed",
                  reason: "provider error",
                },
              ],
            },
          ],
        },
      ];
      sessionCtx.MediaUnderstandingDecisions = ctx.MediaUnderstandingDecisions;

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      const stagedPath = join(home, ".openclaw", "media", "inbound", basename(voicePath));
      expect(ctx.MediaPath).toBe(stagedPath);
      expect(sessionCtx.MediaPath).toBe(stagedPath);
      expect(ctx.MediaUrl).toBe(stagedPath);
      expect(sessionCtx.MediaUrl).toBe(stagedPath);
    });
  });

  it("removes transcribed audio but keeps other attachments in order", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir } = setupSandboxWorkspace(home);
      const voicePath = await writeInboundMedia(home, "voice.ogg", "voice-bytes");
      const imagePath = await writeInboundMedia(home, "photo.png", "image-bytes");

      const { ctx, sessionCtx } = createSandboxMediaContexts(voicePath);
      setMediaBatch(ctx, sessionCtx, [
        { path: voicePath, type: "audio/ogg" },
        { path: imagePath, type: "image/png" },
      ]);
      ctx.Transcript = "voice transcript";
      sessionCtx.Transcript = "voice transcript";
      ctx.MediaUnderstanding = [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "voice transcript",
          provider: "whisper",
        },
      ];
      sessionCtx.MediaUnderstanding = ctx.MediaUnderstanding;

      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      const stagedImagePath = join(home, ".openclaw", "media", "inbound", basename(imagePath));
      expect(ctx.MediaPaths).toEqual([stagedImagePath]);
      expect(sessionCtx.MediaPaths).toEqual([stagedImagePath]);
      expect(ctx.MediaPath).toBe(stagedImagePath);
      expect(sessionCtx.MediaPath).toBe(stagedImagePath);
      expect(ctx.MediaUrls).toEqual([stagedImagePath]);
      expect(sessionCtx.MediaUrls).toEqual([stagedImagePath]);
      expect(ctx.MediaUrl).toBe(stagedImagePath);
      expect(sessionCtx.MediaUrl).toBe(stagedImagePath);
      expect(ctx.MediaTypes).toEqual(["image/png"]);
      expect(sessionCtx.MediaTypes).toEqual(["image/png"]);
      expect(ctx.MediaType).toBe("image/png");
      expect(sessionCtx.MediaType).toBe("image/png");
    });
  });

  it("blocks destination symlink escapes when staging into sandbox workspace", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(home, "payload.txt", "PAYLOAD");

      const outsideDir = join(home, "outside");
      const outsideInboundDir = join(outsideDir, "inbound");
      await fs.mkdir(outsideInboundDir, { recursive: true });
      const victimPath = join(outsideDir, "victim.txt");
      await fs.writeFile(victimPath, "ORIGINAL");

      await fs.mkdir(sandboxDir, { recursive: true });
      await fs.symlink(outsideDir, join(sandboxDir, "media"));
      await fs.symlink(victimPath, join(outsideInboundDir, basename(mediaPath)));

      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      await expect(fs.readFile(victimPath, "utf8")).resolves.toBe("ORIGINAL");
      expect(ctx.MediaPath).toBe(mediaPath);
      expect(sessionCtx.MediaPath).toBe(mediaPath);
    });
  });

  it("skips oversized media staging and keeps original media paths", async () => {
    await withSandboxMediaTempHome("openclaw-triggers-", async (home) => {
      const { cfg, workspaceDir, sandboxDir } = setupSandboxWorkspace(home);

      const mediaPath = await writeInboundMedia(
        home,
        "oversized.bin",
        Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x41),
      );

      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
      });

      await expect(
        fs.stat(join(sandboxDir, "media", "inbound", basename(mediaPath))),
      ).rejects.toThrow();
      expect(ctx.MediaPath).toBe(mediaPath);
      expect(sessionCtx.MediaPath).toBe(mediaPath);
    });
  });
});
