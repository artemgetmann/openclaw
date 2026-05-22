/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_home              - show consumer-friendly model families
 * - mdl_prov              - show providers list
 * - mdl_fam_{family}      - show recommended model for a family
 * - mdl_fam_{family}_more - show remaining models for a family
 * - mdl_fam_claude_ctx    - show larger-context Claude CLI models
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - select model (compact fallback when standard is >64 bytes)
 * - mdl_cfm_{provider/id} - confirmed select for models with cost/quota warnings
 * - mdl_back              - back to providers list
 */

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export type ParsedModelCallback =
  | { type: "home" }
  | { type: "providers" }
  | { type: "family"; family: ModelFamilyId; more: boolean; context?: boolean }
  | { type: "list"; provider: string; page: number }
  | { type: "select"; provider?: string; model: string }
  | { type: "confirmSelect"; provider?: string; model: string }
  | { type: "back" };

export type ProviderInfo = {
  id: string;
  count: number;
};

export type ResolveModelSelectionResult =
  | { kind: "resolved"; provider: string; model: string }
  | { kind: "ambiguous"; model: string; matchingProviders: string[] };

export type ModelsKeyboardParams = {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
};

export type ModelFamilyId = "claude" | "chatgpt";

export type ModelFamilyInfo = {
  family: ModelFamilyId;
  label: string;
  providers: readonly string[];
  recommended: readonly string[];
};

export type FamilyModelRef = {
  provider: string;
  model: string;
};

const CLAUDE_BRIDGE_DISPLAY_NAMES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
};

const MODELS_PAGE_SIZE = 8;
const MAX_CALLBACK_DATA_BYTES = 64;
const CALLBACK_PREFIX = {
  home: "mdl_home",
  providers: "mdl_prov",
  back: "mdl_back",
  family: "mdl_fam_",
  familyMoreSuffix: "_more",
  familyContextSuffix: "_ctx",
  list: "mdl_list_",
  selectStandard: "mdl_sel_",
  selectCompact: "mdl_sel/",
  confirmStandard: "mdl_cfm_",
} as const;

const CLAUDE_MODEL_FAMILY: ModelFamilyInfo = {
  family: "claude",
  label: "Claude",
  providers: ["anthropic", "claude-bridge", "claude-cli"],
  recommended: ["claude-cli/sonnet", "anthropic/claude-sonnet-4-6", "claude-bridge/sonnet"],
};

export const MODEL_FAMILIES: readonly ModelFamilyInfo[] = [
  CLAUDE_MODEL_FAMILY,
  {
    family: "chatgpt",
    label: "ChatGPT",
    providers: ["openai-codex", "openai"],
    recommended: [
      "openai-codex/gpt-5.5",
      "openai/gpt-5.5",
      "openai-codex/gpt-5.4",
      "openai/gpt-5.4",
    ],
  },
] as const;

/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
export function parseModelCallbackData(data: string): ParsedModelCallback | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith("mdl_")) {
    return null;
  }

  if (
    trimmed === CALLBACK_PREFIX.home ||
    trimmed === CALLBACK_PREFIX.providers ||
    trimmed === CALLBACK_PREFIX.back
  ) {
    if (trimmed === CALLBACK_PREFIX.home) {
      return { type: "home" };
    }
    return { type: trimmed === CALLBACK_PREFIX.providers ? "providers" : "back" };
  }

  const familyMatch = trimmed.match(/^mdl_fam_(claude|chatgpt)(_more|_ctx)?$/);
  if (familyMatch) {
    const family = familyMatch[1] as ModelFamilyId;
    return {
      type: "family",
      family,
      more: familyMatch[2] === CALLBACK_PREFIX.familyMoreSuffix,
      context: familyMatch[2] === CALLBACK_PREFIX.familyContextSuffix,
    };
  }

  // mdl_list_{provider}_{page}
  const listMatch = trimmed.match(/^mdl_list_([a-z0-9_-]+)_(\d+)$/i);
  if (listMatch) {
    const [, provider, pageStr] = listMatch;
    const page = Number.parseInt(pageStr ?? "1", 10);
    if (provider && Number.isFinite(page) && page >= 1) {
      return { type: "list", provider, page };
    }
  }

  // mdl_sel/{model} (compact fallback)
  const compactSelMatch = trimmed.match(/^mdl_sel\/(.+)$/);
  if (compactSelMatch) {
    const modelRef = compactSelMatch[1];
    if (modelRef) {
      return {
        type: "select",
        model: modelRef,
      };
    }
  }

  // mdl_sel_{provider/model}
  const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
  if (selMatch) {
    const modelRef = selMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: "select",
          provider: modelRef.slice(0, slashIndex),
          model: modelRef.slice(slashIndex + 1),
        };
      }
    }
  }

  const confirmMatch = trimmed.match(/^mdl_cfm_(.+)$/);
  if (confirmMatch) {
    const modelRef = confirmMatch[1];
    if (modelRef) {
      const slashIndex = modelRef.indexOf("/");
      if (slashIndex > 0 && slashIndex < modelRef.length - 1) {
        return {
          type: "confirmSelect",
          provider: modelRef.slice(0, slashIndex),
          model: modelRef.slice(slashIndex + 1),
        };
      }
    }
  }

  return null;
}

export function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string | null {
  const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
  if (Buffer.byteLength(fullCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES) {
    return fullCallbackData;
  }
  const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
  return Buffer.byteLength(compactCallbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES
    ? compactCallbackData
    : null;
}

export function buildConfirmedModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string | null {
  const callbackData = `${CALLBACK_PREFIX.confirmStandard}${params.provider}/${params.model}`;
  return Buffer.byteLength(callbackData, "utf8") <= MAX_CALLBACK_DATA_BYTES ? callbackData : null;
}

export function modelSelectionRequiresConfirmation(params: {
  provider: string;
  model: string;
}): boolean {
  return params.provider === "claude-cli" && params.model === "sonnet[1m]";
}

export function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, { type: "select" | "confirmSelect" }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult {
  if (params.callback.provider) {
    return {
      kind: "resolved",
      provider: params.callback.provider,
      model: params.callback.model,
    };
  }
  const matchingProviders = params.providers.filter((id) =>
    params.byProvider.get(id)?.has(params.callback.model),
  );
  if (matchingProviders.length === 1) {
    return {
      kind: "resolved",
      provider: matchingProviders[0],
      model: params.callback.model,
    };
  }
  return {
    kind: "ambiguous",
    model: params.callback.model,
    matchingProviders,
  };
}

/**
 * Build provider selection keyboard with 2 providers per row.
 */
export function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[] {
  if (providers.length === 0) {
    return [];
  }

  const rows: ButtonRow[] = [];
  let currentRow: ButtonRow = [];

  for (const provider of providers) {
    const button = {
      text: `${provider.id} (${provider.count})`,
      callback_data: `mdl_list_${provider.id}_1`,
    };

    currentRow.push(button);

    if (currentRow.length === 2) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  // Push any remaining button
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

export function buildModelHomeKeyboard(): ButtonRow[] {
  return [
    [
      { text: "Claude", callback_data: "mdl_fam_claude" },
      { text: "ChatGPT", callback_data: "mdl_fam_chatgpt" },
    ],
    [{ text: "Model Providers", callback_data: CALLBACK_PREFIX.providers }],
  ];
}

export function resolveModelFamilyInfo(family: ModelFamilyId): ModelFamilyInfo {
  return MODEL_FAMILIES.find((entry) => entry.family === family) ?? CLAUDE_MODEL_FAMILY;
}

function hasModelRef(params: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  provider: string;
  model: string;
}): boolean {
  return params.byProvider.get(params.provider)?.has(params.model) === true;
}

function parseFamilyModelRef(ref: string): FamilyModelRef | null {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slashIndex),
    model: ref.slice(slashIndex + 1),
  };
}

export function resolveRecommendedFamilyModel(params: {
  family: ModelFamilyId;
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): FamilyModelRef | null {
  const info = resolveModelFamilyInfo(params.family);
  for (const ref of info.recommended) {
    const parsed = parseFamilyModelRef(ref);
    if (!parsed) {
      continue;
    }
    if (hasModelRef({ byProvider: params.byProvider, ...parsed })) {
      return parsed;
    }
  }

  for (const provider of info.providers) {
    const models = params.byProvider.get(provider);
    if (!models) {
      continue;
    }
    const sonnet = [...models].find((model) => model.toLowerCase().includes("sonnet"));
    if (sonnet) {
      return { provider, model: sonnet };
    }
    const gpt = [...models].find(
      (model) =>
        model.toLowerCase().includes("gpt") &&
        shouldShowInModelFamily({ family: params.family, model }),
    );
    if (gpt) {
      return { provider, model: gpt };
    }
  }

  return null;
}

export function listFamilyModels(params: {
  family: ModelFamilyId;
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  exclude?: FamilyModelRef | null;
}): FamilyModelRef[] {
  const info = resolveModelFamilyInfo(params.family);
  const out: FamilyModelRef[] = [];
  const seenLabels = new Set<string>();
  const excludedLabel = params.exclude ? formatFamilyModelLabel(params.family, params.exclude) : "";
  for (const provider of info.providers) {
    const models = params.byProvider.get(provider);
    if (!models) {
      continue;
    }
    for (const model of [...models].toSorted()) {
      if (params.exclude?.provider === provider && params.exclude.model === model) {
        continue;
      }
      if (!shouldShowInModelFamily({ family: params.family, model })) {
        continue;
      }
      const label = formatFamilyModelLabel(params.family, { provider, model });
      if (label === excludedLabel || seenLabels.has(label)) {
        continue;
      }
      seenLabels.add(label);
      out.push({ provider, model });
    }
  }
  return out;
}

function shouldShowInModelFamily(params: { family: ModelFamilyId; model: string }): boolean {
  if (params.family !== "chatgpt") {
    return true;
  }
  // The ChatGPT family is for chat/coding model selection. Image models stay in
  // the raw provider browser behind top-level More.
  return !/\bimage\b/i.test(params.model);
}

function formatFamilyModelLabel(family: ModelFamilyId, ref: FamilyModelRef): string {
  if (family === "chatgpt") {
    return formatChatGptModelLabel(ref.model);
  }

  if (ref.provider === "claude-bridge") {
    return formatClaudeModelLabel(formatModelDisplayName(ref.provider, ref.model));
  }
  return formatClaudeModelLabel(ref.model);
}

function formatClaudeModelLabel(model: string): string {
  const normalized = model.toLowerCase();
  const shortMatch = normalized.match(/^claude-(sonnet|opus|haiku)-([0-9]+)-([0-9]+)$/);
  if (shortMatch) {
    return `${capitalize(shortMatch[1] ?? "")} ${shortMatch[2]}.${shortMatch[3]}`;
  }

  const versionedMatch = normalized.match(/^claude-[0-9]+-[0-9]+-(sonnet|opus|haiku)/);
  if (versionedMatch) {
    return capitalize(versionedMatch[1] ?? "");
  }

  return truncateModelId(model, 38);
}

function formatChatGptModelLabel(model: string): string {
  const normalized = model.toLowerCase();
  const gptMatch = normalized.match(/^gpt-([0-9]+(?:\.[0-9]+)?)(?:-(.+))?$/);
  if (!gptMatch) {
    return truncateModelId(model, 38);
  }

  const suffix = gptMatch[2]
    ?.split("-")
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === "gpt" ? "GPT" : capitalize(part)))
    .join(" ");
  return suffix ? `GPT ${gptMatch[1]} ${suffix}` : `GPT ${gptMatch[1]}`;
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}` : value;
}

export function buildModelFamilyKeyboard(params: {
  family: ModelFamilyId;
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  currentModel?: string;
  more?: boolean;
  context?: boolean;
}): ButtonRow[] {
  if (params.family === "claude") {
    return buildClaudeFamilyKeyboard(params);
  }
  if (params.family === "chatgpt") {
    return buildChatGptFamilyKeyboard(params);
  }

  const recommended = resolveRecommendedFamilyModel({
    family: params.family,
    byProvider: params.byProvider,
  });
  const refs = params.more
    ? listFamilyModels({
        family: params.family,
        byProvider: params.byProvider,
        exclude: recommended,
      })
    : recommended
      ? [recommended]
      : [];
  const rows: ButtonRow[] = [];
  for (const ref of refs) {
    const callbackData = buildModelSelectionCallbackData(ref);
    if (!callbackData) {
      continue;
    }
    const currentRef = `${ref.provider}/${ref.model}`;
    const label = formatFamilyModelLabel(params.family, ref);
    rows.push([
      {
        text: currentRef === params.currentModel ? `${label} ✓` : label,
        callback_data: callbackData,
      },
    ]);
  }
  if (!params.more) {
    rows.push([
      {
        text: "More",
        callback_data: `${CALLBACK_PREFIX.family}${params.family}${CALLBACK_PREFIX.familyMoreSuffix}`,
      },
    ]);
  }
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.home }]);
  return rows;
}

function buildClaudeFamilyKeyboard(params: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  currentModel?: string;
  more?: boolean;
  context?: boolean;
}): ButtonRow[] {
  const rows: ButtonRow[] = [];
  if (params.context) {
    appendStaticModelButton(rows, params, {
      label: "Opus 4.7 (1M)",
      provider: "claude-cli",
      model: "opus[1m]",
    });
    appendStaticModelButton(rows, params, {
      label: "Sonnet 4.6 (1M, Max only)",
      provider: "claude-cli",
      model: "sonnet[1m]",
    });
    rows.push([{ text: "<< Back", callback_data: "mdl_fam_claude_more" }]);
    return rows;
  }

  if (params.more) {
    appendStaticModelButton(rows, params, {
      label: "Opus 4.7",
      provider: "claude-cli",
      model: "opus",
    });
    if (hasClaudeLargerContextModels(params.byProvider)) {
      rows.push([{ text: "Larger context", callback_data: "mdl_fam_claude_ctx" }]);
    }
    rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.home }]);
    return rows;
  }

  appendStaticModelButton(rows, params, {
    label: "Sonnet 4.6",
    provider: "claude-cli",
    model: "sonnet",
  });
  rows.push([{ text: "More", callback_data: "mdl_fam_claude_more" }]);
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.home }]);
  return rows;
}

function hasClaudeLargerContextModels(
  byProvider: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const models = byProvider.get("claude-cli");
  return models?.has("opus[1m]") === true || models?.has("sonnet[1m]") === true;
}

function buildChatGptFamilyKeyboard(params: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  currentModel?: string;
  more?: boolean;
}): ButtonRow[] {
  const rows: ButtonRow[] = [];
  if (params.more) {
    appendFirstAvailableStaticModelButton(rows, params, {
      label: "GPT-5.4",
      refs: [
        { provider: "openai-codex", model: "gpt-5.4" },
        { provider: "openai", model: "gpt-5.4" },
      ],
    });
    appendFirstAvailableStaticModelButton(rows, params, {
      label: "GPT-5.3 Codex Spark",
      refs: [
        { provider: "openai-codex", model: "gpt-5.3-codex-spark" },
        { provider: "openai", model: "gpt-5.3-codex-spark" },
      ],
    });
    rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.home }]);
    return rows;
  }

  appendFirstAvailableStaticModelButton(rows, params, {
    label: "GPT-5.5",
    refs: [
      { provider: "openai-codex", model: "gpt-5.5" },
      { provider: "openai", model: "gpt-5.5" },
    ],
  });
  rows.push([{ text: "More", callback_data: "mdl_fam_chatgpt_more" }]);
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.home }]);
  return rows;
}

function appendFirstAvailableStaticModelButton(
  rows: ButtonRow[],
  params: {
    byProvider: ReadonlyMap<string, ReadonlySet<string>>;
    currentModel?: string;
  },
  entry: {
    label: string;
    refs: readonly FamilyModelRef[];
  },
) {
  const ref = entry.refs.find((candidate) =>
    hasModelRef({ byProvider: params.byProvider, ...candidate }),
  );
  if (!ref) {
    return;
  }
  appendStaticModelButton(rows, params, { label: entry.label, ...ref });
}

function appendStaticModelButton(
  rows: ButtonRow[],
  params: {
    byProvider: ReadonlyMap<string, ReadonlySet<string>>;
    currentModel?: string;
  },
  ref: FamilyModelRef & { label: string },
) {
  if (!hasModelRef({ byProvider: params.byProvider, provider: ref.provider, model: ref.model })) {
    return;
  }
  const callbackData = buildModelSelectionCallbackData(ref);
  if (!callbackData) {
    return;
  }
  const currentRef = `${ref.provider}/${ref.model}`;
  rows.push([
    {
      text: currentRef === params.currentModel ? `${ref.label} ✓` : ref.label,
      callback_data: callbackData,
    },
  ]);
}

/**
 * Build model list keyboard with pagination and back button.
 */
export function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[] {
  const { provider, models, currentModel, currentPage, totalPages } = params;
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;

  if (models.length === 0) {
    return [[{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]];
  }

  const rows: ButtonRow[] = [];

  // Calculate page slice
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, models.length);
  const pageModels = models.slice(startIndex, endIndex);

  // Model buttons - one per row
  const currentModelId = currentModel?.includes("/")
    ? currentModel.split("/").slice(1).join("/")
    : currentModel;

  for (const model of pageModels) {
    const callbackData = buildModelSelectionCallbackData({ provider, model });
    // Skip models that still exceed Telegram's callback_data limit.
    if (!callbackData) {
      continue;
    }

    const isCurrentModel = model === currentModelId;
    const displayText = truncateModelId(formatModelDisplayName(provider, model), 38);
    const text = isCurrentModel ? `${displayText} ✓` : displayText;

    rows.push([
      {
        text,
        callback_data: callbackData,
      },
    ]);
  }

  // Pagination row
  if (totalPages > 1) {
    const paginationRow: ButtonRow = [];

    if (currentPage > 1) {
      paginationRow.push({
        text: "◀ Prev",
        callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage - 1}`,
      });
    }

    paginationRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage}`, // noop
    });

    if (currentPage < totalPages) {
      paginationRow.push({
        text: "Next ▶",
        callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage + 1}`,
      });
    }

    rows.push(paginationRow);
  }

  // Back button
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);

  return rows;
}

function formatModelDisplayName(provider: string, model: string): string {
  if (provider === "claude-bridge") {
    return CLAUDE_BRIDGE_DISPLAY_NAMES[model] ?? model;
  }
  return model;
}

/**
 * Build "Browse providers" button for /model summary.
 */
export function buildBrowseProvidersButton(): ButtonRow[] {
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
}

/**
 * Truncate model ID for display, preserving end if too long.
 */
function truncateModelId(modelId: string, maxLen: number): string {
  if (modelId.length <= maxLen) {
    return modelId;
  }
  // Show last part with ellipsis prefix
  return `…${modelId.slice(-(maxLen - 1))}`;
}

/**
 * Get page size for model list pagination.
 */
export function getModelsPageSize(): number {
  return MODELS_PAGE_SIZE;
}

/**
 * Calculate total pages for a model list.
 */
export function calculateTotalPages(totalModels: number, pageSize?: number): number {
  const size = pageSize ?? MODELS_PAGE_SIZE;
  return size > 0 ? Math.ceil(totalModels / size) : 1;
}
