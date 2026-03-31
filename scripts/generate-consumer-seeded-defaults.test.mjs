import assert from "node:assert/strict";
import test from "node:test";
import { buildConsumerSeededDefaults } from "./generate-consumer-seeded-defaults.mjs";

void test("returns an empty object when no consumer keys are available", () => {
  assert.deepEqual(buildConsumerSeededDefaults({ env: {} }), {});
});

void test("seeds only the supported consumer defaults from env", () => {
  const seeded = buildConsumerSeededDefaults({
    env: {
      GOOGLE_PLACES_API_KEY: " places-key ",
      FIRECRAWL_API_KEY: " firecrawl-key ",
      BRAVE_API_KEY: " brave-key ",
      UNUSED_KEY: "ignored",
    },
  });

  assert.deepEqual(seeded, {
    env: {
      vars: {
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
          provider: "brave",
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
          provider: "brave",
          apiKey: "founder-brave",
        },
      },
    },
  });
});
