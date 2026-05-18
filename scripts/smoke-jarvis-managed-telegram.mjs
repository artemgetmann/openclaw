#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://jarvis-backend-klvq.onrender.com";
const TOKEN_REDACTION = "[redacted]";

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readFlag(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function help() {
  return [
    "Usage: node scripts/smoke-jarvis-managed-telegram.mjs [mode] [options]",
    "",
    "Safe smoke helper for Jarvis backend Telegram Managed Bots endpoints.",
    "No live calls are made unless --health-only, --start, or --status <setupId> is passed.",
    "",
    "Environment:",
    `  JARVIS_BACKEND_BASE_URL     Backend URL. Default: ${DEFAULT_BASE_URL}`,
    "  JARVIS_BACKEND_API_TOKEN    Backend bearer token for start/status. Never printed.",
    "",
    "Modes:",
    "  --health-only               GET /healthz and print provider flags.",
    "  --start                     POST /v1/telegram/managed/start.",
    "  --status <setupId>          GET /v1/telegram/managed/status/{setupId}.",
    "",
    "Start options:",
    "  --device-id <id>            Optional deviceId. Must satisfy backend length rules.",
    "  --app-version <version>     Optional appVersion.",
    "  --account-token <token>     Optional accountAccessToken. Never printed.",
    "  --suggested-bot-name <name> Optional suggestedBotName.",
    "  --suggested-bot-username <username>",
    "                              Optional suggestedBotUsername, with or without @.",
    "",
    "Other options:",
    "  --json                      Print sanitized JSON only.",
    "  --help                      Show this help.",
  ].join("\n");
}

function parseOptions() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(help());
    process.exit(0);
  }

  const start = hasFlag("--start");
  const statusSetupId = readFlag("--status");
  const healthOnly = hasFlag("--health-only");
  // Force an explicit mode so a bare invocation cannot accidentally touch Render.
  const selectedModes = [healthOnly, start, Boolean(statusSetupId)].filter(Boolean).length;
  if (selectedModes === 0) {
    throw new Error("Choose one mode: --health-only, --start, or --status <setupId>.");
  }
  if (selectedModes > 1) {
    throw new Error("Choose only one live mode per run so smoke output stays unambiguous.");
  }

  return {
    baseUrl: normalizeBaseUrl(process.env.JARVIS_BACKEND_BASE_URL || DEFAULT_BASE_URL),
    apiToken: process.env.JARVIS_BACKEND_API_TOKEN || "",
    healthOnly,
    start,
    statusSetupId,
    json: hasFlag("--json"),
    request: {
      deviceId: readFlag("--device-id"),
      appVersion: readFlag("--app-version"),
      accountAccessToken: readFlag("--account-token"),
      suggestedBotName: readFlag("--suggested-bot-name"),
      suggestedBotUsername: readFlag("--suggested-bot-username"),
    },
  };
}

function normalizeBaseUrl(raw) {
  const parsed = new URL(raw);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function endpointUrl(baseUrl, path) {
  return `${baseUrl}${path}`;
}

function requireBearerToken(apiToken) {
  if (!apiToken.trim()) {
    throw new Error("JARVIS_BACKEND_API_TOKEN is required for start/status calls.");
  }
}

function compactRequest(request) {
  return Object.fromEntries(
    Object.entries(request).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

function redactedPayload(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactedPayload(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    // These fields can contain live bearer material; preserve shape, never value.
    if (key === "managedChildBotToken" || key === "accountAccessToken") {
      redacted[key] = entry ? TOKEN_REDACTION : entry;
      continue;
    }
    redacted[key] = redactedPayload(entry);
  }
  return redacted;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { rawBody: text };
  }
  if (!response.ok) {
    // Backend/provider errors can echo request context. Sanitize before printing.
    const sanitized = JSON.stringify(redactedPayload(body));
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${sanitized}`);
  }
  return body;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  return readJsonResponse(response);
}

function authHeaders(apiToken) {
  return { authorization: `Bearer ${apiToken}` };
}

async function health(options) {
  const body = await requestJson(endpointUrl(options.baseUrl, "/healthz"));
  return {
    status: body.status,
    service: body.service,
    version: body.version,
    environment: body.environment,
    providers: body.providers,
  };
}

async function start(options) {
  requireBearerToken(options.apiToken);
  const body = await requestJson(endpointUrl(options.baseUrl, "/v1/telegram/managed/start"), {
    method: "POST",
    headers: authHeaders(options.apiToken),
    body: JSON.stringify(compactRequest(options.request)),
  });
  return redactedPayload(body);
}

async function status(options) {
  requireBearerToken(options.apiToken);
  const setupId = encodeURIComponent(options.statusSetupId);
  const body = await requestJson(
    endpointUrl(options.baseUrl, `/v1/telegram/managed/status/${setupId}`),
    { headers: authHeaders(options.apiToken) },
  );
  return redactedPayload(body);
}

function printHuman(mode, result) {
  if (mode === "health") {
    console.log(`health: ${result.status}`);
    console.log(`service: ${result.service}`);
    console.log(`environment: ${result.environment}`);
    console.log(`version: ${result.version}`);
    console.log("providers:");
    for (const [provider, present] of Object.entries(result.providers || {})) {
      console.log(`  ${provider}: ${String(present)}`);
    }
    return;
  }

  console.log(`setupId: ${result.setupId}`);
  console.log(`status: ${result.status}`);
  if (result.approvalUrl) {
    console.log(`approvalUrl: ${result.approvalUrl}`);
  }
  if (result.suggestedBotUsername) {
    console.log(`suggestedBotUsername: ${result.suggestedBotUsername}`);
  }
  if (result.expiresAt) {
    console.log(`expiresAt: ${result.expiresAt}`);
  }
  if (result.status === "connected") {
    console.log(`botUsername: ${result.botUsername}`);
    console.log(`botId: ${result.botId}`);
    console.log(`managedChildBotToken: ${result.managedChildBotToken || null}`);
  }
}

async function main() {
  const options = parseOptions();
  const [mode, result] = options.healthOnly
    ? ["health", await health(options)]
    : options.start
      ? ["start", await start(options)]
      : ["status", await status(options)];

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(mode, result);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
