import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  createVpsAwareOAuthHandlers: vi.fn(),
  runOpenAIOAuthTlsPreflight: vi.fn(),
  formatOpenAIOAuthTlsPreflightFix: vi.fn(),
}));

vi.mock("./oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers: mocks.createVpsAwareOAuthHandlers,
}));

vi.mock("./oauth-tls-preflight.js", () => ({
  runOpenAIOAuthTlsPreflight: mocks.runOpenAIOAuthTlsPreflight,
  formatOpenAIOAuthTlsPreflightFix: mocks.formatOpenAIOAuthTlsPreflightFix,
}));

import { loginOpenAICodexOAuth } from "./openai-codex-oauth.js";

function createPrompter() {
  const spin = { update: vi.fn(), stop: vi.fn() };
  const prompter: Pick<WizardPrompter, "note" | "progress" | "text"> = {
    note: vi.fn(async () => {}),
    progress: vi.fn(() => spin),
    text: vi.fn(async () => "manual-code"),
  };
  return { prompter: prompter as unknown as WizardPrompter, spin };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

const authorizationFlow = {
  verifier: "verifier",
  state: "state",
  url: "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=state",
};

const successfulCreds = {
  provider: "openai-codex" as const,
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  email: "user@example.com",
};

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    createAuthorizationFlow: vi.fn(async () => authorizationFlow),
    startLocalCallbackServer: vi.fn(async () => ({
      close: vi.fn(),
      waitForCode: vi.fn(async () => ({ code: "browser-code" })),
    })),
    exchangeAuthorizationCode: vi.fn(async () => successfulCreds),
    ...overrides,
  };
}

async function runCodexOAuth(params: { isRemote: boolean; deps?: ReturnType<typeof createDeps> }) {
  const { prompter, spin } = createPrompter();
  const runtime = createRuntime();
  const result = await loginOpenAICodexOAuth({
    prompter,
    runtime,
    isRemote: params.isRemote,
    openUrl: async () => {},
    deps: params.deps,
  });
  return { result, prompter, spin, runtime };
}

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("tls fix");
  });

  it("returns credentials on successful oauth login", async () => {
    const deps = createDeps();
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });

    const { result, spin, runtime } = await runCodexOAuth({ isRemote: false, deps });

    expect(result).toEqual(successfulCreds);
    expect(deps.exchangeAuthorizationCode).toHaveBeenCalledWith("browser-code", "verifier");
    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth complete");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("passes through Pi-provided OAuth authorize URL without mutation", async () => {
    const deps = createDeps();
    const onAuthSpy = vi.fn();
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: onAuthSpy,
      onPrompt: vi.fn(),
    });

    await runCodexOAuth({ isRemote: false, deps });

    expect(onAuthSpy).toHaveBeenCalledTimes(1);
    const event = onAuthSpy.mock.calls[0]?.[0] as { url: string };
    expect(event.url).toBe(authorizationFlow.url);
  });

  it("keeps the local consumer callback server open for a human-length OAuth flow", async () => {
    const deps = createDeps();
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });

    await runCodexOAuth({ isRemote: false, deps });

    expect(deps.startLocalCallbackServer).toHaveBeenCalledWith("state", 600_000);
  });

  it("reports oauth errors and rethrows", async () => {
    const deps = createDeps({
      exchangeAuthorizationCode: vi.fn(async () => {
        throw new Error("oauth failed");
      }),
    });
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(async () => "manual-code"),
    });

    const { prompter, spin } = createPrompter();
    const runtime = createRuntime();
    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: true,
        openUrl: async () => {},
        deps,
      }),
    ).rejects.toThrow("oauth failed");

    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth failed");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("oauth failed"));
    expect(prompter.note).toHaveBeenCalledWith(
      "Trouble with OAuth? See https://docs.openclaw.ai/start/faq",
      "OAuth help",
    );
  });

  it("continues OAuth flow on non-certificate preflight failures", async () => {
    const deps = createDeps();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "network",
      message: "Client network socket disconnected before secure TLS connection was established",
    });
    mocks.createVpsAwareOAuthHandlers.mockReturnValue({
      onAuth: vi.fn(),
      onPrompt: vi.fn(),
    });

    const { result, prompter, runtime } = await runCodexOAuth({ isRemote: false, deps });

    expect(result).toEqual(successfulCreds);
    expect(deps.exchangeAuthorizationCode).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalledWith("tls fix");
    expect(prompter.note).not.toHaveBeenCalledWith("tls fix", "OAuth prerequisites");
  });

  it("fails early with actionable message when TLS preflight fails", async () => {
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("Run brew postinstall openssl@3");

    const { prompter } = createPrompter();
    const runtime = createRuntime();

    await expect(
      loginOpenAICodexOAuth({
        prompter,
        runtime,
        isRemote: false,
        openUrl: async () => {},
      }),
    ).rejects.toThrow("unable to get local issuer certificate");

    expect(runtime.error).toHaveBeenCalledWith("Run brew postinstall openssl@3");
    expect(prompter.note).toHaveBeenCalledWith(
      "Run brew postinstall openssl@3",
      "OAuth prerequisites",
    );
  });
});
