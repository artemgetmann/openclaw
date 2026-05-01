import { describe, expect, it, vi } from "vitest";
import { createJarvisBackendClient } from "./jarvis-backend-client.js";

describe("createJarvisBackendClient", () => {
  it("is inert when Jarvis config is absent", async () => {
    const fetchResponse = vi.fn();
    const client = createJarvisBackendClient({}, { fetchResponse });

    await expect(client.getLicenseStatus()).resolves.toEqual({
      state: "disabled",
      managedServicesMode: "off",
    });
    expect(client.enabled).toBe(false);
    expect(fetchResponse).not.toHaveBeenCalled();
  });

  it("checks license status when a backend and license-only mode are configured", async () => {
    const fetchResponse = vi.fn(async (params) => {
      expect(params.url).toBe("https://jarvis.example/v1/license/status");
      expect(params.init.headers.Authorization).toBe("Bearer test-token");
      expect(JSON.parse(params.init.body)).toEqual({
        appVersion: "1.2.3",
        deviceId: "device-1",
      });
      return await params.onResponse(
        new Response(
          JSON.stringify({
            state: "trial_active",
            trialEndsAt: "2026-05-15T00:00:00.000Z",
          }),
          { status: 200 },
        ),
      );
    });
    const client = createJarvisBackendClient(
      {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example/",
            accessToken: "test-token",
            deviceId: "device-1",
          },
          managedServices: { mode: "license-only" },
        },
      },
      { fetchResponse },
    );

    await expect(client.getLicenseStatus({ appVersion: "1.2.3" })).resolves.toEqual({
      state: "trial_active",
      managedServicesMode: "license-only",
      trialEndsAt: "2026-05-15T00:00:00.000Z",
      licenseEndsAt: undefined,
      offlineGraceEndsAt: undefined,
      accountId: undefined,
    });
  });

  it("blocks managed utility calls unless managed mode is explicit", async () => {
    const client = createJarvisBackendClient({
      jarvis: {
        backend: { baseUrl: "https://jarvis.example" },
        managedServices: { mode: "license-only" },
      },
    });

    await expect(client.callManagedUtility({ utility: "summarize" })).rejects.toThrow(
      /mode=managed/,
    );
  });

  it("calls managed utility endpoint only in managed mode", async () => {
    const fetchResponse = vi.fn(async (params) => {
      expect(params.url).toBe("https://jarvis.example/v1/managed/utilities/summarize");
      expect(JSON.parse(params.init.body)).toEqual({
        appVersion: undefined,
        deviceId: "device-1",
        input: { text: "hello" },
      });
      return await params.onResponse(
        new Response(JSON.stringify({ ok: true, result: { text: "short" } }), { status: 200 }),
      );
    });
    const client = createJarvisBackendClient(
      {
        jarvis: {
          backend: { baseUrl: "https://jarvis.example", deviceId: "device-1" },
          managedServices: { mode: "managed" },
        },
      },
      { fetchResponse },
    );

    await expect(
      client.callManagedUtility<{ text: string }>({
        utility: "summarize",
        input: { text: "hello" },
      }),
    ).resolves.toEqual({
      ok: true,
      result: { text: "short" },
      usage: undefined,
    });
  });
});
