import { AcpRuntimeError } from "./errors.js";
import type { AcpRuntime } from "./types.js";

export type AcpRuntimeBackend = {
  id: string;
  runtime: AcpRuntime;
  healthy?: () => boolean;
  ready?: () => Promise<void>;
};

type AcpRuntimeRegistryGlobalState = {
  backendsById: Map<string, AcpRuntimeBackend>;
};

const ACP_RUNTIME_REGISTRY_STATE_KEY = Symbol.for("openclaw.acpRuntimeRegistryState");

function createAcpRuntimeRegistryGlobalState(): AcpRuntimeRegistryGlobalState {
  return {
    backendsById: new Map<string, AcpRuntimeBackend>(),
  };
}

function resolveAcpRuntimeRegistryGlobalState(): AcpRuntimeRegistryGlobalState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [ACP_RUNTIME_REGISTRY_STATE_KEY]?: AcpRuntimeRegistryGlobalState;
  };
  if (!runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY]) {
    runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY] = createAcpRuntimeRegistryGlobalState();
  }
  return runtimeGlobal[ACP_RUNTIME_REGISTRY_STATE_KEY];
}

const ACP_BACKENDS_BY_ID = resolveAcpRuntimeRegistryGlobalState().backendsById;

function normalizeBackendId(id: string | undefined): string {
  return id?.trim().toLowerCase() || "";
}

function isBackendHealthy(backend: AcpRuntimeBackend): boolean {
  if (!backend.healthy) {
    return true;
  }
  try {
    return backend.healthy();
  } catch {
    return false;
  }
}

async function waitForBackendReadiness(backend: AcpRuntimeBackend): Promise<void> {
  if (!backend.ready) {
    return;
  }
  try {
    // Readiness failures still surface through the health re-check below.
    await backend.ready();
  } catch {
    // Swallow here so callers consistently receive the typed unavailable error.
  }
}

export function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void {
  const id = normalizeBackendId(backend.id);
  if (!id) {
    throw new Error("ACP runtime backend id is required");
  }
  if (!backend.runtime) {
    throw new Error(`ACP runtime backend "${id}" is missing runtime implementation`);
  }
  ACP_BACKENDS_BY_ID.set(id, {
    ...backend,
    id,
  });
}

export function unregisterAcpRuntimeBackend(id: string): void {
  const normalized = normalizeBackendId(id);
  if (!normalized) {
    return;
  }
  ACP_BACKENDS_BY_ID.delete(normalized);
}

export function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null {
  const normalized = normalizeBackendId(id);
  if (normalized) {
    return ACP_BACKENDS_BY_ID.get(normalized) ?? null;
  }
  if (ACP_BACKENDS_BY_ID.size === 0) {
    return null;
  }
  for (const backend of ACP_BACKENDS_BY_ID.values()) {
    if (isBackendHealthy(backend)) {
      return backend;
    }
  }
  return ACP_BACKENDS_BY_ID.values().next().value ?? null;
}

export async function requireAcpRuntimeBackend(id?: string): Promise<AcpRuntimeBackend> {
  const normalized = normalizeBackendId(id);
  const backend = getAcpRuntimeBackend(normalized || undefined);
  if (!backend) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_MISSING",
      "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
    );
  }
  if (!isBackendHealthy(backend)) {
    // A backend can be registered before its first install/probe pass completes.
    // Wait for that in-flight readiness work once so initial ACP requests do not
    // fail on a stale unhealthy flag.
    await waitForBackendReadiness(backend);
    if (!isBackendHealthy(backend)) {
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "ACP runtime backend is currently unavailable. Try again in a moment.",
      );
    }
  }
  if (normalized && backend.id !== normalized) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_MISSING",
      `ACP runtime backend "${normalized}" is not registered.`,
    );
  }
  return backend;
}

export const __testing = {
  resetAcpRuntimeBackendsForTests() {
    ACP_BACKENDS_BY_ID.clear();
  },
  getAcpRuntimeRegistryGlobalStateForTests() {
    return resolveAcpRuntimeRegistryGlobalState();
  },
};
