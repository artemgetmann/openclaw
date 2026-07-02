import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runManagedWebSmoke } from "../../scripts/smoke-jarvis-managed-web.mjs";

const tempRoots: string[] = [];
const repoRoot = process.cwd();

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-managed-web-smoke-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/smoke-jarvis-managed-web.mjs", () => {
  it("calls managed Brave and Firecrawl endpoints and prints redacted proof", async () => {
    const root = makeTempRoot();
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example/",
            accessToken: "backend-token",
            deviceId: "device-1",
          },
          managedServices: { mode: "managed" },
        },
      }),
    );
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const body = rawBody ? JSON.parse(rawBody) : null;
      requests.push({
        url: requestUrl,
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (requestUrl.endsWith("/brave.search")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              provider: "brave",
              payload: { web: { results: [{ url: "https://openai.com/index.html" }] } },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            provider: "firecrawl",
            payload: { data: { markdown: "hello world", metadata: { title: "OpenAI" } } },
          },
        }),
        { status: 200 },
      );
    };

    const result = await runManagedWebSmoke({ configPath, fetchImpl });

    expect(result).toMatchObject({
      ok: true,
      backend: {
        baseUrlOrigin: "https://jarvis.example",
        mode: "managed",
        tokenConfigured: true,
        tokenSource: "accessToken",
        deviceIdConfigured: true,
      },
      calls: [
        {
          tool: "web_search",
          utility: "brave.search",
          provider: "brave",
          resultCount: 1,
          firstHost: "openai.com",
        },
        {
          tool: "web_fetch",
          utility: "firecrawl.scrape",
          provider: "firecrawl",
          markdownLength: 11,
          titlePresent: true,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("backend-token");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      url: "https://jarvis.example/v1/managed/utilities/brave.search",
      authorization: "Bearer backend-token",
      body: { deviceId: "device-1", input: { query: "OpenAI", count: 1 } },
    });
    expect(requests[1]?.url).toBe("https://jarvis.example/v1/managed/utilities/firecrawl.scrape");
  });

  it("resolves env-backed backend token without exposing it in the summary", async () => {
    const result = await runManagedWebSmoke({
      configPath: "/tmp/test-openclaw.json",
      env: { JARVIS_BACKEND_ACCESS_TOKEN: "env-token" },
      config: {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accessToken: "${JARVIS_BACKEND_ACCESS_TOKEN}",
          },
          managedServices: { mode: "managed" },
        },
      },
      skipScrape: true,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              provider: "brave",
              payload: { web: { results: [] } },
            },
          }),
          { status: 200 },
        ),
    });

    expect(result.backend.tokenConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("env-token");
  });

  it("scrubs local provider env vars and reports only redacted presence proof", async () => {
    const result = await runManagedWebSmoke({
      configPath: "/tmp/test-openclaw.json",
      env: {
        JARVIS_BACKEND_ACCESS_TOKEN: "backend-token",
        BRAVE_API_KEY: "local-brave-key",
        FIRECRAWL_API_KEY: "local-firecrawl-key",
        FIRECRAWL_BASE_URL: "https://local-firecrawl.example",
      },
      config: {
        jarvis: {
          backend: {
            baseUrl: "https://jarvis.example",
            accessToken: "${JARVIS_BACKEND_ACCESS_TOKEN}",
          },
          managedServices: { mode: "managed" },
        },
      },
      skipScrape: true,
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer backend-token");
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              provider: "brave",
              payload: { web: { results: [] } },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(result.localProviderEnv).toEqual({
      BRAVE_API_KEY: { wasConfigured: true, scrubbed: true },
      FIRECRAWL_API_KEY: { wasConfigured: true, scrubbed: true },
      FIRECRAWL_BASE_URL: { wasConfigured: true, scrubbed: true },
    });
    expect(JSON.stringify(result)).not.toContain("local-brave-key");
    expect(JSON.stringify(result)).not.toContain("local-firecrawl-key");
    expect(JSON.stringify(result)).not.toContain("local-firecrawl.example");
  });

  it("rejects non-managed config before making backend calls", async () => {
    await expect(
      runManagedWebSmoke({
        configPath: "/tmp/test-openclaw.json",
        config: {
          jarvis: {
            backend: { baseUrl: "https://jarvis.example", accessToken: "token" },
            managedServices: { mode: "license-only" },
          },
        },
        fetchImpl: async () => {
          throw new Error("must not call backend");
        },
      }),
    ).rejects.toThrow(/mode must be managed/);
  });

  it("fails when a managed utility returns the wrong provider", async () => {
    await expect(
      runManagedWebSmoke({
        configPath: "/tmp/test-openclaw.json",
        config: {
          jarvis: {
            backend: { baseUrl: "https://jarvis.example", accessToken: "token" },
            managedServices: { mode: "managed" },
          },
        },
        skipScrape: true,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                provider: "placeholder",
                payload: { web: { results: [] } },
              },
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow(/brave\.search returned unexpected provider: placeholder/);
  });
});

describe("docs/agent-guides/managed-web.md", () => {
  it("keeps the operator proof tied to managed backend smoke and Jarvis runtime truth", () => {
    const runbook = fs.readFileSync(
      path.join(repoRoot, "docs", "agent-guides", "managed-web.md"),
      "utf8",
    );

    expect(runbook).toContain("node scripts/smoke-jarvis-managed-web.mjs");
    expect(runbook).toContain("BRAVE_API_KEY=local-brave-should-not-matter");
    expect(runbook).toContain("FIRECRAWL_API_KEY=local-firecrawl-should-not-matter");
    expect(runbook).toContain("FIRECRAWL_BASE_URL=https://local-firecrawl.invalid");
    expect(runbook).toContain("localProviderEnv.BRAVE_API_KEY.scrubbed=true");
    expect(runbook).toContain("localProviderEnv.FIRECRAWL_API_KEY.scrubbed=true");
    expect(runbook).toContain("localProviderEnv.FIRECRAWL_BASE_URL.scrubbed=true");
    expect(runbook).toContain("web_search");
    expect(runbook).toContain("brave.search");
    expect(runbook).toContain("web_fetch");
    expect(runbook).toContain("firecrawl.scrape");
    expect(runbook).toContain(
      "bash scripts/prove-jarvis-runtime.sh --expected-commit <expected-runtime-commit>",
    );
    expect(runbook).toContain("runtime_source=jarvis-managed-bundle");
    expect(runbook).toContain("runtime_mutation=none");
    expect(runbook).toContain("applications_jarvis_app=untouched");
    expect(runbook).toContain("Do not use local `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, or");
    expect(runbook).toContain("`/Applications/Jarvis.app` without explicit approval");
  });
});
