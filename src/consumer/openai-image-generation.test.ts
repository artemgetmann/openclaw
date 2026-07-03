import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { resolveRequestUrl } from "../plugin-sdk/request-url.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  buildJarvisManagedOpenAIImageGenerationProvider,
  isJarvisManagedOpenAIImageGenerationConfigured,
} from "./openai-image-generation.js";

function installMockFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const mockFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => await impl(input, init),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function parseJsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON string request body");
  }
  return JSON.parse(init.body);
}

describe("OpenAI managed image generation", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    const resolvePinned = async (hostname: string) => {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      return {
        hostname: normalized,
        addresses: ["93.184.216.34"],
        lookup: ssrf.createPinnedLookup({
          hostname: normalized,
          addresses: ["93.184.216.34"],
        }),
      };
    };
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation(resolvePinned);
    vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(resolvePinned);
  });

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("routes generation through the Jarvis backend without a local OpenAI key", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      expect(resolveRequestUrl(input)).toBe(
        "https://jarvis.example/v1/managed/utilities/openai.image.generate",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer backend-token");
      expect(parseJsonRequestBody(init)).toEqual({
        input: {
          prompt: "tiny robot assistant",
          model: "gpt-image-2",
          count: 1,
          size: "1024x1024",
        },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            provider: "openai",
            payload: {
              model: "gpt-image-2",
              images: [{ mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" }],
            },
          },
        }),
        { status: 200 },
      );
    });

    const cfg = {
      jarvis: {
        backend: {
          baseUrl: "https://jarvis.example",
          accessToken: "backend-token",
        },
        managedServices: { mode: "managed" },
      },
    } as const;

    const provider = buildJarvisManagedOpenAIImageGenerationProvider();
    expect(isJarvisManagedOpenAIImageGenerationConfigured(cfg)).toBe(true);
    await expect(
      provider.generateImage({
        cfg,
        provider: "openai",
        model: "gpt-image-2",
        prompt: " tiny robot assistant ",
        count: 1,
        size: "1024x1024",
      }),
    ).resolves.toMatchObject({
      model: "gpt-image-2",
      images: [{ buffer: Buffer.from("image-bytes"), mimeType: "image/png" }],
      metadata: { transport: "jarvis-managed" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stays inert when managed services are not explicitly configured", async () => {
    const cfg = {
      jarvis: {
        backend: { baseUrl: "https://jarvis.example" },
        managedServices: { mode: "license-only" },
      },
    } as const;

    expect(isJarvisManagedOpenAIImageGenerationConfigured(cfg)).toBe(false);
    await expect(
      buildJarvisManagedOpenAIImageGenerationProvider().generateImage({
        cfg,
        provider: "openai",
        model: "gpt-image-2",
        prompt: "tiny robot assistant",
      }),
    ).rejects.toThrow(/needs Jarvis managed services/);
  });

  it("rejects reference-image edits before spending backend quota", async () => {
    const fetchSpy = installMockFetch(async () => {
      throw new Error("provider should not be called");
    });
    const cfg = {
      jarvis: {
        backend: {
          baseUrl: "https://jarvis.example",
          accessToken: "backend-token",
        },
        managedServices: { mode: "managed" },
      },
    } as const;

    await expect(
      buildJarvisManagedOpenAIImageGenerationProvider().generateImage({
        cfg,
        provider: "openai",
        model: "gpt-image-2",
        prompt: "edit this",
        inputImages: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow(/does not support reference-image edits/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
