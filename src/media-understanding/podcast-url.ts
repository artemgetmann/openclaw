import type { LookupFn } from "../infra/net/ssrf.js";
import { fetchRemoteMedia, type FetchLike } from "../media/fetch.js";

const METADATA_MAX_BYTES = 2 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 15_000;

export type ResolvedPodcastAudio = {
  audioUrl: string;
  episodeTitle: string;
  mime?: string;
  publishedAt?: string;
  showTitle: string;
  sourceUrl: string;
};

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function optionalIsoDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function elementText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
}

function enclosureAttributes(item: string): Record<string, string> {
  const enclosure = /<enclosure\b([^>]*)\/?\s*>/i.exec(item)?.[1];
  if (!enclosure) {
    return {};
  }
  const attributes: Record<string, string> = {};
  for (const match of enclosure.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
    attributes[match[1].toLowerCase()] = decodeXml(match[3]);
  }
  return attributes;
}

function normalizeEnclosureUrl(value: string): string {
  // Anchor commonly wraps the publisher CDN URL as the final encoded path
  // segment. Use that explicit HTTPS target directly; the media fetcher still
  // performs its normal DNS/IP checks before downloading it.
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== "anchor.fm") {
      return value;
    }
    const encodedTarget = parsed.pathname.split("/").at(-1);
    if (!encodedTarget) {
      return value;
    }
    const decodedTarget = decodeURIComponent(encodedTarget);
    const decoded = new URL(decodedTarget);
    return decoded.protocol === "https:" ? decoded.toString() : value;
  } catch {
    return value;
  }
}

async function fetchText(params: {
  url: string;
  fetchImpl?: FetchLike;
  lookupFn?: LookupFn;
}): Promise<string> {
  const result = await fetchRemoteMedia({
    ...params,
    // The pinned Undici transport returns encoded bytes as-is. Request an
    // identity body so HTML, JSON, and RSS remain directly parseable.
    requestInit: {
      headers: { "accept-encoding": "identity", "user-agent": "OpenClaw podcast resolver" },
    },
    maxBytes: METADATA_MAX_BYTES,
    maxRedirects: 3,
    timeoutMs: METADATA_TIMEOUT_MS,
    readIdleTimeoutMs: METADATA_TIMEOUT_MS,
  });
  return result.buffer.toString("utf8");
}

function parseSpotifyMetadata(html: string): {
  title: string;
  showTitle: string;
  publishedAt?: string;
} {
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const value = JSON.parse(match[1]) as Record<string, unknown>;
      const title = typeof value.name === "string" ? value.name.trim() : "";
      const description = typeof value.description === "string" ? value.description : "";
      const showTitle = /Listen to this episode from (.+?) on Spotify\./i
        .exec(description)?.[1]
        ?.trim();
      if (title && showTitle) {
        return {
          title,
          showTitle,
          publishedAt: typeof value.datePublished === "string" ? value.datePublished : undefined,
        };
      }
    } catch {
      // Spotify can include unrelated JSON-LD blocks. Continue until the
      // episode-shaped block is found.
    }
  }
  throw new Error("Spotify episode metadata did not include an episode and show title.");
}

export async function resolvePodcastAudioUrl(params: {
  url: string;
  fetchImpl?: FetchLike;
  lookupFn?: LookupFn;
}): Promise<ResolvedPodcastAudio> {
  const parsed = new URL(params.url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "open.spotify.com" ||
    !/^\/episode\/[A-Za-z0-9]+\/?$/.test(parsed.pathname)
  ) {
    throw new Error(
      "This is not a supported podcast URL. Use a Spotify episode URL or a direct audio URL.",
    );
  }

  // Strip tracking parameters before fetching or returning the source URL.
  const sourceUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  const metadata = parseSpotifyMetadata(await fetchText({ ...params, url: sourceUrl }));
  const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(metadata.showTitle)}&entity=podcast&limit=5`;
  const search = JSON.parse(await fetchText({ ...params, url: searchUrl })) as {
    results?: Array<{ collectionName?: string; feedUrl?: string }>;
  };
  const show = search.results?.find(
    (candidate) =>
      candidate.feedUrl &&
      candidate.collectionName &&
      normalizeTitle(candidate.collectionName) === normalizeTitle(metadata.showTitle),
  );
  if (!show?.feedUrl) {
    throw new Error(`No public publisher RSS feed was found for “${metadata.showTitle}”.`);
  }

  const rss = await fetchText({ ...params, url: show.feedUrl });
  for (const item of rss.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = elementText(item[1], "title");
    if (!title || normalizeTitle(title) !== normalizeTitle(metadata.title)) {
      continue;
    }
    const enclosure = enclosureAttributes(item[1]);
    if (!enclosure.url) {
      continue;
    }
    const published = elementText(item[1], "pubDate");
    return {
      audioUrl: normalizeEnclosureUrl(enclosure.url),
      episodeTitle: metadata.title,
      mime: enclosure.type,
      publishedAt: metadata.publishedAt ?? optionalIsoDate(published),
      showTitle: metadata.showTitle,
      sourceUrl,
    };
  }
  throw new Error(`The public publisher RSS feed has no matching episode for “${metadata.title}”.`);
}
