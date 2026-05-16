import type { OpenClawConfig } from "../config/types.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import {
  createJarvisManagedUtilityClient,
  unwrapManagedProviderPayload,
} from "./managed-utilities.js";

export const GOOGLE_PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

const GOOGLE_PLACES_SEARCH_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,nextPageToken";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_ERROR_MAX_BYTES = 16_000;

type FetchLike = typeof fetch;

export type GooglePlacesSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  limit?: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
};

export type GooglePlacesSearchResult = {
  provider: "google_places";
  transport: "jarvis-managed" | "direct";
  query: string;
  count: number;
  places: unknown[];
  payload: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

function readConfigEnvVar(config: OpenClawConfig | undefined, key: string): string | undefined {
  const varsValue = config?.env?.vars?.[key];
  if (typeof varsValue === "string" && varsValue.trim()) {
    return varsValue.trim();
  }
  const directValue = config?.env?.[key];
  if (typeof directValue === "string" && directValue.trim()) {
    return directValue.trim();
  }
  return undefined;
}

export function resolveGooglePlacesApiKey(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const hostValue = env.GOOGLE_PLACES_API_KEY?.trim();
  if (hostValue) {
    return hostValue;
  }

  const configEnvValue = readConfigEnvVar(config, "GOOGLE_PLACES_API_KEY");
  if (configEnvValue) {
    return configEnvValue;
  }

  // Preserve the legacy skill config path so BYOK users do not need to move
  // keys just because managed-plan users route through the backend.
  return normalizeResolvedSecretInputString({
    value: config?.skills?.entries?.goplaces?.apiKey,
    path: "skills.entries.goplaces.apiKey",
  });
}

async function readResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { text };
  }
}

function redactedProviderError(payload: Record<string, unknown>, apiKey: string): string {
  const raw = JSON.stringify(payload).slice(0, DEFAULT_ERROR_MAX_BYTES);
  return raw.split(apiKey).join("[redacted]");
}

async function postDirectGooglePlacesSearch(params: {
  query: string;
  limit: number;
  apiKey: string;
  fetchImpl: FetchLike;
}): Promise<Record<string, unknown>> {
  const response = await params.fetchImpl(GOOGLE_PLACES_TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": params.apiKey,
      "X-Goog-FieldMask": GOOGLE_PLACES_SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: params.query,
      pageSize: params.limit,
    }),
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(
      `Google Places API error (${response.status}): ${redactedProviderError(payload, params.apiKey)}`,
    );
  }
  return payload;
}

function buildGooglePlacesSearchResult(params: {
  query: string;
  transport: GooglePlacesSearchResult["transport"];
  payload: Record<string, unknown>;
}): GooglePlacesSearchResult {
  const places = Array.isArray(params.payload.places) ? params.payload.places : [];
  return {
    provider: "google_places",
    transport: params.transport,
    query: params.query,
    count: places.length,
    places,
    payload: params.payload,
  };
}

export async function runGooglePlacesSearch(
  params: GooglePlacesSearchParams,
): Promise<GooglePlacesSearchResult> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("Google Places search requires a query");
  }

  const limit = normalizeLimit(params.limit);
  const managedClient = createJarvisManagedUtilityClient(params.cfg);
  if (managedClient) {
    const payload = unwrapManagedProviderPayload(
      await managedClient.callManagedUtility({
        utility: "google_places.search",
        input: { query, limit },
      }),
      "google_places",
    );
    return buildGooglePlacesSearchResult({
      query,
      transport: "jarvis-managed",
      payload,
    });
  }

  const apiKey = resolveGooglePlacesApiKey(params.cfg, params.env);
  if (!apiKey) {
    throw new Error(
      "Google Places search needs a Google Places API key unless Jarvis managed services are configured. Set GOOGLE_PLACES_API_KEY or skills.entries.goplaces.apiKey for BYOK mode.",
    );
  }

  const payload = await postDirectGooglePlacesSearch({
    query,
    limit,
    apiKey,
    fetchImpl: params.fetchImpl ?? fetch,
  });
  return buildGooglePlacesSearchResult({
    query,
    transport: "direct",
    payload,
  });
}
