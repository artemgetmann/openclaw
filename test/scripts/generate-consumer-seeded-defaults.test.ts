import { describe, expect, it } from "vitest";
import { buildConsumerSeededDefaults } from "../../scripts/generate-consumer-seeded-defaults.mjs";

describe("scripts/generate-consumer-seeded-defaults.mjs", () => {
  it("keeps public seeded defaults free of provider keys by default", () => {
    const seeded = buildConsumerSeededDefaults({
      env: {
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "plain-openai-value",
        OPENCLAW_CONSUMER_GEMINI_API_KEY: "plain-gemini-value",
        BRAVE_API_KEY: "plain-brave-value",
      },
      founderConfig: {
        env: {
          vars: {
            FIRECRAWL_API_KEY: "plain-firecrawl-value",
          },
        },
      },
    });

    expect(seeded).toEqual({});
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
