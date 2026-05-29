import { describe, expect, it } from "vitest";
import { buildConsumerSeededDefaults } from "../../scripts/generate-consumer-seeded-defaults.mjs";

describe("scripts/generate-consumer-seeded-defaults.mjs", () => {
  it("keeps public seeded defaults free of provider keys by default while seeding backend activation", () => {
    const seeded = buildConsumerSeededDefaults({
      env: {
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "plain-openai-value",
        OPENCLAW_CONSUMER_GEMINI_API_KEY: "plain-gemini-value",
        BRAVE_API_KEY: "plain-brave-value",
        JARVIS_BACKEND_API_TOKEN: "backend-bearer-value",
      },
      founderConfig: {
        env: {
          vars: {
            FIRECRAWL_API_KEY: "plain-firecrawl-value",
          },
        },
      },
    });

    expect(seeded).toEqual({
      jarvis: {
        backend: {
          baseUrl: "https://jarvis-backend-klvq.onrender.com",
          accessToken: "backend-bearer-value",
        },
        managedServices: {
          mode: "managed",
        },
      },
    });
  });

  it("prefers the explicit backend access token alias over the api token alias", () => {
    const seeded = buildConsumerSeededDefaults({
      env: {
        JARVIS_BACKEND_ACCESS_TOKEN: "preferred-backend-bearer",
        JARVIS_BACKEND_API_TOKEN: "legacy-backend-bearer",
        JARVIS_BACKEND_BASE_URL: "https://jarvis.example.test",
      },
    });

    expect(seeded).toMatchObject({
      jarvis: {
        backend: {
          baseUrl: "https://jarvis.example.test",
          accessToken: "preferred-backend-bearer",
        },
      },
    });
  });

  it("requires an explicit internal override before bundling provider keys", () => {
    const seeded = buildConsumerSeededDefaults({
      env: {
        OPENCLAW_CONSUMER_ALLOW_BUNDLED_PROVIDER_KEYS: "1",
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "plain-openai-value",
        OPENCLAW_CONSUMER_GEMINI_API_KEY: "plain-gemini-value",
      },
    });

    expect(seeded).toMatchObject({
      env: {
        vars: {
          OPENCLAW_CONSUMER_OPENAI_API_KEY: "plain-openai-value",
          OPENCLAW_CONSUMER_GEMINI_API_KEY: "plain-gemini-value",
          GEMINI_API_KEY: "plain-gemini-value",
        },
      },
      tools: {
        media: {
          audio: {
            models: [
              {
                provider: "openai",
                apiKey: "${OPENCLAW_CONSUMER_OPENAI_API_KEY}",
              },
            ],
          },
        },
      },
    });
  });
});
