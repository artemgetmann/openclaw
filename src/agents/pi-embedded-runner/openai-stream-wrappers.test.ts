import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenAIAttributionHeadersWrapper,
  createOpenAICodexResponsesPayloadSanitizerWrapper,
} from "./openai-stream-wrappers.js";

const nativeCodexModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model<"openai-codex-responses">;

describe("createOpenAIAttributionHeadersWrapper", () => {
  it("#75111: keeps already wrapped Codex streams while adding OpenAI attribution", () => {
    let upstreamCalls = 0;
    let capturedOptions:
      | {
          apiKey?: string;
          headers?: Record<string, string>;
        }
      | undefined;
    const upstream: StreamFn = (_model, _context, options) => {
      upstreamCalls += 1;
      capturedOptions = options;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createOpenAIAttributionHeadersWrapper(upstream);
    void wrapped(
      nativeCodexModel,
      { messages: [] },
      {
        apiKey: "oauth-bearer-token",
        headers: {
          originator: "pi",
          "User-Agent": "pi",
        },
      },
    );

    expect(upstreamCalls).toBe(1);
    expect(capturedOptions).toMatchObject({
      apiKey: "oauth-bearer-token",
      headers: {
        originator: "openclaw",
        "User-Agent": "openclaw",
      },
    });
  });
});

describe("createOpenAICodexResponsesPayloadSanitizerWrapper", () => {
  it("strips unsupported fields only for native ChatGPT Codex payloads", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const upstream: StreamFn = (_model, _context, options) => {
      const payload = {
        model: "gpt-5.4",
        input: [],
        max_output_tokens: 1024,
        metadata: { openclaw_session_id: "session-123" },
        prompt_cache_key: "session-123",
        prompt_cache_retention: "24h",
        service_tier: "auto",
        temperature: 0.2,
      };
      options?.onPayload?.(payload, nativeCodexModel);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createOpenAICodexResponsesPayloadSanitizerWrapper(upstream);
    void wrapped(nativeCodexModel, { messages: [] }, {});

    expect(capturedPayload).toEqual({
      model: "gpt-5.4",
      input: [],
      prompt_cache_key: "session-123",
    });
  });

  it("preserves custom Codex-compatible payloads", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const upstream: StreamFn = (_model, _context, options) => {
      const payload = {
        model: "gpt-5.4",
        input: [],
        max_output_tokens: 1024,
        metadata: { openclaw_session_id: "session-123" },
        prompt_cache_retention: "24h",
        service_tier: "auto",
        temperature: 0.2,
      };
      options?.onPayload?.(payload, nativeCodexModel);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createOpenAICodexResponsesPayloadSanitizerWrapper(upstream);
    void wrapped(
      {
        ...nativeCodexModel,
        baseUrl: "https://proxy.example.com/v1",
      },
      { messages: [] },
      {},
    );

    expect(capturedPayload).toEqual({
      model: "gpt-5.4",
      input: [],
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_retention: "24h",
      service_tier: "auto",
      temperature: 0.2,
    });
  });
});
