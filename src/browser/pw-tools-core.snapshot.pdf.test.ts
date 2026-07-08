import { describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

function createPageWithCdp(send: ReturnType<typeof vi.fn>) {
  const detach = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => ({ send, detach }));
  const pdf = vi.fn(async () => Buffer.from("%PDF-1.7\nprinted html\n%%EOF\n"));
  const page = {
    context: () => ({ newCDPSession }),
    pdf,
  };

  return { detach, newCDPSession, page, pdf };
}

describe("pw-tools-core.snapshot pdfViaPlaywright", () => {
  it("keeps HTML page printing when no PDF resource is loaded", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              url: "https://example.com/invoice",
              mimeType: "text/html",
            },
            resources: [],
          },
        };
      }
      return {};
    });
    const { page, pdf } = createPageWithCdp(send);
    setPwToolsCoreCurrentPage(page);

    const result = await mod.pdfViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "target-1",
    });

    expect(result.buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(result.url).toBeUndefined();
    expect(pdf).toHaveBeenCalledWith({ printBackground: true });
  });

  it("returns native PDF bytes from loaded application/pdf resources before printing", async () => {
    const pdfBytes = Buffer.from("%PDF-1.7\nnative bytes\n%%EOF\n");
    const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "viewer-frame",
              url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
              mimeType: "text/html",
            },
            resources: [
              {
                url: "https://example.com/report.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        };
      }
      if (method === "Page.getResourceContent") {
        expect(params).toEqual({
          frameId: "viewer-frame",
          url: "https://example.com/report.pdf",
        });
        return { content: pdfBytes.toString("base64"), base64Encoded: true };
      }
      return {};
    });
    const { page, pdf } = createPageWithCdp(send);
    setPwToolsCoreCurrentPage(page);

    const result = await mod.pdfViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "target-1",
    });

    expect(result.url).toBe("https://example.com/report.pdf");
    expect(result.buffer.equals(pdfBytes)).toBe(true);
    expect(pdf).not.toHaveBeenCalled();
  });

  it("fails clearly instead of printing Chrome PDF viewer UI when native bytes are unavailable", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getResourceTree") {
        return {
          frameTree: {
            frame: {
              id: "viewer-frame",
              url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
              mimeType: "text/html",
            },
            resources: [
              {
                url: "https://example.com/report.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        };
      }
      if (method === "Page.getResourceContent") {
        throw new Error("Content unavailable. Resource was not cached");
      }
      return {};
    });
    const { page, pdf } = createPageWithCdp(send);
    setPwToolsCoreCurrentPage(page);

    await expect(
      mod.pdfViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "target-1",
      }),
    ).rejects.toThrow(/Refusing to print the Chrome PDF viewer UI/);
    expect(pdf).not.toHaveBeenCalled();
  });
});
