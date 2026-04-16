export const OPENAI_MODEL_ENV_VAR_CANDIDATES = ["OPENAI_MODEL_API_KEY", "OPENAI_API_KEY"] as const;

export const OPENAI_NON_MODEL_ENV_VAR_CANDIDATES = [
  "OPENAI_NON_MODEL_API_KEY",
  "OPENAI_API_KEY",
] as const;

function readFirstNonEmptyEnv(candidates: readonly string[]): {
  apiKey: string | undefined;
  envVar: string | undefined;
} {
  for (const envVar of candidates) {
    const value = process.env[envVar]?.trim();
    if (value) {
      return { apiKey: value, envVar };
    }
  }
  return { apiKey: undefined, envVar: undefined };
}

export function resolveOpenAiModelEnvApiKey(): {
  apiKey: string | undefined;
  envVar: string | undefined;
} {
  return readFirstNonEmptyEnv(OPENAI_MODEL_ENV_VAR_CANDIDATES);
}

export function resolveOpenAiNonModelEnvApiKey(): {
  apiKey: string | undefined;
  envVar: string | undefined;
} {
  return readFirstNonEmptyEnv(OPENAI_NON_MODEL_ENV_VAR_CANDIDATES);
}
