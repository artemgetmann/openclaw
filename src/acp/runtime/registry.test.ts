import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "./errors.js";
import {
  __testing,
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "./registry.js";
import type { AcpRuntime } from "./types.js";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRuntimeStub(): AcpRuntime {
  return {
    ensureSession: vi.fn(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "stub",
      runtimeSessionName: `${input.sessionKey}:runtime`,
    })),
    runTurn: vi.fn(async function* () {
      // no-op stream
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe("acp runtime registry", () => {
  beforeEach(() => {
    __testing.resetAcpRuntimeBackendsForTests();
  });

  it("registers and resolves backends by id", () => {
    const runtime = createRuntimeStub();
    registerAcpRuntimeBackend({ id: "acpx", runtime });

    const backend = getAcpRuntimeBackend("acpx");
    expect(backend?.id).toBe("acpx");
    expect(backend?.runtime).toBe(runtime);
  });

  it("prefers a healthy backend when resolving without explicit id", () => {
    const unhealthyRuntime = createRuntimeStub();
    const healthyRuntime = createRuntimeStub();

    registerAcpRuntimeBackend({
      id: "unhealthy",
      runtime: unhealthyRuntime,
      healthy: () => false,
    });
    registerAcpRuntimeBackend({
      id: "healthy",
      runtime: healthyRuntime,
      healthy: () => true,
    });

    const backend = getAcpRuntimeBackend();
    expect(backend?.id).toBe("healthy");
  });

  it("throws a typed missing-backend error when no backend is registered", async () => {
    await expect(requireAcpRuntimeBackend()).rejects.toBeInstanceOf(AcpRuntimeError);
    await expect(requireAcpRuntimeBackend()).rejects.toThrowError(
      /ACP runtime backend is not configured/i,
    );
  });

  it("waits for in-flight readiness before failing a backend lookup", async () => {
    const ready = createDeferred<void>();
    const healthy = vi.fn(() => false);
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: createRuntimeStub(),
      healthy,
      ready: () => ready.promise,
    });

    const lookup = requireAcpRuntimeBackend("acpx");
    expect(healthy).toHaveBeenCalledTimes(1);

    ready.resolve();

    await expect(lookup).rejects.toMatchObject({
      code: "ACP_BACKEND_UNAVAILABLE",
    });
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("throws a typed unavailable error when the requested backend is unhealthy", async () => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: createRuntimeStub(),
      healthy: () => false,
    });

    await expect(requireAcpRuntimeBackend("acpx")).rejects.toMatchObject({
      code: "ACP_BACKEND_UNAVAILABLE",
    });
  });

  it("unregisters a backend by id", () => {
    registerAcpRuntimeBackend({ id: "acpx", runtime: createRuntimeStub() });
    unregisterAcpRuntimeBackend("acpx");
    expect(getAcpRuntimeBackend("acpx")).toBeNull();
  });

  it("keeps backend state on a global registry for cross-loader access", () => {
    const runtime = createRuntimeStub();
    const sharedState = __testing.getAcpRuntimeRegistryGlobalStateForTests();

    sharedState.backendsById.set("acpx", {
      id: "acpx",
      runtime,
    });

    const backend = getAcpRuntimeBackend("acpx");
    expect(backend?.runtime).toBe(runtime);
  });
});
