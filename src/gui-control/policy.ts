import type {
  AppTarget,
  ElementRef,
  GuiActionType,
  GuiMutationRisk,
  GuiSnapshot,
} from "./types.js";

export const GUI_CAPABILITIES = [
  "read_screen",
  "write_text_to_target",
  "submit_message_to_target",
  "click_verified_button",
  "navigate_url",
  "destructive_action",
] as const;

export const GUI_VERIFICATION_MODES = ["observe_only", "post_state"] as const;

export type GuiCapability = (typeof GUI_CAPABILITIES)[number];
export type GuiVerificationMode = (typeof GUI_VERIFICATION_MODES)[number];

export type GuiTaskPolicy = {
  taskId: string;
  taskName: string;
  allowedApps: string[];
  allowedWindows?: string[];
  grantedCapabilities: GuiCapability[];
  deniedSurfaceTerms: string[];
  requiredVerificationMode: GuiVerificationMode;
};

export const GUI_TASK_POLICY_PROFILE_NAMES = [
  "read_only_web_context",
  "safe_local_settings_navigation",
  "non_committal_web_dry_run",
  "send_message_to_approved_assistant",
  "local_fixture_write",
  "notes_write",
] as const;

export type GuiTaskPolicyProfile = (typeof GUI_TASK_POLICY_PROFILE_NAMES)[number];

export const DEFAULT_DENIED_GUI_SURFACE_TERMS = [
  "login",
  "log in",
  "sign in",
  "auth",
  "password",
  "passkey",
  "payment",
  "billing",
  "account settings",
  "delete",
  "remove",
  "destructive",
];

const LOCAL_SETTINGS_NAVIGATION_DENIED_TERMS = [
  ...DEFAULT_DENIED_GUI_SURFACE_TERMS,
  "account",
  "subscription",
  "stop ai operator",
  "stop operator",
  "quit app only",
  "quit",
  "install update",
  "install updates",
  "update installation",
  "download update",
  "change plan",
  "change account",
];

const NON_COMMITTAL_WEB_DRY_RUN_DENIED_TERMS = [
  ...DEFAULT_DENIED_GUI_SURFACE_TERMS,
  "checkout",
  "purchase",
  "buy",
  "book",
  "confirm",
  "passenger",
  "traveler",
  "card",
  "credit card",
  "passport",
  "otp",
  "2fa",
];

export const GUI_TASK_POLICY_PROFILES: Record<GuiTaskPolicyProfile, GuiTaskPolicy> = {
  read_only_web_context: {
    taskId: "read_only_web_context",
    taskName: "Read-only web context gathering",
    allowedApps: ["Safari", "Google Chrome", "Chrome", "Arc", "Firefox"],
    grantedCapabilities: ["read_screen", "navigate_url"],
    deniedSurfaceTerms: DEFAULT_DENIED_GUI_SURFACE_TERMS,
    requiredVerificationMode: "observe_only",
  },
  safe_local_settings_navigation: {
    taskId: "safe_local_settings_navigation",
    taskName: "Navigate safe local Jarvis settings surfaces",
    allowedApps: ["Jarvis", "OpenClaw"],
    grantedCapabilities: ["read_screen", "click_verified_button"],
    deniedSurfaceTerms: LOCAL_SETTINGS_NAVIGATION_DENIED_TERMS,
    requiredVerificationMode: "post_state",
  },
  non_committal_web_dry_run: {
    taskId: "non_committal_web_dry_run",
    taskName: "Non-committal browser navigation and search dry run",
    allowedApps: ["Safari", "Google Chrome", "Chrome", "Arc", "Firefox"],
    grantedCapabilities: [
      "read_screen",
      "navigate_url",
      "write_text_to_target",
      "click_verified_button",
    ],
    deniedSurfaceTerms: NON_COMMITTAL_WEB_DRY_RUN_DENIED_TERMS,
    requiredVerificationMode: "post_state",
  },
  send_message_to_approved_assistant: {
    taskId: "send_message_to_approved_assistant",
    taskName: "Send a message to an approved assistant window",
    allowedApps: ["Claude", "ChatGPT"],
    allowedWindows: ["Claude", "ChatGPT"],
    grantedCapabilities: [
      "read_screen",
      "write_text_to_target",
      "submit_message_to_target",
      "click_verified_button",
    ],
    deniedSurfaceTerms: DEFAULT_DENIED_GUI_SURFACE_TERMS,
    requiredVerificationMode: "post_state",
  },
  local_fixture_write: {
    taskId: "local_fixture_write",
    taskName: "Write to a local test fixture",
    allowedApps: ["Claude", "TextEdit", "Terminal"],
    grantedCapabilities: ["read_screen", "write_text_to_target", "click_verified_button"],
    deniedSurfaceTerms: DEFAULT_DENIED_GUI_SURFACE_TERMS,
    requiredVerificationMode: "post_state",
  },
  notes_write: {
    taskId: "notes_write",
    taskName: "Write benchmark text to Apple Notes",
    allowedApps: ["Notes"],
    grantedCapabilities: ["read_screen", "write_text_to_target"],
    deniedSurfaceTerms: DEFAULT_DENIED_GUI_SURFACE_TERMS,
    requiredVerificationMode: "post_state",
  },
};

const DEFAULT_GUI_TASK_POLICY: GuiTaskPolicy = {
  taskId: "default_read_only",
  taskName: "Default read-only GUI policy",
  allowedApps: ["*"],
  grantedCapabilities: ["read_screen"],
  deniedSurfaceTerms: DEFAULT_DENIED_GUI_SURFACE_TERMS,
  requiredVerificationMode: "observe_only",
};

export type GuiPolicyDecision = {
  allowed: boolean;
  risk: GuiMutationRisk;
  reason?: string;
  requiredCapability?: GuiCapability;
  taskPolicy?: GuiTaskPolicy;
};

export type GuiPolicyInput = {
  actionType: GuiActionType;
  target: AppTarget;
  snapshot?: GuiSnapshot;
  element?: ElementRef;
  reason: string;
  approvedPolicyRisk?: boolean;
  taskPolicy?: GuiTaskPolicy;
  verificationMode?: GuiVerificationMode;
};

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function searchableText(input: GuiPolicyInput): string {
  return [
    input.target.appName,
    input.target.windowTitle,
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    input.snapshot?.summary,
    ...(input.snapshot?.visibleText ?? []),
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    input.element?.description,
    input.element?.value,
    input.reason,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function sensitiveSurfaceText(input: GuiPolicyInput): string {
  if (input.actionType === "observe") {
    return searchableText(input);
  }

  // Mutations should be judged against the target and selected element, not
  // every unrelated AX string in the app snapshot. Browser/toolbars often
  // expose generic items like "Remove from toolbar"; treating that as the
  // action surface creates false blocks while adding no real safety.
  return [
    input.target.appName,
    input.target.windowTitle,
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    input.element?.description,
    input.element?.value,
    input.reason,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function selectedMutationSurfaceText(input: GuiPolicyInput): string {
  return [
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    input.element?.description,
    input.element?.value,
    input.reason,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function intendedActionText(input: GuiPolicyInput): string {
  return [
    input.target.appName,
    input.target.windowTitle,
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    input.element?.description,
    input.reason,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function surfaceTermPattern(term: string): RegExp {
  const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function hasAnyTerm(haystack: string, terms: string[]): string | undefined {
  return terms.find((term) => surfaceTermPattern(term).test(haystack));
}

function isAllowedNonCommittalUiCardContext(haystack: string): boolean {
  return (
    /\b(fare|flight|result|search|suggestion)\s+card\b/.test(haystack) &&
    !hasAnyTerm(haystack, ["credit card", "payment card", "billing card"])
  );
}

function isAllowedNonCommittalBookChrome(input: GuiPolicyInput): boolean {
  const pageChrome = [input.target.windowTitle, input.snapshot?.windowTitle]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  return (
    pageChrome.includes("google flights") &&
    pageChrome.includes("book your ticket") &&
    !hasAnyTerm(selectedMutationSurfaceText(input), ["book"])
  );
}

function targetMatchesAllowedTerm(
  value: string | undefined,
  allowed: string[] | undefined,
): boolean {
  if (!allowed?.length) {
    return true;
  }
  const normalizedValue = normalizeText(value);
  return allowed.some((term) => {
    const normalizedTerm = normalizeText(term);
    return normalizedTerm === "*" || normalizedValue.includes(normalizedTerm);
  });
}

function actionRequiresCapability(input: GuiPolicyInput): GuiCapability {
  if (input.actionType === "observe" || input.actionType === "scroll") {
    return "read_screen";
  }
  if (input.actionType === "setValue") {
    return "write_text_to_target";
  }
  if (input.actionType === "press") {
    return "submit_message_to_target";
  }

  // Element activations are ambiguous by design. Treat obvious send/submit
  // intents as a message submission capability; everything else is a verified
  // button action. Sensitive or destructive labels are blocked before this map.
  const actionText = intendedActionText(input);
  return hasAnyTerm(actionText, ["send", "submit", "message"])
    ? "submit_message_to_target"
    : "click_verified_button";
}

function resolvePolicy(input: GuiPolicyInput): GuiTaskPolicy {
  return input.taskPolicy ?? DEFAULT_GUI_TASK_POLICY;
}

export function getGuiTaskPolicyProfile(profile: GuiTaskPolicyProfile): GuiTaskPolicy {
  return GUI_TASK_POLICY_PROFILES[profile];
}

export function evaluateGuiPolicy(input: GuiPolicyInput): GuiPolicyDecision {
  const taskPolicy = resolvePolicy(input);
  const requiredCapability = actionRequiresCapability(input);

  if (!targetMatchesAllowedTerm(input.target.appName, taskPolicy.allowedApps)) {
    return {
      allowed: false,
      risk: "blocked",
      reason: `GUI task policy ${taskPolicy.taskId} does not allow app ${input.target.appName}.`,
      requiredCapability,
      taskPolicy,
    };
  }

  if (
    input.target.windowTitle &&
    !targetMatchesAllowedTerm(input.target.windowTitle, taskPolicy.allowedWindows)
  ) {
    return {
      allowed: false,
      risk: "blocked",
      reason: `GUI task policy ${taskPolicy.taskId} does not allow window ${input.target.windowTitle}.`,
      requiredCapability,
      taskPolicy,
    };
  }

  // Denied surfaces are capability-proof. Login, payment, account settings,
  // and destructive surfaces stay blocked even when a caller has mutation
  // approval, because those require a higher-trust flow than this verifier.
  const text = sensitiveSurfaceText(input);
  let blockedSurface = hasAnyTerm(text, taskPolicy.deniedSurfaceTerms);
  if (
    blockedSurface === "card" &&
    taskPolicy.taskId === "non_committal_web_dry_run" &&
    isAllowedNonCommittalUiCardContext(text)
  ) {
    blockedSurface = undefined;
  }
  if (
    blockedSurface === "book" &&
    taskPolicy.taskId === "non_committal_web_dry_run" &&
    isAllowedNonCommittalBookChrome(input)
  ) {
    blockedSurface = undefined;
  }
  if (blockedSurface) {
    return {
      allowed: false,
      risk: "blocked",
      reason: `Blocked sensitive GUI surface: ${blockedSurface}`,
      requiredCapability,
      taskPolicy,
    };
  }

  if (!taskPolicy.grantedCapabilities.includes(requiredCapability)) {
    return {
      allowed: false,
      risk: "blocked",
      reason: `GUI task policy ${taskPolicy.taskId} lacks capability ${requiredCapability}.`,
      requiredCapability,
      taskPolicy,
    };
  }

  if (
    taskPolicy.requiredVerificationMode === "post_state" &&
    input.verificationMode !== "post_state"
  ) {
    return {
      allowed: false,
      risk: "blocked",
      reason: `GUI task policy ${taskPolicy.taskId} requires post-state verification.`,
      requiredCapability,
      taskPolicy,
    };
  }

  if (input.actionType === "observe") {
    return { allowed: true, risk: "read-only", requiredCapability, taskPolicy };
  }

  // Approval is separate from capability. Capability says the task may do this
  // kind of thing; approval says this specific run was intentionally allowed.
  if (!input.approvedPolicyRisk) {
    return {
      allowed: false,
      risk: "blocked",
      reason: "Mutating GUI action requires explicit task approval.",
      requiredCapability,
      taskPolicy,
    };
  }

  return { allowed: true, risk: "allowed-mutation", requiredCapability, taskPolicy };
}
