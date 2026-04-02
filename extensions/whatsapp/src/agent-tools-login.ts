import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { imageResult } from "../../../src/agents/tools/common.js";
import { decodeDataUrl } from "../../../src/agents/tools/image-tool.helpers.js";
import type { ChannelAgentTool } from "../../../src/channels/plugins/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../../src/infra/tmp-openclaw-dir.js";

export function createWhatsAppLoginTool(): ChannelAgentTool {
  return {
    label: "WhatsApp Login",
    name: "whatsapp_login",
    ownerOnly: true,
    description: "Generate a WhatsApp QR code for linking, or wait for the scan to complete.",
    // NOTE: Using Type.Unsafe for action enum instead of Type.Union([Type.Literal(...)]
    // because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
    parameters: Type.Object({
      action: Type.Unsafe<"start" | "wait">({
        type: "string",
        enum: ["start", "wait"],
      }),
      timeoutMs: Type.Optional(Type.Number()),
      force: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const { startWebLoginWithQr, waitForWebLogin } = await import("./login-qr.js");
      const action = (args as { action?: string })?.action ?? "start";
      if (action === "wait") {
        const result = await waitForWebLogin({
          timeoutMs:
            typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
              ? (args as { timeoutMs?: number }).timeoutMs
              : undefined,
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: { connected: result.connected },
        };
      }

      const result = await startWebLoginWithQr({
        timeoutMs:
          typeof (args as { timeoutMs?: unknown }).timeoutMs === "number"
            ? (args as { timeoutMs?: number }).timeoutMs
            : undefined,
        force:
          typeof (args as { force?: unknown }).force === "boolean"
            ? (args as { force?: boolean }).force
            : false,
      });

      if (!result.qrDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          details: { qr: false },
        };
      }

      const { buffer, mimeType } = decodeDataUrl(result.qrDataUrl);
      const qrDir = path.join(resolvePreferredOpenClawTmpDir(), "whatsapp-login");
      await fs.mkdir(qrDir, { recursive: true, mode: 0o700 });
      const qrPath = path.join(qrDir, `openclaw-whatsapp-qr-${Date.now()}-${randomUUID()}.png`);
      await fs.writeFile(qrPath, buffer);
      return await imageResult({
        label: "whatsapp-login",
        path: qrPath,
        base64: buffer.toString("base64"),
        mimeType,
        extraText: `${result.message}\n\nOpen WhatsApp → Linked Devices and scan the image below.`,
        details: { qr: true },
      });
    },
  };
}
