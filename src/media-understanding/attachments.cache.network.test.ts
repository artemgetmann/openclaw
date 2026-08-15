import { describe, expect, it, vi } from "vitest";

const { fetchRemoteMedia } = vi.hoisted(() => ({ fetchRemoteMedia: vi.fn() }));

vi.mock("../media/fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/fetch.js")>()),
  fetchRemoteMedia,
}));

import { MediaFetchError } from "../media/fetch.js";
import { MediaAttachmentCache } from "./attachments.cache.js";
import { MediaUnderstandingSkipError } from "./errors.js";

describe("MediaAttachmentCache network failures", () => {
  it("preserves timeout classification from a wrapped guarded-fetch abort", async () => {
    fetchRemoteMedia.mockRejectedValue(
      new MediaFetchError("fetch_failed", "request failed", {
        cause: new DOMException("request timed out", "AbortError"),
      }),
    );
    const cache = new MediaAttachmentCache([
      { index: 0, url: "https://cdn.example.test/audio.mp3" },
    ]);

    const error = await cache
      .getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MediaUnderstandingSkipError);
    expect(error).toMatchObject({ reason: "timeout" });
  });
});
