import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { resolveRequestUrl } from "../plugin-sdk/request-url.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { GOOGLE_PLACES_TEXT_SEARCH_URL, runGooglePlacesSearch } from "./google-places-search.js";

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

describe("Google Places consumer search", () => {
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

  it("routes managed search through the Jarvis backend without a provider key", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      const url = resolveRequestUrl(input);
      expect(url).not.toContain("places.googleapis.com");
      expect(url).toBe("https://jarvis.example/v1/managed/utilities/google_places.search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer backend-token");
      expect(parseJsonRequestBody(init)).toEqual({
        input: {
          query: "coffee near KLCC",
          limit: 4,
        },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            provider: "google_places",
            payload: {
              places: [
                {
                  id: "managed-place",
                  displayName: { text: "Managed Coffee" },
                  formattedAddress: "Kuala Lumpur",
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await runGooglePlacesSearch({
      cfg: {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accessToken: "backend-token",
          },
          managedServices: { mode: "managed" },
        },
      },
      query: "coffee near KLCC",
      limit: 4,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "google_places",
      transport: "jarvis-managed",
      count: 1,
    });
  });

  it("keeps direct Google Places search intact when Jarvis backend config is absent", async () => {
    const fetchSpy = installMockFetch(async (input, init) => {
      const url = resolveRequestUrl(input);
      expect(url).toBe(GOOGLE_PLACES_TEXT_SEARCH_URL);
      expect(new Headers(init?.headers).get("X-Goog-Api-Key")).toBe("direct-places-key");
      expect(new Headers(init?.headers).get("X-Goog-FieldMask")).toContain("places.displayName");
      expect(parseJsonRequestBody(init)).toEqual({
        textQuery: "bookstores nearby",
        pageSize: 2,
      });
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "direct-place",
              displayName: { text: "Direct Books" },
              formattedAddress: "Local Address",
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await runGooglePlacesSearch({
      cfg: {
        skills: {
          entries: {
            goplaces: { apiKey: "direct-places-key" },
          },
        },
      },
      env: {},
      query: "bookstores nearby",
      limit: 2,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      provider: "google_places",
      transport: "direct",
      count: 1,
    });
  });
});
