import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import { normalizeDeviceAuthRole, type DeviceAuthStore } from "../shared/device-auth.js";

const DEVICE_AUTH_FILE = "device-auth.json";

type DeviceAuthPaths = {
  canonicalPath: string;
  legacyMirrorPath: string | null;
};

function resolveDeviceAuthPaths(env: NodeJS.ProcessEnv = process.env): DeviceAuthPaths {
  const stateDir = resolveStateDir(env);
  const canonicalPath = path.join(stateDir, "identity", DEVICE_AUTH_FILE);
  const legacyMirrorPath =
    path.basename(path.resolve(stateDir)) === ".openclaw"
      ? path.join(path.dirname(path.resolve(stateDir)), "identity", DEVICE_AUTH_FILE)
      : null;
  return { canonicalPath, legacyMirrorPath };
}

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStore(filePath: string, store: DeviceAuthStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

function writeCanonicalAndMirror(paths: DeviceAuthPaths, store: DeviceAuthStore): void {
  writeStore(paths.canonicalPath, store);
  if (paths.legacyMirrorPath) {
    writeStore(paths.legacyMirrorPath, store);
  }
}

function hasUsableToken(
  store: DeviceAuthStore | null,
  deviceId: string,
  role: string,
): store is DeviceAuthStore {
  if (!store || store.deviceId !== deviceId) {
    return false;
  }
  const token = store.tokens[role]?.token;
  return typeof token === "string" && token.trim().length > 0;
}

function mergeLegacyRoleIntoCanonical(params: {
  canonical: DeviceAuthStore | null;
  legacy: DeviceAuthStore;
  deviceId: string;
  role: string;
}): DeviceAuthStore {
  if (params.canonical?.deviceId !== params.deviceId) {
    return params.legacy;
  }
  const legacyEntry = params.legacy.tokens[params.role];
  if (!legacyEntry) {
    return params.canonical;
  }

  return {
    version: 1,
    deviceId: params.deviceId,
    tokens: {
      ...params.canonical.tokens,
      [params.role]: legacyEntry,
    },
  };
}

function reconcileStoreForRead(params: {
  paths: DeviceAuthPaths;
  deviceId: string;
  role: string;
}): DeviceAuthStore | null {
  const canonical = readStore(params.paths.canonicalPath);
  // `.openclaw` is authoritative. A usable canonical token repairs the legacy
  // mirror so stale app-support auth cannot win on a later launch.
  if (hasUsableToken(canonical, params.deviceId, params.role)) {
    if (params.paths.legacyMirrorPath) {
      writeStore(params.paths.legacyMirrorPath, canonical);
    }
    return canonical;
  }

  const legacy = params.paths.legacyMirrorPath ? readStore(params.paths.legacyMirrorPath) : null;
  if (!hasUsableToken(legacy, params.deviceId, params.role)) {
    return canonical;
  }

  // Legacy only donates the missing role. Canonical may already hold node auth,
  // and importing the full stale mirror would silently break node-host sessions.
  const repaired = mergeLegacyRoleIntoCanonical({
    canonical,
    legacy,
    deviceId: params.deviceId,
    role: params.role,
  });
  writeCanonicalAndMirror(params.paths, repaired);
  return repaired;
}

function reconcileStoreForWrite(params: {
  paths: DeviceAuthPaths;
  deviceId: string;
  role: string;
}): DeviceAuthStore | null {
  const canonical = readStore(params.paths.canonicalPath);
  // Keep same-device roles together; rotating operator must not discard node.
  if (canonical?.deviceId === params.deviceId) {
    return canonical;
  }
  const legacy = params.paths.legacyMirrorPath ? readStore(params.paths.legacyMirrorPath) : null;
  if (hasUsableToken(legacy, params.deviceId, params.role)) {
    const repaired = mergeLegacyRoleIntoCanonical({
      canonical,
      legacy,
      deviceId: params.deviceId,
      role: params.role,
    });
    writeCanonicalAndMirror(params.paths, repaired);
    return repaired;
  }
  return canonical;
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const paths = resolveDeviceAuthPaths(params.env);
  const role = normalizeDeviceAuthRole(params.role);
  const store = reconcileStoreForRead({ paths, deviceId: params.deviceId, role });
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => store, writeStore: (_store) => {} },
    deviceId: params.deviceId,
    role,
  });
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry {
  const paths = resolveDeviceAuthPaths(params.env);
  const role = normalizeDeviceAuthRole(params.role);
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => reconcileStoreForWrite({ paths, deviceId: params.deviceId, role }),
      writeStore: (store) => writeCanonicalAndMirror(paths, store),
    },
    deviceId: params.deviceId,
    role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const paths = resolveDeviceAuthPaths(params.env);
  const role = normalizeDeviceAuthRole(params.role);
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => reconcileStoreForWrite({ paths, deviceId: params.deviceId, role }),
      writeStore: (store) => writeCanonicalAndMirror(paths, store),
    },
    deviceId: params.deviceId,
    role,
  });
}
