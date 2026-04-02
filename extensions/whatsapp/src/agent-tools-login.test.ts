import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../src/infra/tmp-openclaw-dir.js";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";

const loginMocks = vi.hoisted(() => ({
  startWebLoginWithQr: vi.fn(),
  waitForWebLogin: vi.fn(),
}));

vi.mock("./login-qr.js", () => loginMocks);

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

describe("createWhatsAppLoginTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a real image result for QR starts", async () => {
    loginMocks.startWebLoginWithQr.mockResolvedValue({
      message: "Scan this QR in WhatsApp → Linked Devices.",
      qrDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute?.("tool-1", { action: "start" });

    expect(result).toBeTruthy();
    expect(result?.details).toMatchObject({ qr: true });
    expect(result?.content).toHaveLength(2);
    expect(result?.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Open WhatsApp → Linked Devices"),
    });
    expect(result?.content?.[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(
      String(result?.content?.[0] && (result?.content?.[0] as { text?: string }).text),
    ).not.toContain("data:image/png;base64");
    const detailsPath = (result?.details as { path?: string } | undefined)?.path;
    if (detailsPath) {
      const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
      expect(path.resolve(detailsPath)).toMatch(
        new RegExp(`^${tmpRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:${path.sep}|$)`),
      );
      await fs.rm(detailsPath, { force: true });
    }
  });

  it("keeps wait mode text-only", async () => {
    loginMocks.waitForWebLogin.mockResolvedValue({
      connected: false,
      message: "Still waiting for the QR scan.",
    });

    const tool = createWhatsAppLoginTool();
    const result = await tool.execute?.("tool-1", { action: "wait" });

    expect(result?.details).toMatchObject({ connected: false });
    expect(result?.content).toEqual([{ type: "text", text: "Still waiting for the QR scan." }]);
  });
});
