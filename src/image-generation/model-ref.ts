export function parseImageGenerationModelRef(
  raw: string | undefined,
): { provider: string; model: string } | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  return provider && model ? { provider, model } : null;
}
