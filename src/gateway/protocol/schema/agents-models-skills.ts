import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const AgentsCreateParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    workspace: NonEmptyString,
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    name: NonEmptyString,
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    avatar: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsUpdateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDeleteResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    name: NonEmptyString,
    path: NonEmptyString,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
    content: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    agentId: NonEmptyString,
    workspace: NonEmptyString,
    file: AgentsFileEntrySchema,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object(
  {
    all: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const ModelsSetParamsSchema = Type.Object(
  {
    model: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ModelsSetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    model: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ModelsReadinessParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsReadinessProbeSchema = Type.Object(
  {
    provider: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    profileId: Type.Optional(NonEmptyString),
    label: NonEmptyString,
    source: Type.Union([Type.Literal("profile"), Type.Literal("env"), Type.Literal("models.json")]),
    mode: Type.Optional(Type.String()),
    status: Type.Union([
      Type.Literal("ok"),
      Type.Literal("auth"),
      Type.Literal("rate_limit"),
      Type.Literal("billing"),
      Type.Literal("timeout"),
      Type.Literal("format"),
      Type.Literal("unknown"),
      Type.Literal("no_model"),
    ]),
    reasonCode: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ModelsReadinessResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("checking")]),
    mode: Type.Union([Type.Literal("managed"), Type.Literal("byok")]),
    defaultModel: NonEmptyString,
    configPath: NonEmptyString,
    stateDir: NonEmptyString,
    agentDir: NonEmptyString,
    authMode: Type.Union([Type.Literal("shared"), Type.Literal("byok")]),
    sharedProfileId: Type.Optional(NonEmptyString),
    reasonCodes: Type.Array(
      Type.Union([
        Type.Literal("wrong_state_dir"),
        Type.Literal("missing_auth"),
        Type.Literal("probe_auth_failed"),
        Type.Literal("probe_rate_limited"),
        Type.Literal("probe_billing_failed"),
        Type.Literal("probe_timeout"),
        Type.Literal("probe_no_model"),
        Type.Literal("probe_unknown"),
      ]),
    ),
    summary: Type.String(),
    actions: Type.Array(Type.String()),
    byokAvailable: Type.Boolean(),
    lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
    probeLatencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
    probe: Type.Optional(ModelsReadinessProbeSchema),
  },
  { additionalProperties: false },
);

export const ConsumerAuthInputKindSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("api_key"),
  Type.Literal("token"),
]);

export const ModelsAuthListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsAuthOptionSchema = Type.Object(
  {
    id: NonEmptyString,
    providerId: NonEmptyString,
    providerLabel: NonEmptyString,
    title: NonEmptyString,
    detail: NonEmptyString,
    inputKind: ConsumerAuthInputKindSchema,
    submitLabel: NonEmptyString,
    inputLabel: Type.Optional(NonEmptyString),
    inputHelp: Type.Optional(Type.String()),
    inputPlaceholder: Type.Optional(Type.String()),
    methodKind: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ModelsAuthListResultSchema = Type.Object(
  {
    options: Type.Array(ModelsAuthOptionSchema),
  },
  { additionalProperties: false },
);

export const ModelsAuthApplyParamsSchema = Type.Object(
  {
    optionId: NonEmptyString,
    secret: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ModelsAuthApplyResultSchema = Type.Object(
  {
    optionId: NonEmptyString,
    providerId: NonEmptyString,
    methodId: NonEmptyString,
    defaultModel: Type.Optional(NonEmptyString),
    notes: Type.Array(Type.String()),
    profileIds: Type.Array(NonEmptyString),
    readiness: ModelsReadinessResultSchema,
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  },
  { additionalProperties: false },
);

export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolCatalogProfileSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ToolCatalogEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    description: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    optional: Type.Optional(Type.Boolean()),
    defaultProfiles: Type.Array(
      Type.Union([
        Type.Literal("minimal"),
        Type.Literal("coding"),
        Type.Literal("messaging"),
        Type.Literal("full"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ToolCatalogGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    pluginId: Type.Optional(NonEmptyString),
    tools: Type.Array(ToolCatalogEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    profiles: Type.Array(ToolCatalogProfileSchema),
    groups: Type.Array(ToolCatalogGroupSchema),
  },
  { additionalProperties: false },
);
