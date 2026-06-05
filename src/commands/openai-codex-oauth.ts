import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./oauth-tls-preflight.js";

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const LOCAL_OAUTH_CALLBACK_WAIT_MS = 10 * 60 * 1000;

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Authentication successful</title></head>
<body><p>Authentication successful. Return to Jarvis to continue.</p></body>
</html>`;

type AuthorizationFlow = {
  verifier: string;
  state: string;
  url: string;
};

type CallbackServer = {
  close: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

type OpenAICodexOAuthDeps = {
  createAuthorizationFlow: () => Promise<AuthorizationFlow>;
  startLocalCallbackServer: (state: string, timeoutMs: number) => Promise<CallbackServer>;
  exchangeAuthorizationCode: (code: string, verifier: string) => Promise<OAuthCredentials>;
};

let activeLocalCallbackServer: Server | undefined;

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlJson(value: string): unknown {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

async function createAuthorizationFlow(): Promise<AuthorizationFlow> {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = randomBytes(16).toString("hex");
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", OPENAI_CODEX_REDIRECT_URI);
  url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return { verifier, state, url: url.toString() };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // The fallback input may be a raw code or query string rather than a full URL.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

function extractAccountId(accessToken: string): string | undefined {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) {
      return undefined;
    }
    const decoded = decodeBase64UrlJson(payload) as Record<string, unknown>;
    const auth = decoded[OPENAI_CODEX_JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeActiveLocalCallbackServer(): Promise<void> {
  const existing = activeLocalCallbackServer;
  if (!existing) {
    return;
  }
  activeLocalCallbackServer = undefined;
  await new Promise<void>((resolve) => {
    existing.close(() => resolve());
  });
}

async function startLocalCallbackServer(
  expectedState: string,
  timeoutMs: number,
): Promise<CallbackServer> {
  let lastCode: string | undefined;
  let server: Server | undefined;
  await closeActiveLocalCallbackServer();

  return new Promise((resolve) => {
    server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");
        if (url.pathname !== "/auth/callback") {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        if (url.searchParams.get("state") !== expectedState) {
          res.statusCode = 400;
          res.end("State mismatch");
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.statusCode = 400;
          res.end("Missing authorization code");
          return;
        }

        lastCode = code;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(SUCCESS_HTML);
      } catch {
        res.statusCode = 500;
        res.end("Internal error");
      }
    });

    server
      .listen(1455, "127.0.0.1", () => {
        activeLocalCallbackServer = server;
        resolve({
          close: () => {
            if (activeLocalCallbackServer === server) {
              activeLocalCallbackServer = undefined;
            }
            server?.close();
          },
          waitForCode: async () => {
            const deadline = Date.now() + timeoutMs;
            while (!lastCode && Date.now() < deadline) {
              await wait(100);
            }
            return lastCode ? { code: lastCode } : null;
          },
        });
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        console.error(
          `[openai-codex] Failed to bind http://127.0.0.1:1455 (${err.code ?? "unknown"}). Falling back to manual paste.`,
        );
        resolve({
          close: () => {
            if (activeLocalCallbackServer === server) {
              activeLocalCallbackServer = undefined;
            }
            server?.close();
          },
          waitForCode: async () => null,
        });
      });
  });
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<OAuthCredentials> {
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token exchange failed: response missing OAuth fields.");
  }

  const accountId = extractAccountId(json.access_token);
  if (!accountId) {
    throw new Error("Token exchange failed: missing ChatGPT account id.");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

async function runOpenAICodexOAuth(params: {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  localBrowserMessage: string;
  deps?: Partial<OpenAICodexOAuthDeps>;
}): Promise<OAuthCredentials> {
  const deps: OpenAICodexOAuthDeps = {
    createAuthorizationFlow,
    startLocalCallbackServer: startLocalCallbackServer,
    exchangeAuthorizationCode,
    ...params.deps,
  };
  const { verifier, state, url } = await deps.createAuthorizationFlow();
  const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
    isRemote: params.isRemote,
    prompter: params.prompter,
    runtime: params.runtime,
    spin: params.spin,
    openUrl: params.openUrl,
    localBrowserMessage: params.localBrowserMessage,
    manualPromptMessage: "Paste the authorization code (or full redirect URL):",
  });

  let server: CallbackServer | undefined;
  try {
    if (!params.isRemote) {
      // Consumer browser sign-in routinely takes more than the upstream 60s helper.
      server = await deps.startLocalCallbackServer(state, LOCAL_OAUTH_CALLBACK_WAIT_MS);
    }

    await onAuth({ url });

    let code: string | undefined;
    if (server) {
      params.spin.update("Waiting for ChatGPT sign-in to finish…");
      code = (await server.waitForCode())?.code;
    }

    if (!code) {
      const input = await onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("OAuth state mismatch.");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("Missing authorization code.");
    }

    params.spin.update("Exchanging ChatGPT authorization code…");
    return await deps.exchangeAuthorizationCode(code, verifier);
  } finally {
    server?.close();
  }
}

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
  deps?: Partial<OpenAICodexOAuthDeps>;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    runtime.error(hint);
    await prompter.note(hint, "OAuth prerequisites");
    throw new Error(preflight.message);
  }

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
  try {
    const creds = await runOpenAICodexOAuth({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
      deps: params.deps,
    });
    spin.stop("OpenAI OAuth complete");
    return creds;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
