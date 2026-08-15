import { describe, expect, it, vi } from "vitest";
import { resolvePodcastAudioUrl } from "./podcast-url.js";

const SPOTIFY_URL = "https://open.spotify.com/episode/0Sk4PpgAwdS6j4DPpkRLRh";
const FEED_URL = "https://feeds.example.test/show.xml";
const AUDIO_URL = "https://cdn.example.test/episode.mp3";

function publicLookup() {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as never;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("resolvePodcastAudioUrl", () => {
  it("resolves a Spotify episode through public metadata and the publisher RSS feed", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === SPOTIFY_URL) {
        return new Response(
          '<script type="application/ld+json">' +
            JSON.stringify({
              name: "How To Pick A Startup Idea",
              datePublished: "2026-06-17",
              description:
                "Listen to this episode from Y Combinator Startup Podcast on Spotify. Episode notes.",
            }) +
            "</script>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.startsWith("https://itunes.apple.com/search?")) {
        return Response.json({
          results: [{ collectionName: "Y Combinator Startup Podcast", feedUrl: FEED_URL }],
        });
      }
      if (url === FEED_URL) {
        return new Response(
          `<rss><channel><item>
            <title><![CDATA[How To Pick A Startup Idea]]></title>
            <pubDate>Wed, 17 Jun 2026 15:48:19 GMT</pubDate>
            <enclosure url="${AUDIO_URL}" length="11045824" type="audio/mpeg"/>
          </item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml" } },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(
      resolvePodcastAudioUrl({ url: SPOTIFY_URL, fetchImpl, lookupFn: publicLookup() }),
    ).resolves.toEqual({
      audioUrl: AUDIO_URL,
      episodeTitle: "How To Pick A Startup Idea",
      mime: "audio/mpeg",
      publishedAt: "2026-06-17",
      showTitle: "Y Combinator Startup Podcast",
      sourceUrl: SPOTIFY_URL,
    });
  });

  it("rejects unsupported page URLs instead of treating HTML as audio", async () => {
    await expect(
      resolvePodcastAudioUrl({
        url: "https://example.com/episode/123",
        fetchImpl: vi.fn(),
        lookupFn: publicLookup(),
      }),
    ).rejects.toThrow(/supported podcast URL/i);
  });

  it("fails honestly when no matching RSS episode exists", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === SPOTIFY_URL) {
        return new Response(
          '<script type="application/ld+json">' +
            JSON.stringify({
              name: "Missing Episode",
              datePublished: "2026-06-17",
              description: "Listen to this episode from Example Show on Spotify.",
            }) +
            "</script>",
        );
      }
      if (url.startsWith("https://itunes.apple.com/search?")) {
        return Response.json({
          results: [{ collectionName: "Example Show", feedUrl: FEED_URL }],
        });
      }
      if (url === FEED_URL) {
        return new Response("<rss><channel></channel></rss>");
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(
      resolvePodcastAudioUrl({ url: SPOTIFY_URL, fetchImpl, lookupFn: publicLookup() }),
    ).rejects.toThrow(/matching episode/i);
  });

  it("omits an invalid optional RSS publication date", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === SPOTIFY_URL) {
        return new Response(
          '<script type="application/ld+json">' +
            JSON.stringify({
              name: "How To Pick A Startup Idea",
              description: "Listen to this episode from Y Combinator Startup Podcast on Spotify.",
            }) +
            "</script>",
        );
      }
      if (url.startsWith("https://itunes.apple.com/search?")) {
        return Response.json({
          results: [{ collectionName: "Y Combinator Startup Podcast", feedUrl: FEED_URL }],
        });
      }
      return new Response(
        `<rss><channel><item><title>How To Pick A Startup Idea</title><pubDate>not-a-date</pubDate><enclosure url="${AUDIO_URL}" type="audio/mpeg"/></item></channel></rss>`,
      );
    });

    await expect(
      resolvePodcastAudioUrl({ url: SPOTIFY_URL, fetchImpl, lookupFn: publicLookup() }),
    ).resolves.toMatchObject({ audioUrl: AUDIO_URL, publishedAt: undefined });
  });
});
