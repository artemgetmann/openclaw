import type { ElementRef, GuiSnapshot } from "./types.js";

export type ElementIntent = "text-input" | "button" | "any";

export type ElementResolutionInput = {
  ref?: string;
  intent?: ElementIntent;
  labelIncludes?: string;
  valueIncludes?: string;
};

export type ElementResolutionResult =
  | {
      ok: true;
      element: ElementRef;
      candidates: ElementRef[];
      summary: string;
    }
  | {
      ok: false;
      candidates: ElementRef[];
      summary: string;
    };

function normalize(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function semanticText(element: ElementRef): string {
  return [
    element.label,
    element.name,
    element.title,
    element.description,
    element.value,
    element.role,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function roleMatchesIntent(element: ElementRef, intent: ElementIntent): boolean {
  if (intent === "any") {
    return true;
  }
  const role = normalize(element.role);
  const text = normalize(semanticText(element));
  if (intent === "text-input") {
    if (role.includes("button") || role.includes("link")) {
      return false;
    }
    return (
      role.includes("text") ||
      role.includes("edit") ||
      role.includes("input") ||
      role.includes("combo") ||
      text.includes("message") ||
      text.includes("composer") ||
      text.includes("prompt")
    );
  }
  return role.includes("button") || text.includes("send");
}

function textMatches(haystack: string | undefined, needle: string | undefined): boolean {
  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle) {
    return true;
  }
  return normalize(haystack).includes(normalizedNeedle);
}

function describeElement(element: ElementRef): string {
  return [
    element.ref,
    element.role ? `role=${element.role}` : "",
    element.label ? `label=${element.label}` : "",
    element.description ? `description=${element.description}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function resolveElementRef(
  snapshot: GuiSnapshot,
  input: ElementResolutionInput,
): ElementResolutionResult {
  if (input.ref) {
    const exact = snapshot.elements.find((element) => element.ref === input.ref);
    return exact
      ? {
          ok: true,
          element: exact,
          candidates: [exact],
          summary: `Resolved exact element ${describeElement(exact)}.`,
        }
      : {
          ok: false,
          candidates: [],
          summary: `Element ref ${input.ref} was not present in the latest ${snapshot.appName} snapshot.`,
        };
  }

  const intent = input.intent ?? "any";
  const candidates = snapshot.elements.filter(
    (element) =>
      roleMatchesIntent(element, intent) &&
      textMatches(semanticText(element), input.labelIncludes) &&
      textMatches(element.value, input.valueIncludes),
  );

  if (candidates.length === 1) {
    const [element] = candidates;
    return {
      ok: true,
      element,
      candidates,
      summary: `Resolved ${intent} element ${describeElement(element)}.`,
    };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      candidates,
      summary: `No ${intent} element matched the latest ${snapshot.appName} snapshot.`,
    };
  }

  return {
    ok: false,
    candidates,
    summary: `Found ${candidates.length} possible ${intent} elements; refusing to guess.`,
  };
}
