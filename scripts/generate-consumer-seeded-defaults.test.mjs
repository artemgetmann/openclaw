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
      entries: {
        "memory-lancedb": {
          config: {
            embedding: {
              apiKey: "${OPENAI_API_KEY}",
              model: "text-embedding-3-small",
            },
          },
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
          BRAVE_API_KEY: "founder-brave",
        },
        FIRECRAWL_API_KEY: "founder-firecrawl",
      },
      models: {
        providers: {
          openai: {
            apiKey: "founder-openai",
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
      entries: {
        "memory-lancedb": {
          config: {
            embedding: {
              apiKey: "${OPENAI_API_KEY}",
              model: "text-embedding-3-small",
            },
          },
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

void test("seeds OpenAI provider defaults without forcing memory-lancedb on", () => {
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
      entries: {
        "memory-lancedb": {
          config: {
            embedding: {
              apiKey: "${OPENAI_API_KEY}",
              model: "text-embedding-3-small",
            },
          },
        },
      },
    },
  });
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
