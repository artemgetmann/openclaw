import type { SecretInput } from "./types.secrets.js";

export type JarvisManagedServicesMode = "off" | "license-only" | "managed";

export type JarvisBackendConfig = {
  /** Jarvis commercial backend base URL. Unset keeps all managed services inert. */
  baseUrl?: string;
  /** Optional bearer token issued by the Jarvis backend. Never log this value. */
  accessToken?: SecretInput;
  /** Stable app/device identifier for license checks. */
  deviceId?: string;
  /** Request timeout for Jarvis backend calls. Default: 10000. */
  timeoutMs?: number;
};

export type JarvisManagedServicesConfig = {
  /**
   * off: BYOK/local only.
   * license-only: allow license/status checks, but no managed utility proxying.
   * managed: allow license/status checks and server-held-key utility calls.
   */
  mode?: JarvisManagedServicesMode;
};

export type JarvisConfig = {
  backend?: JarvisBackendConfig;
  managedServices?: JarvisManagedServicesConfig;
};
