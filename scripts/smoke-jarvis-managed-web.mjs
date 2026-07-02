#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SEARCH_QUERY = "OpenAI";
const DEFAULT_SEARCH_COUNT = 1;
const DEFAULT_SCRAPE_URL = "https://openai.com/";
const DEFAULT_TIMEOUT_MS = 60_000;
const LOCAL_PROVIDER_ENV_VARS = ["BRAVE_API_KEY", "FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL"];

function usage() {
  return `Usage: node scripts/smoke-jarvis-managed-web.mjs [options]

Read Jarvis app config, call the managed Brave and Firecrawl utility endpoints,
and print redacted JSON proof for web_search and web_fetch.

Options:
  --config <path>          Config path. Defaults to OPENCLAW_CONFIG_PATH or Jarvis app-support config.
  --search-query <query>   Brave query. Default: ${DEFAULT_SEARCH_QUERY}
  --search-count <n>       Brave result count. Default: ${DEFAULT_SEARCH_COUNT}
  --scrape-url <url>       Firecrawl scrape URL. Default: ${DEFAULT_SCRAPE_URL}
  --skip-search            Do not call brave.search.
  --skip-scrape            Do not call firecrawl.scrape.
  --timeout-ms <ms>        Request timeout. Default: config timeout or ${DEFAULT_TIMEOUT_MS}.
  --keep-provider-env      Do not scrub local Brave/Firecrawl env vars before smoke calls.
  --help                   Show this help.
`;
}

function defaultConfigPath(env = process.env) {
  return (
    env.OPENCLAW_CONFIG_PATH ||
    path.join(os.homedir(), "Library", "Application Support", "Jarvis", ".jarvis", "openclaw.json")
  );
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath(),
    searchQuery: DEFAULT_SEARCH_QUERY,
    searchCount: DEFAULT_SEARCH_COUNT,
    scrapeUrl: DEFAULT_SCRAPE_URL,
    skipSearch: false,
    skipScrape: false,
    scrubProviderEnv: true,
    timeoutMs: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        options.configPath = argv[++index];
        break;
      case "--search-query":
        options.searchQuery = argv[++index];
        break;
      case "--search-count":
        options.searchCount = Number.parseInt(argv[++index], 10);
        break;
      case "--scrape-url":
        options.scrapeUrl = argv[++index];
        break;
      case "--skip-search":
        options.skipSearch = true;
        break;
      case "--skip-scrape":
        options.skipScrape = true;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(argv[++index], 10);
        break;
      case "--keep-provider-env":
        options.scrubProviderEnv = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.help) {
    if (!options.configPath) {
      throw new Error("--config path is required");
    }
    if (
      !Number.isInteger(options.searchCount) ||
      options.searchCount < 1 ||
      options.searchCount > 10
    ) {
      throw new Error("--search-count must be an integer from 1 to 10");
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000)
    ) {
      throw new Error("--timeout-ms must be at least 1000");
    }
  }

  return options;
}

function buildSmokeEnv(env, scrubProviderEnv) {
  const smokeEnv = { ...env };
  const providerEnv = {};
  for (const key of LOCAL_PROVIDER_ENV_VARS) {
    providerEnv[key] = {
      wasConfigured: typeof env[key] === "string" && env[key].trim().length > 0,
      scrubbed: scrubProviderEnv,
    };
    if (scrubProviderEnv) {
      delete smokeEnv[key];
    }
  }
  return { smokeEnv, providerEnv };
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse JSON config at ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveSecretInput(value, env, label) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const envMatch = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/.exec(trimmed);
    if (envMatch) {
      const resolved = env[envMatch[1]]?.trim();
      if (!resolved) {
        throw new Error(`${label} references ${envMatch[1]}, but that env var is empty`);
      }
      return resolved;
    }
    return trimmed || undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  // This smoke intentionally avoids importing the full SecretRef runtime. Env
  // refs cover the common operator path; file/exec refs require gateway snapshot
  // resolution and should not be guessed by an ad hoc script.
  if (value.source === "env" && typeof value.id === "string") {
    const resolved = env[value.id]?.trim();
    if (!resolved) {
      throw new Error(`${label} references ${value.id}, but that env var is empty`);
    }
    return resolved;
  }

  if (value.source === "file" || value.source === "exec") {
    throw new Error(
      `${label} uses ${value.source} SecretRef; run against a resolved Jarvis config or active runtime snapshot instead`,
    );
  }

  return undefined;
}

function normalizeBackendConfig(config, env = process.env) {
  const mode = config?.jarvis?.managedServices?.mode ?? "off";
  const backend = config?.jarvis?.backend ?? {};
  const baseUrlRaw = typeof backend.baseUrl === "string" ? backend.baseUrl.trim() : "";
  if (mode !== "managed") {
    throw new Error(`jarvis.managedServices.mode must be managed (got ${mode})`);
  }
  if (!baseUrlRaw) {
    throw new Error("jarvis.backend.baseUrl is missing");
  }

  const baseUrl = new URL(baseUrlRaw);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("jarvis.backend.baseUrl must use http:// or https://");
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  baseUrl.search = "";
  baseUrl.hash = "";

  const accessToken = resolveSecretInput(backend.accessToken, env, "jarvis.backend.accessToken");
  const accountAccessToken = resolveSecretInput(
    backend.accountAccessToken,
    env,
    "jarvis.backend.accountAccessToken",
  );
  const token = accessToken || accountAccessToken;
  if (!token) {
    throw new Error("jarvis.backend.accessToken or jarvis.backend.accountAccessToken is required");
  }

  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    mode,
    token,
    tokenSource: accessToken ? "accessToken" : "accountAccessToken",
    timeoutMs:
      Number.isFinite(backend.timeoutMs) && backend.timeoutMs > 0
        ? Math.floor(backend.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
    deviceId:
      typeof backend.deviceId === "string" && backend.deviceId.trim()
        ? backend.deviceId.trim()
        : undefined,
  };
}

function redactBackendConfig(backend) {
  const parsed = new URL(backend.baseUrl);
  return {
    baseUrlOrigin: parsed.origin,
    baseUrlPath: parsed.pathname === "/" ? "" : parsed.pathname,
    mode: backend.mode,
    tokenConfigured: true,
    tokenSource: backend.tokenSource,
    deviceIdConfigured: Boolean(backend.deviceId),
  };
}

function managedUtilityUrl(baseUrl, utility) {
  return `${baseUrl}/v1/managed/utilities/${encodeURIComponent(utility)}`;
}

function redactText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(accessToken|accountAccessToken|token|apiKey)"\s*:\s*"[^"]+"/gi, '$1":"[REDACTED]"')
    .slice(0, 2_000);
}

async function callManagedUtility(params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await params.fetchImpl(
      managedUtilityUrl(params.backend.baseUrl, params.utility),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.backend.token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          deviceId: params.backend.deviceId,
          input: params.input,
        }),
      },
    );
    const bodyText = await response.text();
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      throw new Error(`HTTP ${response.status} returned non-JSON body: ${redactText(bodyText)}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${redactText(JSON.stringify(body))}`);
    }
    if (!body || body.ok !== true || !isRecord(body.result)) {
      throw new Error(`unexpected managed utility envelope: ${redactText(JSON.stringify(body))}`);
    }
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

function firstResultHost(results) {
  if (!Array.isArray(results) || !results[0] || typeof results[0] !== "object") {
    return null;
  }
  const result = results[0];
  const candidate = result.url || result.link || result.href;
  if (typeof candidate !== "string" || !candidate.trim()) {
    return null;
  }
  try {
    return new URL(candidate).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function summarizeBraveResult(result) {
  if (result.provider !== "brave") {
    throw new Error(`brave.search returned unexpected provider: ${String(result.provider)}`);
  }
  const payload = isRecord(result.payload) ? result.payload : {};
  const web = isRecord(payload.web) ? payload.web : {};
  const results = Array.isArray(web.results) ? web.results : [];
  return {
    tool: "web_search",
    utility: "brave.search",
    provider: result.provider ?? null,
    resultCount: results.length,
    firstHost: firstResultHost(results),
  };
}

function summarizeFirecrawlResult(result) {
  if (result.provider !== "firecrawl") {
    throw new Error(`firecrawl.scrape returned unexpected provider: ${String(result.provider)}`);
  }
  const payload = isRecord(result.payload) ? result.payload : {};
  const data = isRecord(payload.data) ? payload.data : {};
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  return {
    tool: "web_fetch",
    utility: "firecrawl.scrape",
    provider: result.provider ?? null,
    markdownLength: markdown.length,
    titlePresent: typeof metadata.title === "string" && metadata.title.trim().length > 0,
  };
}

export async function runManagedWebSmoke(options = {}) {
  const sourceEnv = options.env ?? process.env;
  const { smokeEnv, providerEnv } = buildSmokeEnv(sourceEnv, options.scrubProviderEnv ?? true);
  const configPath = options.configPath ?? defaultConfigPath(smokeEnv);
  const config = options.config ?? (await readJsonFile(configPath));
  const backend = normalizeBackendConfig(config, smokeEnv);
  const timeoutMs = options.timeoutMs ?? backend.timeoutMs;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable; use Node 18+");
  }

  const calls = [];
  if (!options.skipSearch) {
    const result = await callManagedUtility({
      backend,
      fetchImpl,
      timeoutMs,
      utility: "brave.search",
      input: {
        query: options.searchQuery ?? DEFAULT_SEARCH_QUERY,
        count: options.searchCount ?? DEFAULT_SEARCH_COUNT,
      },
    });
    calls.push(summarizeBraveResult(result));
  }

  if (!options.skipScrape) {
    const result = await callManagedUtility({
      backend,
      fetchImpl,
      timeoutMs,
      utility: "firecrawl.scrape",
      input: {
        url: options.scrapeUrl ?? DEFAULT_SCRAPE_URL,
      },
    });
    calls.push(summarizeFirecrawlResult(result));
  }

  return {
    ok: true,
    configPath,
    backend: redactBackendConfig(backend),
    localProviderEnv: providerEnv,
    calls,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runManagedWebSmoke(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[smoke-jarvis-managed-web] ${error.message}`);
    process.exit(1);
  });
}
