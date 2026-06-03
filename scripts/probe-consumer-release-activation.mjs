#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_REDACTION = "[redacted]";
const TOKENISH_KEY_PATTERN = /token|authorization|secret|credential/i;

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function normalizeBaseUrl(rawBaseUrl) {
  const value = rawBaseUrl.trim();
  if (!value) {
    throw new Error("consumer-seeded-defaults.json is missing jarvis.backend.baseUrl");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("jarvis.backend.baseUrl must use http:// or https://");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function readNestedString(root, pathParts) {
  let cursor = root;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : undefined;
}

function replaceKnownSecrets(value, secrets) {
  return secrets.reduce((current, secret) => {
    if (!secret) {
      return current;
    }
    return current.split(secret).join(TOKEN_REDACTION);
  }, value);
}

function redactForStatus(value, secrets = []) {
  if (typeof value === "string") {
    return replaceKnownSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactForStatus(entry, secrets));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    // Backend errors can echo request headers or account tokens. Preserve the
    // shape so release logs stay useful, but never preserve bearer material.
    redacted[key] = TOKENISH_KEY_PATTERN.test(key)
      ? TOKEN_REDACTION
      : redactForStatus(entry, secrets);
  }
  return redacted;
}

async function readJsonResponse(response, secrets) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return redactForStatus(JSON.parse(text), secrets);
  } catch {
    return { rawBody: redactForStatus(text, secrets) };
  }
}

export async function readPackagedConsumerBackendConfig(defaultsPath) {
  const resolvedPath = path.resolve(defaultsPath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  const baseUrl = readNestedString(parsed, ["jarvis", "backend", "baseUrl"]);
  const accessToken = readNestedString(parsed, ["jarvis", "backend", "accessToken"]);

  if (!baseUrl) {
    throw new Error("consumer-seeded-defaults.json is missing jarvis.backend.baseUrl");
  }
  if (!accessToken) {
    throw new Error("consumer-seeded-defaults.json is missing jarvis.backend.accessToken");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    accessToken,
  };
}

export function parseReleaseActivationProbeArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  const defaultsPath = argv.find((arg) => !arg.startsWith("--"));
  const email = readFlag(argv, "--email");
  const deviceId = readFlag(argv, "--device-id");
  const appVersion = readFlag(argv, "--app-version");

  if (!defaultsPath) {
    throw new Error(
      "Usage: node scripts/probe-consumer-release-activation.mjs <consumer-seeded-defaults.json> --email <email> --device-id <id> [--app-version <version>]",
    );
  }
  if (!email?.trim()) {
    throw new Error("--email is required because /v1/account/login creates activation state");
  }
  if (!deviceId?.trim()) {
    throw new Error("--device-id is required because /v1/account/login links a device trial");
  }

  return {
    defaultsPath,
    email: email.trim(),
    deviceId: deviceId.trim(),
    appVersion: appVersion?.trim() || undefined,
  };
}

export function releaseActivationProbeHelp() {
  return [
    "Usage: node scripts/probe-consumer-release-activation.mjs <consumer-seeded-defaults.json> --email <email> --device-id <id> [--app-version <version>]",
    "",
    "Reads packaged Jarvis backend defaults and POSTs /v1/account/login.",
    "Output is one sanitized JSON status line. Token values are never printed.",
  ].join("\n");
}

export async function runReleaseActivationProbe(params, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }

  const backend = await readPackagedConsumerBackendConfig(params.defaultsPath);
  const endpoint = `${backend.baseUrl}/v1/account/login`;
  const secrets = [backend.accessToken];

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${backend.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: params.email,
      deviceId: params.deviceId,
      appVersion: params.appVersion,
      platform: "macos",
    }),
  });
  const body = await readJsonResponse(response, secrets);

  const license =
    body && typeof body === "object" && !Array.isArray(body) && body.license
      ? body.license
      : undefined;
  const licenseState =
    license && typeof license === "object" && !Array.isArray(license) ? license.state : undefined;

  return {
    ok: response.ok,
    httpStatus: response.status,
    statusText: response.statusText,
    endpoint,
    backendBaseUrl: backend.baseUrl,
    backendAccessToken: TOKEN_REDACTION,
    accountAccessToken:
      body && typeof body === "object" && !Array.isArray(body) && "accountAccessToken" in body
        ? TOKEN_REDACTION
        : undefined,
    licenseState: typeof licenseState === "string" ? licenseState : undefined,
    response: response.ok ? undefined : body,
  };
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((line) => console.log(line));
  try {
    const options = parseReleaseActivationProbeArgs(argv);
    if (options.help) {
      stdout(releaseActivationProbeHelp());
      return 0;
    }
    const status = await runReleaseActivationProbe(options, deps);
    stdout(JSON.stringify(status));
    return status.ok ? 0 : 1;
  } catch (error) {
    stdout(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? redactForStatus(error.message) : "Unknown error",
      }),
    );
    return 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  process.exitCode = await runCli();
}
