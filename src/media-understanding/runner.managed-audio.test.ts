import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { withRemoteHttpResponse } from "../memory/remote-http.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import {
  createSafeAudioFixtureBuffer,
  withAudioFixture,
  withMediaFixture,
} from "./runner.test-utils.js";

const fetchResponse = vi.hoisted(() => vi.fn<typeof withRemoteHttpResponse>());

vi.mock("../memory/remote-http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/remote-http.js")>();
  return {
    ...actual,
    withRemoteHttpResponse: fetchResponse,
  };
});

describe("runCapability managed audio", () => {
  it("sniffs generically labeled audio before enforcing the managed MIME boundary", async () => {
    fetchResponse.mockImplementationOnce(
      async (params) =>
        await params.onResponse(
          new Response(
            JSON.stringify({
              ok: true,
              result: { provider: "openai", payload: { text: "generic audio", model: "test" } },
            }),
            { status: 200 },
          ),
        ),
    );
    await withMediaFixture(
      {
        filePrefix: "openclaw-generic-managed-audio",
        extension: "wav",
        mediaType: "application/octet-stream",
        fileContents: createSafeAudioFixtureBuffer(2048, 0x52),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          jarvis: {
            backend: { baseUrl: "https://jarvis.example", accountAccessToken: "token" },
            managedServices: { mode: "managed" },
          },
          tools: {
            media: {
              audio: {
                models: [{ type: "provider", provider: "jarvis-managed-openai" }],
              },
            },
          },
        } as unknown as OpenClawConfig;
        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry: buildProviderRegistry(),
        });
        expect(result.outputs[0]).toMatchObject({ text: "generic audio" });
      },
    );
  });

  it.each([
    {
      name: "routes a non-empty transcript through the backend",
      payload: { text: "wake up my friend", model: "gpt-4o-mini-transcribe" },
      expectedOutcome: "success",
      expectedText: "wake up my friend",
    },
    {
      name: "preserves an explicit empty transcript as successful silence",
      payload: { text: "", model: "gpt-4o-mini-transcribe" },
      expectedOutcome: "success",
      expectedText: "",
    },
    {
      name: "fails when the backend omits the transcript field",
      payload: { model: "gpt-4o-mini-transcribe" },
      expectedOutcome: "skipped",
      expectedText: undefined,
    },
  ] as const)("$name", async ({ payload, expectedOutcome, expectedText }) => {
    const priorOpenAi = process.env.OPENAI_API_KEY;
    const priorNonModel = process.env.OPENAI_NON_MODEL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_NON_MODEL_API_KEY;
    fetchResponse.mockImplementationOnce(async (params) => {
      expect(params.url).toBe(
        "https://jarvis.example/v1/managed/utilities/openai.audio.transcribe",
      );
      expect(params.init?.headers).toMatchObject({
        Authorization: "Bearer jat_account_token",
      });
      expect(typeof params.init?.body).toBe("string");
      const body = JSON.parse(params.init?.body as string);
      expect(body.input.fileBase64).toEqual(expect.any(String));
      expect(body.input.model).toBe("gpt-4o-mini-transcribe");
      expect(body.input.mimeType).toBe("audio/wav");
      return await params.onResponse(
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              provider: "openai",
              payload,
            },
          }),
          { status: 200 },
        ),
      );
    });

    try {
      await withAudioFixture("openclaw-managed-audio", async ({ ctx, media, cache }) => {
        const cfg = {
          jarvis: {
            backend: {
              baseUrl: "https://jarvis.example",
              accountAccessToken: "jat_account_token",
            },
            managedServices: { mode: "managed" },
          },
          tools: {
            media: {
              audio: {
                enabled: true,
                models: [
                  {
                    type: "provider",
                    provider: "jarvis-managed-openai",
                    model: "gpt-4o-mini-transcribe",
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "audio",
          cfg,
          ctx,
          attachments: cache,
          media,
          providerRegistry: buildProviderRegistry(),
        });

        expect(result.decision.outcome).toBe(expectedOutcome);
        if (expectedOutcome === "success") {
          expect(result.outputs[0]).toMatchObject({
            kind: "audio.transcription",
            provider: "openai",
            model: "gpt-4o-mini-transcribe",
            text: expectedText,
          });
          return;
        }
        expect(result.outputs).toEqual([]);
        expect(result.decision.attachments[0]?.attempts[0]?.reason).toContain("returned no text");
      });
    } finally {
      fetchResponse.mockReset();
      if (priorOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenAi;
      }
      if (priorNonModel === undefined) {
        delete process.env.OPENAI_NON_MODEL_API_KEY;
      } else {
        process.env.OPENAI_NON_MODEL_API_KEY = priorNonModel;
      }
    }
  });
});
