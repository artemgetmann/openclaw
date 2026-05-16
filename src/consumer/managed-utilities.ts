import type { OpenClawConfig } from "../config/types.js";
import {
  createJarvisBackendClient,
  type JarvisBackendClient,
  type JarvisManagedUtilityResponse,
} from "./jarvis-backend-client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createJarvisManagedUtilityClient(
  config?: OpenClawConfig,
): JarvisBackendClient | null {
  if (!config) {
    return null;
  }
  // Managed utilities are intentionally gated on explicit managed mode so
  // BYOK/local provider flows stay untouched unless Jarvis is configured.
  const client = createJarvisBackendClient(config);
  if (!client.enabled || client.managedServicesMode !== "managed") {
    return null;
  }
  return client;
}

export function unwrapManagedProviderPayload(
  response: JarvisManagedUtilityResponse,
  expectedProvider: string,
): Record<string, unknown> {
  // The backend owns provider credentials; callers only consume the sanitized
  // provider payload wrapped in the stable managed-utility envelope.
  const result = response.result;
  if (!isRecord(result)) {
    throw new Error("Jarvis managed utility result must be an object");
  }
  if (result.provider !== expectedProvider) {
    throw new Error(
      `Jarvis managed utility returned unexpected provider: ${String(result.provider)}`,
    );
  }
  if (!isRecord(result.payload)) {
    throw new Error("Jarvis managed utility result payload must be an object");
  }
  return result.payload;
}
