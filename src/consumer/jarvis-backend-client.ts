import type { OpenClawConfig } from "../config/types.js";
import { normalizeResolvedSecretInputString, type SecretInput } from "../config/types.secrets.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "../memory/remote-http.js";

export type JarvisLicenseState =
  | "disabled"
  | "unknown"
  | "trial_active"
  | "trial_expired"
  | "licensed"
  | "expired";

export type JarvisLicenseStatus = {
  state: JarvisLicenseState;
  managedServicesMode: "off" | "license-only" | "managed";
  deviceId?: string;
  trialEndsAt?: string;
  trialStartedAt?: string;
  licenseEndsAt?: string;
  offlineGraceEndsAt?: string;
  accountId?: string;
  managedServicesEnabled?: boolean;
};

export type JarvisAccountLoginResponse = {
  accountId: string;
  email: string;
  accountAccessToken: string;
  license: JarvisLicenseStatus;
};

export type JarvisManagedUtilityResponse<T = unknown> = {
  ok: true;
  result: T;
  usage?: {
    units?: number;
    limit?: number;
    remaining?: number;
  };
};

export type JarvisBackendClient = {
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly managedServicesMode: "off" | "license-only" | "managed";
  activateTrial: (params: JarvisAccountLoginRequest) => Promise<JarvisAccountLoginResponse>;
  getLicenseStatus: (params?: JarvisLicenseStatusRequest) => Promise<JarvisLicenseStatus>;
  callManagedUtility: <T = unknown>(
    params: JarvisManagedUtilityRequest,
  ) => Promise<JarvisManagedUtilityResponse<T>>;
};

export type JarvisLicenseStatusRequest = {
  accountAccessToken?: string;
  appVersion?: string;
  deviceId?: string;
};

export type JarvisAccountLoginRequest = {
  email: string;
  appVersion?: string;
  deviceId?: string;
};

export type JarvisManagedUtilityRequest = {
  utility: string;
  input?: unknown;
  appVersion?: string;
  deviceId?: string;
};

type JarvisBackendClientDeps = {
  fetchResponse?: typeof withRemoteHttpResponse;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DISABLED_LICENSE_STATUS: JarvisLicenseStatus = {
  state: "disabled",
  managedServicesMode: "off",
};

function normalizeManagedServicesMode(config: OpenClawConfig): "off" | "license-only" | "managed" {
  return config.jarvis?.managedServices?.mode ?? "off";
}

function normalizeBaseUrl(baseUrl: string | undefined): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("jarvis.backend.baseUrl must use http:// or https://");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function resolveSecretInputString(
  value: SecretInput | undefined,
  path: string,
): string | undefined {
  return normalizeResolvedSecretInputString({
    value,
    path,
  });
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function readStringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLicenseStatus(
  payload: unknown,
  managedServicesMode: "off" | "license-only" | "managed",
): JarvisLicenseStatus {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Jarvis license response must be an object");
  }
  const record = payload as Record<string, unknown>;
  const rawState = readStringField(record, "state");
  const allowedStates = new Set<JarvisLicenseState>([
    "unknown",
    "trial_active",
    "trial_expired",
    "licensed",
    "expired",
  ]);
  const state = allowedStates.has(rawState as JarvisLicenseState)
    ? (rawState as JarvisLicenseState)
    : "unknown";
  return {
    state,
    managedServicesMode,
    deviceId: readStringField(record, "deviceId"),
    trialStartedAt: readStringField(record, "trialStartedAt"),
    trialEndsAt: readStringField(record, "trialEndsAt"),
    licenseEndsAt: readStringField(record, "licenseEndsAt"),
    offlineGraceEndsAt: readStringField(record, "offlineGraceEndsAt"),
    accountId: readStringField(record, "accountId"),
    managedServicesEnabled:
      typeof record.managedServicesEnabled === "boolean"
        ? record.managedServicesEnabled
        : undefined,
  };
}

function parseAccountLoginResponse(
  payload: unknown,
  managedServicesMode: "off" | "license-only" | "managed",
): JarvisAccountLoginResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Jarvis account login response must be an object");
  }
  const record = payload as Record<string, unknown>;
  const accountId = readStringField(record, "accountId");
  const email = readStringField(record, "email");
  const accountAccessToken = readStringField(record, "accountAccessToken");
  if (!accountId || !email || !accountAccessToken) {
    throw new Error("Jarvis account login response is missing account fields");
  }
  return {
    accountId,
    email,
    accountAccessToken,
    license: parseLicenseStatus(record.license, managedServicesMode),
  };
}

function parseManagedUtilityResponse<T>(payload: unknown): JarvisManagedUtilityResponse<T> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Jarvis managed utility response must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error("Jarvis managed utility response must include ok=true");
  }
  return {
    ok: true,
    result: record.result as T,
    usage:
      record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
        ? (record.usage as JarvisManagedUtilityResponse<T>["usage"])
        : undefined,
  };
}

function buildHeaders(accessToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

export function createJarvisBackendClient(
  config: OpenClawConfig,
  deps: JarvisBackendClientDeps = {},
): JarvisBackendClient {
  const managedServicesMode = normalizeManagedServicesMode(config);
  const baseUrl = normalizeBaseUrl(config.jarvis?.backend?.baseUrl);
  const enabled = Boolean(baseUrl && managedServicesMode !== "off");
  const accessToken = enabled
    ? resolveSecretInputString(config.jarvis?.backend?.accessToken, "jarvis.backend.accessToken")
    : undefined;
  const accountAccessToken = enabled
    ? resolveSecretInputString(
        config.jarvis?.backend?.accountAccessToken,
        "jarvis.backend.accountAccessToken",
      )
    : undefined;
  // Packaged onboarding stores the user-scoped Jarvis account token in
  // Keychain and exposes it as accountAccessToken. Managed utility calls can
  // use that token when no build-scoped backend token is present.
  const managedUtilityAccessToken = accessToken ?? accountAccessToken;
  const timeoutMs = config.jarvis?.backend?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configuredDeviceId = config.jarvis?.backend?.deviceId;
  const fetchResponse = deps.fetchResponse ?? withRemoteHttpResponse;

  return {
    enabled,
    baseUrl,
    managedServicesMode,
    async activateTrial(params) {
      if (!enabled || !baseUrl) {
        throw new Error("Jarvis account activation requires a configured Jarvis backend");
      }
      const email = params.email.trim();
      if (!email) {
        throw new Error("Jarvis account activation requires an email");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchResponse({
          url: buildUrl(baseUrl, "/v1/account/login"),
          ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
          auditContext: "jarvis-account-login",
          init: {
            method: "POST",
            headers: buildHeaders(accessToken),
            signal: controller.signal,
            body: JSON.stringify({
              email,
              appVersion: params.appVersion,
              deviceId: params.deviceId ?? configuredDeviceId,
            }),
          },
          onResponse: async (response) => {
            if (!response.ok) {
              throw new Error(`Jarvis account activation failed with HTTP ${response.status}`);
            }
            return parseAccountLoginResponse(await response.json(), managedServicesMode);
          },
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    async getLicenseStatus(params = {}) {
      if (!enabled || !baseUrl) {
        return DISABLED_LICENSE_STATUS;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchResponse({
          url: buildUrl(baseUrl, "/v1/license/status"),
          ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
          auditContext: "jarvis-license-status",
          init: {
            method: "POST",
            headers: buildHeaders(managedUtilityAccessToken),
            signal: controller.signal,
            body: JSON.stringify({
              accountAccessToken: params.accountAccessToken ?? accountAccessToken,
              appVersion: params.appVersion,
              deviceId: params.deviceId ?? configuredDeviceId,
            }),
          },
          onResponse: async (response) => {
            if (!response.ok) {
              throw new Error(`Jarvis license status failed with HTTP ${response.status}`);
            }
            return parseLicenseStatus(await response.json(), managedServicesMode);
          },
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    async callManagedUtility<T = unknown>(
      params: JarvisManagedUtilityRequest,
    ): Promise<JarvisManagedUtilityResponse<T>> {
      if (!enabled || !baseUrl || managedServicesMode !== "managed") {
        throw new Error("Jarvis managed utility calls require jarvis.managedServices.mode=managed");
      }
      const utility = params.utility.trim();
      if (!/^[a-z][a-z0-9._-]{0,127}$/.test(utility)) {
        throw new Error("Jarvis managed utility id is invalid");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchResponse({
          url: buildUrl(baseUrl, `/v1/managed/utilities/${encodeURIComponent(utility)}`),
          ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
          auditContext: "jarvis-managed-utility",
          init: {
            method: "POST",
            headers: buildHeaders(managedUtilityAccessToken),
            signal: controller.signal,
            body: JSON.stringify({
              appVersion: params.appVersion,
              deviceId: params.deviceId ?? configuredDeviceId,
              input: params.input,
            }),
          },
          onResponse: async (response) => {
            if (!response.ok) {
              throw new Error(`Jarvis managed utility failed with HTTP ${response.status}`);
            }
            return parseManagedUtilityResponse<T>(await response.json());
          },
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
