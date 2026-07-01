import { describe, expect, it, vi } from "vitest";
import { prepareSecretsRuntimeSnapshot } from "../secrets/runtime.js";
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
      deviceId: undefined,
      trialStartedAt: undefined,
      trialEndsAt: "2026-05-15T00:00:00.000Z",
      licenseEndsAt: undefined,
      offlineGraceEndsAt: undefined,
      accountId: undefined,
      managedServicesEnabled: undefined,
    });
  });

  it("activates an account trial and returns the issued account token", async () => {
    const fetchResponse = vi.fn(async (params) => {
      expect(params.url).toBe("https://jarvis.example/v1/account/login");
      expect(params.init.headers.Authorization).toBe("Bearer backend-token");
      expect(JSON.parse(params.init.body)).toEqual({
        email: "founder@example.com",
        appVersion: "1.2.3",
        deviceId: "device-1",
      });
      return await params.onResponse(
        new Response(
          JSON.stringify({
            accountId: "acct_123",
            email: "founder@example.com",
            accountAccessToken: "jat_account_token",
            license: {
              state: "trial_active",
              deviceId: "device-1",
              accountId: "acct_123",
              trialStartedAt: "2026-05-01T00:00:00.000Z",
              trialEndsAt: "2026-05-15T00:00:00.000Z",
              offlineGraceEndsAt: "2026-05-18T00:00:00.000Z",
              managedServicesEnabled: true,
            },
          }),
          { status: 200 },
        ),
      );
    });
    const client = createJarvisBackendClient(
      {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accessToken: "backend-token",
            deviceId: "device-1",
          },
          managedServices: { mode: "license-only" },
        },
      },
      { fetchResponse },
    );

    await expect(
      client.activateTrial({ email: " founder@example.com ", appVersion: "1.2.3" }),
    ).resolves.toEqual({
      accountId: "acct_123",
      email: "founder@example.com",
      accountAccessToken: "jat_account_token",
      license: {
        state: "trial_active",
        managedServicesMode: "license-only",
        deviceId: "device-1",
        trialStartedAt: "2026-05-01T00:00:00.000Z",
        trialEndsAt: "2026-05-15T00:00:00.000Z",
        licenseEndsAt: undefined,
        offlineGraceEndsAt: "2026-05-18T00:00:00.000Z",
        accountId: "acct_123",
        managedServicesEnabled: true,
      },
    });
  });

  it("sends the stored account token with license checks", async () => {
    const fetchResponse = vi.fn(async (params) => {
      expect(JSON.parse(params.init.body)).toEqual({
        accountAccessToken: "jat_account_token",
        appVersion: undefined,
        deviceId: "device-1",
      });
      return await params.onResponse(
        new Response(JSON.stringify({ state: "trial_active", accountId: "acct_123" }), {
          status: 200,
        }),
      );
    });
    const client = createJarvisBackendClient(
      {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            deviceId: "device-1",
            accountAccessToken: "jat_account_token",
          },
          managedServices: { mode: "license-only" },
        },
      },
      { fetchResponse },
    );

    await expect(client.getLicenseStatus()).resolves.toMatchObject({
      state: "trial_active",
      accountId: "acct_123",
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

  it("preserves sanitized managed utility backend details on HTTP failures", async () => {
    const fetchResponse = vi.fn(async (params) => {
      return await params.onResponse(
        new Response(
          JSON.stringify({
            detail: {
              provider: "google_places",
              status: 403,
              payload: {
                error: {
                  code: 403,
                  message: "The caller does not have permission",
                  status: "PERMISSION_DENIED",
                },
              },
            },
          }),
          { status: 502 },
        ),
      );
    });
    const client = createJarvisBackendClient(
      {
        jarvis: {
          backend: { baseUrl: "https://jarvis.example", accessToken: "backend-token" },
          managedServices: { mode: "managed" },
        },
      },
      { fetchResponse },
    );

    // Provider failures are already sanitized by the backend. Keeping that JSON
    // in the local error tells operators which upstream config is broken.
    await expect(client.callManagedUtility({ utility: "google_places.search" })).rejects.toThrow(
      /Jarvis managed utility failed with HTTP 502: .*google_places.*PERMISSION_DENIED/,
    );
  });

  it("adds an actionable hint for suspended managed utility backends", async () => {
    const fetchResponse = vi.fn(async (params) => {
      return await params.onResponse(new Response("Service Suspended", { status: 503 }));
    });
    const client = createJarvisBackendClient(
      {
        jarvis: {
          backend: { baseUrl: "https://jarvis.example", accessToken: "backend-token" },
          managedServices: { mode: "managed" },
        },
      },
      { fetchResponse },
    );

    await expect(client.callManagedUtility({ utility: "firecrawl.search" })).rejects.toThrow(
      /HTTP 503: Service Suspended.*backend\/provider account.*direct provider API key/,
    );
  });

  it("uses resolved runtime SecretInput refs for managed utility auth", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accountAccessToken: {
              source: "env",
              provider: "default",
              id: "JARVIS_ACCOUNT_TOKEN_REF",
            },
          },
          managedServices: { mode: "managed" },
        },
      },
      env: {
        JARVIS_ACCOUNT_TOKEN_REF: "resolved-account-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    const fetchResponse = vi.fn(async (params) => {
      expect(params.url).toBe("https://jarvis.example/v1/managed/utilities/firecrawl.scrape");
      expect(params.init.headers.Authorization).toBe("Bearer resolved-account-token");
      return await params.onResponse(
        new Response(JSON.stringify({ ok: true, result: { text: "managed" } }), {
          status: 200,
        }),
      );
    });

    const client = createJarvisBackendClient(snapshot.config, { fetchResponse });

    expect(client.enabled).toBe(true);
    expect(client.baseUrl).toBe("https://jarvis.example");
    expect(client.managedServicesMode).toBe("managed");
    await expect(client.callManagedUtility({ utility: "firecrawl.scrape" })).resolves.toEqual({
      ok: true,
      result: { text: "managed" },
      usage: undefined,
    });
  });
});
