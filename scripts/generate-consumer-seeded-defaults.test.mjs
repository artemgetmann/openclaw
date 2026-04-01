import assert from "node:assert/strict";
import test from "node:test";
import { buildConsumerSeededDefaults } from "./generate-consumer-seeded-defaults.mjs";

void test("returns an empty object when no consumer keys are available", () => {
  assert.deepEqual(buildConsumerSeededDefaults({ env: {} }), {});
});

void test("seeds only the supported consumer defaults from env", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      OPENAI_API_KEY: " openai-key ",
      GOOGLE_PLACES_API_KEY: " places-key ",
      FIRECRAWL_API_KEY: " firecrawl-key ",
      BRAVE_API_KEY: " brave-key ",
      UNUSED_KEY: "ignored",
    },
  });

  assert.deepEqual(seeded, {
    env: {
      vars: {
        OPENAI_API_KEY: "openai-key",
        GOOGLE_PLACES_API_KEY: "places-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
        BRAVE_API_KEY: "brave-key",
      },
    },
    plugins: {
      slots: {
        memory: "memory-lancedb",
      },
      entries: {
        "memory-lancedb": {
          enabled: true,
          config: {
            embedding: {
              apiKey: "${OPENAI_API_KEY}",
              model: "text-embedding-3-small",
            },
          },
        },
        "memory-core": {
          enabled: false,
        },
      },
    },
    skills: {
      entries: {
        goplaces: {
          apiKey: "places-key",
        },
      },
    },
    tools: {
      web: {
        fetch: {
          enabled: true,
          firecrawl: {
            enabled: true,
          },
        },
        search: {
          enabled: true,
          provider: "firecrawl",
          firecrawl: {
            apiKey: "firecrawl-key",
          },
          brave: {
            apiKey: "brave-key",
          },
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
          OPENAI_API_KEY: "founder-openai",
          BRAVE_API_KEY: "founder-brave",
        },
        FIRECRAWL_API_KEY: "founder-firecrawl",
      },
      skills: {
        entries: {
          goplaces: {
            apiKey: "founder-places",
          },
        },
      },
    },
  });

  assert.deepEqual(seeded, {
    env: {
      vars: {
        OPENAI_API_KEY: "founder-openai",
        GOOGLE_PLACES_API_KEY: "founder-places",
        FIRECRAWL_API_KEY: "founder-firecrawl",
        BRAVE_API_KEY: "founder-brave",
      },
    },
    plugins: {
      slots: {
        memory: "memory-lancedb",
      },
      entries: {
        "memory-lancedb": {
          enabled: true,
          config: {
            embedding: {
              apiKey: "${OPENAI_API_KEY}",
              model: "text-embedding-3-small",
            },
          },
        },
        "memory-core": {
          enabled: false,
        },
      },
    },
    skills: {
      entries: {
        goplaces: {
          apiKey: "founder-places",
        },
      },
    },
    tools: {
      web: {
        fetch: {
          enabled: true,
          firecrawl: {
            enabled: true,
          },
        },
        search: {
          enabled: true,
          provider: "firecrawl",
          firecrawl: {
            apiKey: "founder-firecrawl",
          },
          brave: {
            apiKey: "founder-brave",
          },
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
          brave: {
            apiKey: "brave-key",
          },
        },
      },
    },
  });
});

void test("enables memory-lancedb by default only when OpenAI is seeded", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      OPENAI_API_KEY: " openai-key ",
    },
  });

  assert.deepEqual(seeded, {
    env: {
      vars: {
        OPENAI_API_KEY: "openai-key",
      },
    },
    plugins: {
      slots: {
        memory: "memory-lancedb",
      },
      entries: {
        "memory-lancedb": {
          enabled: true,
          config: {
            embedding: {
              apiKey: "${OPENAI_API_KEY}",
              model: "text-embedding-3-small",
            },
          },
        },
        "memory-core": {
          enabled: false,
        },
      },
    },
  });
});
