import assert from "node:assert/strict";
import test from "node:test";
import { buildConsumerSeededDefaults } from "./generate-consumer-seeded-defaults.mjs";

void test("returns an empty object when no consumer keys are available", () => {
  assert.deepEqual(buildConsumerSeededDefaults({ env: {} }), {});
});

void test("seeds only the supported consumer defaults from env", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      OPENCLAW_CONSUMER_OPENAI_API_KEY: " consumer-openai-key ",
      OPENCLAW_CONSUMER_GEMINI_API_KEY: " consumer-gemini-key ",
      GOOGLE_PLACES_API_KEY: " places-key ",
      FIRECRAWL_API_KEY: " firecrawl-key ",
      BRAVE_API_KEY: " brave-key ",
      UNUSED_KEY: "ignored",
    },
  });

  assert.deepEqual(seeded, {
    agents: {
      defaults: {
        imageGenerationModel: {
          primary: "openai/gpt-image-2",
        },
      },
    },
    env: {
      vars: {
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "consumer-openai-key",
        OPENCLAW_CONSUMER_GEMINI_API_KEY: "consumer-gemini-key",
        GEMINI_API_KEY: "consumer-gemini-key",
        GOOGLE_PLACES_API_KEY: "places-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
        BRAVE_API_KEY: "brave-key",
      },
    },
    skills: {
      entries: {
        goplaces: {
          apiKey: "places-key",
        },
        "nano-banana-pro": {
          apiKey: "consumer-gemini-key",
        },
      },
    },
    tools: {
      media: {
        audio: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini-transcribe",
              apiKey: "${OPENCLAW_CONSUMER_OPENAI_API_KEY}",
            },
          ],
        },
      },
      web: {
        fetch: {
          enabled: true,
          firecrawl: {
            enabled: true,
          },
        },
        search: {
          enabled: true,
          provider: "brave",
          firecrawl: {
            apiKey: "firecrawl-key",
          },
          apiKey: "brave-key",
        },
      },
    },
  });
});

void test("falls back to founder config when shell env is empty", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {},
    founderConfig: {
      env: {
        vars: {
          OPENCLAW_CONSUMER_OPENAI_API_KEY: "founder-consumer-openai",
          OPENCLAW_CONSUMER_GEMINI_API_KEY: "founder-consumer-gemini",
          BRAVE_API_KEY: "founder-brave",
        },
        FIRECRAWL_API_KEY: "founder-firecrawl",
      },
      skills: {
        entries: {
          goplaces: {
            apiKey: "founder-places",
          },
          "nano-banana-pro": {
            apiKey: "founder-consumer-gemini",
          },
        },
      },
    },
  });

  assert.deepEqual(seeded, {
    agents: {
      defaults: {
        imageGenerationModel: {
          primary: "openai/gpt-image-2",
        },
      },
    },
    env: {
      vars: {
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "founder-consumer-openai",
        OPENCLAW_CONSUMER_GEMINI_API_KEY: "founder-consumer-gemini",
        GEMINI_API_KEY: "founder-consumer-gemini",
        GOOGLE_PLACES_API_KEY: "founder-places",
        FIRECRAWL_API_KEY: "founder-firecrawl",
        BRAVE_API_KEY: "founder-brave",
      },
    },
    skills: {
      entries: {
        goplaces: {
          apiKey: "founder-places",
        },
        "nano-banana-pro": {
          apiKey: "founder-consumer-gemini",
        },
      },
    },
    tools: {
      media: {
        audio: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini-transcribe",
              apiKey: "${OPENCLAW_CONSUMER_OPENAI_API_KEY}",
            },
          ],
        },
      },
      web: {
        fetch: {
          enabled: true,
          firecrawl: {
            enabled: true,
          },
        },
        search: {
          enabled: true,
          provider: "brave",
          firecrawl: {
            apiKey: "founder-firecrawl",
          },
          apiKey: "founder-brave",
        },
      },
    },
  });
});

void test("falls back to Brave search when Firecrawl is not available", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      BRAVE_API_KEY: " brave-key ",
    },
  });

  assert.deepEqual(seeded, {
    env: {
      vars: {
        BRAVE_API_KEY: "brave-key",
      },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider: "brave",
          apiKey: "brave-key",
        },
      },
    },
  });
});

void test("seeds consumer OpenAI utility defaults for audio transcription and image generation", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      OPENCLAW_CONSUMER_OPENAI_API_KEY: " consumer-openai-key ",
    },
  });

  assert.deepEqual(seeded, {
    agents: {
      defaults: {
        imageGenerationModel: {
          primary: "openai/gpt-image-2",
        },
      },
    },
    env: {
      vars: {
        OPENCLAW_CONSUMER_OPENAI_API_KEY: "consumer-openai-key",
      },
    },
    tools: {
      media: {
        audio: {
          models: [
            {
              provider: "openai",
              model: "gpt-4o-mini-transcribe",
              apiKey: "${OPENCLAW_CONSUMER_OPENAI_API_KEY}",
            },
          ],
        },
      },
    },
  });
});

void test("does not fall back to generic founder or shell OpenAI keys for consumer speech packaging", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      OPENAI_API_KEY: "generic-openai-key",
    },
    founderConfig: {
      env: {
        vars: {
          OPENAI_API_KEY: "founder-generic-openai",
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "founder-provider-openai",
          },
        },
      },
    },
  });

  assert.deepEqual(seeded, {});
});

void test("reads legacy founder Brave keys from the nested provider path but rewrites them to search.apiKey", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {},
    founderConfig: {
      tools: {
        web: {
          search: {
            brave: {
              apiKey: "legacy-brave-key",
            },
          },
        },
      },
    },
  });

  assert.deepEqual(seeded, {
    env: {
      vars: {
        BRAVE_API_KEY: "legacy-brave-key",
      },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider: "brave",
          apiKey: "legacy-brave-key",
        },
      },
    },
  });
});
