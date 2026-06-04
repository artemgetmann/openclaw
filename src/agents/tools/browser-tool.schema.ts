import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";

const BROWSER_ACT_KINDS = [
  "batch",
  "click",
  "type",
  "press",
  "hover",
  "scrollIntoView",
  "drag",
  "select",
  "chooseOption",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
] as const;

const BROWSER_TOOL_ACTIONS = [
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "screenshot",
  "navigate",
  "console",
  "pdf",
  "upload",
  "dialog",
  "act",
] as const;

const BROWSER_TARGETS = ["sandbox", "host", "node"] as const;

const BROWSER_SNAPSHOT_FORMATS = ["aria", "ai"] as const;
const BROWSER_SNAPSHOT_MODES = ["efficient"] as const;
const BROWSER_SNAPSHOT_REFS = ["role", "aria"] as const;
const BROWSER_OPTION_MATCH_MODES = ["exact", "contains", "regex"] as const;

const BROWSER_IMAGE_TYPES = ["png", "jpeg"] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (kind) determines which properties are relevant; runtime validates.
const BrowserActSchema = Type.Object({
  kind: stringEnum(BROWSER_ACT_KINDS),
  // Common fields
  targetId: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  inputRef: Type.Optional(
    Type.String({
      description:
        "Compatibility alias for ref. Prefer ref from the latest snapshot, especially for existing-session Chrome MCP profiles.",
    }),
  ),
  element: Type.Optional(
    Type.String({
      description:
        "Compatibility alias for selector when used with act requests. Prefer ref for existing-session Chrome MCP profiles.",
    }),
  ),
  includeSnapshot: Type.Optional(
    Type.Boolean({
      description:
        "For mutating act requests (click/type/fill/press/select/chooseOption), set true to return a fresh structured aria-ref snapshot in the same tool result. Prefer this over a separate snapshot call after page-changing actions.",
    }),
  ),
  snapshotFormat: optionalStringEnum(BROWSER_SNAPSHOT_FORMATS),
  refs: optionalStringEnum(BROWSER_SNAPSHOT_REFS),
  mode: optionalStringEnum(BROWSER_SNAPSHOT_MODES),
  compact: Type.Optional(Type.Boolean()),
  depth: Type.Optional(Type.Number()),
  maxChars: Type.Optional(Type.Number()),
  labels: Type.Optional(Type.Boolean()),
  // click
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String())),
  // type
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  // press
  key: Type.Optional(
    Type.String({
      description:
        "For kind=press, the key to press. For searchable selects/comboboxes/listboxes, prefer kind=chooseOption instead of manual fill+Enter.",
    }),
  ),
  delayMs: Type.Optional(Type.Number()),
  // drag
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  // select
  values: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "For kind=select, values for native <select> controls. For custom searchable selects/comboboxes/listboxes, use kind=chooseOption with optionText instead.",
    }),
  ),
  // chooseOption
  optionText: Type.Optional(
    Type.String({
      description:
        "For kind=chooseOption, the semantic visible option text or stable unique visible substring to select from a searchable select/combobox/listbox. Exact visible text is preferred; this is the only text used to verify the matched option.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Optional filter/search text to type into the control before choosing optionText. Defaults to optionText; it is not accepted as a matched option by itself.",
    }),
  ),
  match: optionalStringEnum(BROWSER_OPTION_MATCH_MODES, {
    description:
      'How to match optionText for kind=chooseOption. Defaults to "exact"; use "contains" only when the visible label has extra text, and "regex" only when exact text is impossible.',
  }),
  // fill - use permissive array of objects
  fields: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true }), {
      description:
        "For kind=fill, form fields from snapshot refs/selectors using value (text is accepted as a value alias). For searchable combobox/listbox option picking, use kind=chooseOption.",
    }),
  ),
  // batch
  actions: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
  stopOnError: Type.Optional(Type.Boolean()),
  // resize
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  // wait
  timeMs: Type.Optional(Type.Number()),
  selector: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  loadState: Type.Optional(Type.String()),
  textGone: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // evaluate
  fn: Type.Optional(Type.String()),
});

// IMPORTANT: OpenAI function tool schemas must have a top-level `type: "object"`.
// A root-level `Type.Union([...])` compiles to `{ anyOf: [...] }` (no `type`),
// which OpenAI rejects ("Invalid schema ... type: None"). Keep this schema an object.
export const BrowserToolSchema = Type.Object({
  action: stringEnum(BROWSER_TOOL_ACTIONS),
  target: optionalStringEnum(BROWSER_TARGETS),
  node: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  targetUrl: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  maxChars: Type.Optional(Type.Number()),
  mode: optionalStringEnum(BROWSER_SNAPSHOT_MODES),
  snapshotFormat: optionalStringEnum(BROWSER_SNAPSHOT_FORMATS),
  refs: optionalStringEnum(BROWSER_SNAPSHOT_REFS),
  interactive: Type.Optional(Type.Boolean()),
  compact: Type.Optional(Type.Boolean()),
  depth: Type.Optional(Type.Number()),
  selector: Type.Optional(Type.String()),
  frame: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Boolean()),
  fullPage: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Type.String()),
  element: Type.Optional(
    Type.String({
      description:
        "Screenshot element target, or legacy flattened act compatibility alias for selector. Prefer ref for existing-session Chrome MCP profiles.",
    }),
  ),
  type: optionalStringEnum(BROWSER_IMAGE_TYPES),
  level: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
  inputRef: Type.Optional(
    Type.String({
      description:
        "Upload input target, or legacy flattened act compatibility alias for ref. Prefer ref from the latest snapshot.",
    }),
  ),
  timeoutMs: Type.Optional(Type.Number()),
  accept: Type.Optional(Type.Boolean()),
  promptText: Type.Optional(Type.String()),
  // Legacy flattened act params (preferred: request={...})
  kind: Type.Optional(stringEnum(BROWSER_ACT_KINDS)),
  includeSnapshot: Type.Optional(
    Type.Boolean({
      description:
        "Legacy flattened act option. For mutating browser actions (click/type/fill/press/select/chooseOption), set true so the result includes a fresh structured aria-ref snapshot for the next step.",
    }),
  ),
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String())),
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  key: Type.Optional(
    Type.String({
      description:
        "Legacy flattened act option. For searchable selects/comboboxes/listboxes, prefer kind=chooseOption instead of manual fill+Enter.",
    }),
  ),
  delayMs: Type.Optional(Type.Number()),
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  values: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Legacy flattened act option. Use with native <select>; for custom searchable selects/comboboxes/listboxes use kind=chooseOption with optionText.",
    }),
  ),
  optionText: Type.Optional(
    Type.String({
      description:
        "Legacy flattened act option for kind=chooseOption. Semantic visible option text or stable unique visible substring to select from a searchable select/combobox/listbox; this is the verification target.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Legacy flattened act option for kind=chooseOption. Optional filter/search text; defaults to optionText and is not a match target.",
    }),
  ),
  match: optionalStringEnum(BROWSER_OPTION_MATCH_MODES),
  fields: Type.Optional(
    Type.Array(Type.Object({}, { additionalProperties: true }), {
      description:
        "Legacy flattened act option. Fill fields from snapshot refs using value (text is accepted as a value alias); for searchable option picking, use kind=chooseOption.",
    }),
  ),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  timeMs: Type.Optional(Type.Number()),
  textGone: Type.Optional(Type.String()),
  loadState: Type.Optional(Type.String()),
  fn: Type.Optional(Type.String()),
  actions: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
  stopOnError: Type.Optional(Type.Boolean()),
  request: Type.Optional(BrowserActSchema),
});
