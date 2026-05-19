import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../../src/infra/net/ssrf.js";
import { resolveRequestUrl } from "../../src/plugin-sdk/request-url.js";
import { withFetchPreconnect } from "../../src/test-utils/fetch-mock.js";
import plugin from "./index.js";
import {
  __testing as firecrawlClientTesting,
  runFirecrawlScrape,
  runFirecrawlSearch,
} from "./src/firecrawl-client.js";

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

describe("firecrawl plugin", () => {
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("parses scrape payloads into wrapped external-content results", () => {
    const result = firecrawlClientTesting.parseFirecrawlScrapePayload({
      payload: {
        success: true,
        data: {
          markdown: "# Hello\n\nWorld",
          metadata: {
            title: "Example page",
            sourceURL: "https://example.com/final",
            statusCode: 200,
          },
        },
      },
      url: "https://example.com/start",
      extractMode: "text",
      maxChars: 1000,
    });

    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.status).toBe(200);
    expect(result.extractor).toBe("firecrawl");
    expect(typeof result.text).toBe("string");
  });

  it("extracts search items from flexible Firecrawl payload shapes", () => {
    const items = firecrawlClientTesting.resolveSearchItems({
      success: true,
      data: [
        {
          title: "Docs",
          url: "https://docs.example.com/path",
          description: "Reference docs",
          markdown: "Body",
        },
      ],
    });

    expect(items).toEqual([
      {
        title: "Docs",
        url: "https://docs.example.com/path",
        description: "Reference docs",
        content: "Body",
        published: undefined,
        siteName: "docs.example.com",
      },
    ]);
  });

  it("extracts search items from Firecrawl v2 data.web payloads", () => {
    const items = firecrawlClientTesting.resolveSearchItems({
      success: true,
      data: {
        web: [
          {
            title: "API Platform - OpenAI",
            url: "https://openai.com/api/",
            description: "Build on the OpenAI API platform.",
            markdown: "# API Platform",
            position: 1,
          },
        ],
      },
    });

    expect(items).toEqual([
      {
        title: "API Platform - OpenAI",
        url: "https://openai.com/api/",
        description: "Build on the OpenAI API platform.",
        content: "# API Platform",
        published: undefined,
        siteName: "openai.com",
      },
    ]);
  });

  it("routes managed Firecrawl search through the Jarvis backend without a provider key", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      const url = resolveRequestUrl(input);
      expect(url).not.toContain("api.firecrawl.dev");
      expect(url).toBe("https://jarvis.example/v1/managed/utilities/firecrawl.search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer backend-token");
      expect(parseJsonRequestBody(init)).toEqual({
        input: {
          query: "managed search",
          limit: 3,
        },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            provider: "firecrawl",
            payload: {
              success: true,
              data: [{ title: "Managed", url: "https://example.com/managed" }],
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await runFirecrawlSearch({
      cfg: {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accessToken: "backend-token",
          },
          managedServices: { mode: "managed" },
        },
      },
      query: "managed search",
      count: 3,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "firecrawl",
      count: 1,
    });
  });

  it("routes managed Firecrawl scrape through the Jarvis backend without a provider key", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      const url = resolveRequestUrl(input);
      expect(url).not.toContain("api.firecrawl.dev");
      expect(url).toBe("https://jarvis.example/v1/managed/utilities/firecrawl.scrape");
      expect(parseJsonRequestBody(init)).toEqual({
        input: {
          url: "https://example.com/managed-scrape",
        },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            provider: "firecrawl",
            payload: {
              success: true,
              data: {
                markdown: "# Managed Scrape",
                metadata: {
                  sourceURL: "https://example.com/final",
                  statusCode: 200,
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await runFirecrawlScrape({
      cfg: {
        jarvis: {
          backend: { baseUrl: "https://jarvis.example" },
          managedServices: { mode: "managed" },
        },
      },
      url: "https://example.com/managed-scrape",
      extractMode: "markdown",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      extractor: "firecrawl",
      finalUrl: "https://example.com/final",
    });
  });

  it("keeps direct Firecrawl search intact when Jarvis backend config is absent", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      const url = resolveRequestUrl(input);
      expect(url).toBe("https://api.firecrawl.dev/v2/search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer direct-firecrawl-key");
      expect(parseJsonRequestBody(init)).toEqual({
        query: "direct search",
        limit: 2,
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ title: "Direct", url: "https://example.com/direct" }],
        }),
        { status: 200 },
      );
    });

    const result = await runFirecrawlSearch({
      cfg: {
        tools: {
          web: {
            search: {
              provider: "firecrawl",
              firecrawl: { apiKey: "direct-firecrawl-key" },
            },
          },
        },
      },
      query: "direct search",
      count: 2,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "firecrawl",
      count: 1,
    });
  });

  it.todo(
    "routes goplaces search through google_places.search once goplaces has a TypeScript runtime adapter",
  );
});
