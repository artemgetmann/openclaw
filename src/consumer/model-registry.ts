export type ConsumerChatGptProvider = "openai-codex" | "openai";

export type ConsumerChatGptModelRef = {
  provider: ConsumerChatGptProvider;
  model: string;
  detail: string;
};

export type ConsumerChatGptModelChoice = {
  label: string;
  refs: readonly ConsumerChatGptModelRef[];
};

// This is the sole owner of normal Jarvis ChatGPT picker choices. Core setup
// and channel UIs must consume this registry so a model cannot ship on one
// consumer surface while remaining stale on another.
export const CONSUMER_CHATGPT_MODEL_REGISTRY: readonly ConsumerChatGptModelChoice[] = [
  {
    label: "GPT-5.6 Sol",
    refs: [
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        detail: "Primary ChatGPT / Codex path for consumer managed AI.",
      },
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        detail: "Direct OpenAI API path when you are using an API key.",
      },
    ],
  },
  {
    label: "GPT-5.5",
    refs: [
      {
        provider: "openai-codex",
        model: "gpt-5.5",
        detail: "Reliable ChatGPT / Codex alternative when Sol is temporarily unavailable.",
      },
      {
        provider: "openai",
        model: "gpt-5.5",
        detail: "Direct OpenAI API alternative when Sol is temporarily unavailable.",
      },
    ],
  },
] as const;

export function formatConsumerChatGptModelId(
  ref: Pick<ConsumerChatGptModelRef, "provider" | "model">,
): `${ConsumerChatGptProvider}/${string}` {
  return `${ref.provider}/${ref.model}`;
}
