import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildNativeMacScreencapturePlan,
  buildScreenRecordParams,
  canUseNativeMacScreencaptureFallback,
  formatNoScreenRecordNodeMessage,
  pickDefaultScreenRecordNode,
  resolveDefaultScreenRecordNodeOrThrow,
  shouldUseNativeMacScreencaptureFallback,
} from "./screen-record.js";

describe("screen record CLI params", () => {
  it("requires an explicit target for the top-level command", () => {
    expect(() =>
      buildScreenRecordParams(
        { duration: "1s" },
        {
          requireTarget: true,
          requireDisplayReason: true,
        },
      ),
    ).toThrow(/target required/i);
  });

  it("requires a reason for top-level full-display recording", () => {
    expect(() =>
      buildScreenRecordParams(
        { display: "0", duration: "1s" },
        {
          requireTarget: true,
          requireDisplayReason: true,
        },
      ),
    ).toThrow(/--display requires --reason/i);
  });

  it("builds app-window target params with audio off by default", () => {
    const params = buildScreenRecordParams(
      { app: "Telegram", duration: "2s", fps: "15" },
      {
        requireTarget: true,
        requireDisplayReason: true,
      },
    );

    expect(params).toMatchObject({
      appName: "Telegram",
      durationMs: 2000,
      fps: 15,
      format: "mp4",
      includeAudio: false,
    });
  });

  it("keeps legacy nodes screen capture compatible without explicit targets", () => {
    const params = buildScreenRecordParams(
      { screen: "0", duration: "1000", audio: true },
      {
        requireTarget: false,
        requireDisplayReason: false,
      },
    );

    expect(params).toMatchObject({
      screenIndex: 0,
      durationMs: 1000,
      includeAudio: true,
    });
  });

  it("rejects ambiguous targets", () => {
    expect(() =>
      buildScreenRecordParams(
        { app: "Telegram", windowId: "42", duration: "1s" },
        {
          requireTarget: true,
          requireDisplayReason: true,
        },
      ),
    ).toThrow(/choose one recording target/i);
  });

  it("rejects out-of-range window ids before gateway access", () => {
    expect(() =>
      buildScreenRecordParams(
        { windowId: "-1", duration: "1s" },
        {
          requireTarget: true,
          requireDisplayReason: true,
        },
      ),
    ).toThrow(/--window-id must be between/i);
  });

  it("defaults to the only Mac node when another screen-capable node exists", () => {
    expect(
      pickDefaultScreenRecordNode([
        {
          nodeId: "mac-1",
          platform: "macOS 26.2.0",
          commands: ["screen.record"],
        },
        {
          nodeId: "phone-1",
          platform: "iOS 18.0",
          commands: ["screen.record"],
        },
      ]),
    )?.toMatchObject({ nodeId: "mac-1" });
  });

  it("does not default to non-Mac nodes for target-aware screen recording", () => {
    expect(
      pickDefaultScreenRecordNode([
        {
          nodeId: "phone-1",
          platform: "iOS 18.0",
          commands: ["screen.record"],
        },
      ]),
    ).toBeNull();
  });

  it("explains missing macOS Screen Recording permission when no default node can record", () => {
    expect(() =>
      resolveDefaultScreenRecordNodeOrThrow([
        {
          nodeId: "mac-1",
          platform: "macOS 26.5.1",
          connected: true,
          commands: ["system.run"],
          permissions: { screenRecording: false },
          bundleIdentifier: "ai.openclaw.consumer.mac.debug",
          bundlePath: "/Users/user/Programming_Projects/openclaw/dist/Jarvis.app",
        },
      ]),
    ).toThrow(/gateway\.nodes\.allowCommands|Screen Recording/i);
  });

  it("replaces vague no-node failures with actionable recorder preflight commands", () => {
    const message = formatNoScreenRecordNodeMessage([]);

    expect(message).toContain("no macOS screen recording node connected");
    expect(message).toContain("openclaw nodes status --json");
    expect(message).toContain("consumer_instance_apply_runtime_env screen-record-proof");
    expect(message).toContain("--display <index>");
    expect(message).not.toBe("node required");
  });

  it("allows native macOS fallback only for explicit full-display capture with a reason", () => {
    const mode = {
      requireTarget: true,
      requireDisplayReason: true,
    };
    const localGatewayContext = {
      config: { gateway: { mode: "local" as const } },
      env: {},
    };

    expect(
      canUseNativeMacScreencaptureFallback(
        { display: "0", reason: "workflow crosses apps", duration: "2s" },
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(true);
    expect(
      canUseNativeMacScreencaptureFallback(
        { app: "Telegram", duration: "2s" },
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);
    expect(
      canUseNativeMacScreencaptureFallback(
        { display: "0", duration: "2s" },
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);
    expect(
      canUseNativeMacScreencaptureFallback(
        { display: "0", reason: "workflow crosses apps", node: "mac-1" },
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);
    expect(
      canUseNativeMacScreencaptureFallback(
        {
          display: "0",
          reason: "workflow crosses apps",
          url: "wss://remote.example.test",
        },
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);
    expect(
      canUseNativeMacScreencaptureFallback(
        { display: "0", reason: "workflow crosses apps", duration: "2s" },
        mode,
        "linux",
        localGatewayContext,
      ),
    ).toBe(false);
    expect(
      canUseNativeMacScreencaptureFallback(
        { display: "0", reason: "workflow crosses apps", duration: "2s" },
        mode,
        "darwin",
        {
          config: {
            gateway: {
              mode: "remote",
              remote: { url: "wss://remote.example.test/ws" },
            },
          },
          env: {},
        },
      ),
    ).toBe(false);
    expect(
      canUseNativeMacScreencaptureFallback(
        { display: "0", reason: "workflow crosses apps", duration: "2s" },
        mode,
        "darwin",
        {
          config: { gateway: { mode: "local" } },
          env: { OPENCLAW_GATEWAY_URL: "wss://remote.example.test/ws" },
        },
      ),
    ).toBe(false);
  });

  it("uses native fallback only for local empty-node-list failures", () => {
    const mode = {
      requireTarget: true,
      requireDisplayReason: true,
    };
    const opts = { display: "0", reason: "workflow crosses apps", duration: "2s" };
    const localGatewayContext = {
      config: { gateway: { mode: "local" as const } },
      env: {},
    };

    let emptyNodeError: unknown;
    try {
      resolveDefaultScreenRecordNodeOrThrow([]);
    } catch (err) {
      emptyNodeError = err;
    }

    expect(
      shouldUseNativeMacScreencaptureFallback(
        emptyNodeError,
        opts,
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(true);
    expect(
      shouldUseNativeMacScreencaptureFallback(emptyNodeError, opts, mode, "darwin", {
        config: {
          gateway: {
            mode: "remote",
            remote: { url: "wss://remote.example.test/ws" },
          },
        },
        env: {},
      }),
    ).toBe(false);
    expect(
      shouldUseNativeMacScreencaptureFallback(
        emptyNodeError,
        { ...opts, url: "wss://remote.example.test" },
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);

    let nonMacNodeError: unknown;
    try {
      resolveDefaultScreenRecordNodeOrThrow([
        {
          nodeId: "phone-1",
          platform: "iOS 18.0",
          connected: true,
          commands: ["screen.record"],
        },
      ]);
    } catch (err) {
      nonMacNodeError = err;
    }
    expect(
      shouldUseNativeMacScreencaptureFallback(
        nonMacNodeError,
        opts,
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(true);

    let disconnectedMacNodeError: unknown;
    try {
      resolveDefaultScreenRecordNodeOrThrow([
        {
          nodeId: "mac-old",
          platform: "macOS 26.5.1",
          connected: false,
          commands: ["screen.record"],
        },
      ]);
    } catch (err) {
      disconnectedMacNodeError = err;
    }
    expect(
      shouldUseNativeMacScreencaptureFallback(
        disconnectedMacNodeError,
        opts,
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(true);

    let misconfiguredMacError: unknown;
    try {
      resolveDefaultScreenRecordNodeOrThrow([
        {
          nodeId: "mac-1",
          platform: "macOS 26.5.1",
          connected: true,
          commands: ["system.run"],
        },
      ]);
    } catch (err) {
      misconfiguredMacError = err;
    }
    expect(
      shouldUseNativeMacScreencaptureFallback(
        misconfiguredMacError,
        opts,
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);

    expect(
      shouldUseNativeMacScreencaptureFallback(
        new Error("gateway url override requires explicit credentials"),
        opts,
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);
    expect(
      shouldUseNativeMacScreencaptureFallback(
        new Error("multiple macOS screen recording nodes available; pass --node"),
        opts,
        mode,
        "darwin",
        localGatewayContext,
      ),
    ).toBe(false);
  });

  it("builds deterministic native screencapture arguments and a preflight artifact", () => {
    const plan = buildNativeMacScreencapturePlan(
      {
        display: "0",
        reason: "workflow crosses apps",
        duration: "1200",
        audio: true,
        out: ".artifacts/review.mov",
      },
      {
        requireTarget: true,
        requireDisplayReason: true,
      },
    );

    expect(plan.args).toEqual(["-v", "-V2", "-D1", "-C", "-x", "-g", ".artifacts/review.mov"]);
    expect(plan.preflightArgs).toEqual(["-x", "-D1", ".artifacts/review.preflight.png"]);
    expect(plan.format).toBe("mov");
    expect(plan.durationMs).toBe(1200);
    expect(plan.screenIndex).toBe(0);
  });

  it("defaults native screencapture fallback artifacts to mp4", () => {
    const plan = buildNativeMacScreencapturePlan(
      {
        display: "0",
        reason: "workflow crosses apps",
        duration: "1s",
      },
      {
        requireTarget: true,
        requireDisplayReason: true,
      },
    );

    expect(plan.outPath).toMatch(/\.mp4$/);
    expect(plan.preflightPath).toMatch(/\.preflight\.png$/);
    expect(plan.format).toBe("mp4");
  });

  it("documents video-first proof artifacts and keeps inspection sheets local by default", () => {
    const skill = readFileSync("skills/screen-record/SKILL.md", "utf8");
    const mediaSkill = readFileSync("skills/media-editor/SKILL.md", "utf8");

    expect(skill).toMatch(/User-facing proof is\s+MP4\/video by default/i);
    expect(skill).toMatch(
      /Contact sheets, extracted frames, stills, and thumbnails are\s+internal\/local inspection artifacts/i,
    );
    expect(skill).toMatch(/GIF is not the default proof format/i);
    expect(skill).toMatch(/Inspect the final video locally before calling it proof/i);
    expect(skill).toMatch(/media-editor.+proof-inspection recipe/i);
    expect(skill).toMatch(/custom bundled\s+skill allowlist/i);
    expect(skill).toMatch(/ffprobe -v error/i);
    expect(mediaSkill).toMatch(/ffprobe -v error/i);
    expect(mediaSkill).toMatch(/blackdetect=d=0\.2:pix_th=0\.10/i);
    expect(mediaSkill).toMatch(/review-contact\.png/i);
  });
});
