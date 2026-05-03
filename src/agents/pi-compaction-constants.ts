/**
 * Absolute prompt budget that should remain after compaction reserve is applied.
 * Larger context windows use this fixed floor.
 */
export const MIN_PROMPT_BUDGET_TOKENS = 8_000;

/**
 * Minimum share of small context windows reserved for prompt content.
 */
export const MIN_PROMPT_BUDGET_RATIO = 0.5;
