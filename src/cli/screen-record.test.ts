import { describe, expect, it } from "vitest";
import { buildScreenRecordParams, pickDefaultScreenRecordNode } from "./screen-record.js";

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
});
