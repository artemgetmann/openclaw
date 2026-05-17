import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { resolveRequestUrl } from "../plugin-sdk/request-url.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  isJarvisManagedGeminiImageGenerationConfigured,
  runGeminiImageGeneration,
} from "./gemini-image-generation.js";

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

describe("Gemini managed image generation", () => {
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

  it("routes generation through the Jarvis backend without a local Gemini key", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      const url = resolveRequestUrl(input);
      expect(url).toBe("https://jarvis.example/v1/managed/utilities/gemini.image.generate");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer backend-token");
      expect(parseJsonRequestBody(init)).toEqual({
        input: {
          prompt: "tiny robot assistant",
          resolution: "2K",
          aspectRatio: "16:9",
        },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            provider: "gemini",
            payload: {
              model: "gemini-3-pro-image-preview",
              text: "Generated a small robot.",
              images: [{ mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" }],
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

    expect(isJarvisManagedGeminiImageGenerationConfigured(cfg)).toBe(true);
    await expect(
      runGeminiImageGeneration({
        cfg,
        prompt: " tiny robot assistant ",
        resolution: "2K",
        aspectRatio: "16:9",
      }),
    ).resolves.toMatchObject({
      provider: "gemini",
      transport: "jarvis-managed",
      model: "gemini-3-pro-image-preview",
      text: "Generated a small robot.",
      images: [{ mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" }],
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

    expect(isJarvisManagedGeminiImageGenerationConfigured(cfg)).toBe(false);
    await expect(
      runGeminiImageGeneration({
        cfg,
        prompt: "tiny robot assistant",
      }),
    ).rejects.toThrow(/needs Jarvis managed services/);
  });
});
