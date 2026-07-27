import { createHmac, randomBytes } from "node:crypto";
import type {
  AppTarget,
  ElementRef,
  GuiActionType,
  GuiMutationRisk,
  GuiRuntimeName,
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

// The verifier needs a stable identity digest during one process lifetime, but
// must not expose a reusable hash of passwords, OTPs, or account identifiers.
// A process-local HMAC binds the raw observed context without making low-
// entropy secrets guessable from the approval scope.
const GUI_APPROVAL_SCOPE_HMAC_KEY = randomBytes(32);

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
  "trusted_local_gui_control",
  "read_only_web_context",
  "safe_local_settings_navigation",
  "non_committal_web_dry_run",
  "commerce_flow_until_final_confirmation",
  "software_update_flow",
  "software_update_install_approved",
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
  "authentication",
  "password",
  "passkey",
  "touch id",
  "face id",
  "biometric",
  "fingerprint",
  "otp",
  "one-time password",
  "verification code",
  "two-factor",
  "2fa",
  "captcha",
  "security key",
  "authentication request",
  "sign-in request",
  "login request",
  "approve authentication",
  "approve sign in",
  "approve login",
  "payment",
  "billing",
  "account settings",
  "delete",
  "remove",
  "destructive",
];

const TRUSTED_LOCAL_GUI_HARD_STOP_TERMS = [
  ...DEFAULT_DENIED_GUI_SURFACE_TERMS,
  "sign-in",
  "oauth",
  "token",
  "secret",
  "payment method",
  "change payment",
  "add payment",
  "credit card",
  "debit card",
  "payment card",
  "card details",
  "card number",
  "security code",
  "cvv",
  "cvc",
  "checkout",
  "pay now",
  "place order",
  "final booking",
  "final confirmation",
  "confirm booking",
  "confirm order",
  "confirm purchase",
  "confirm payment",
  "buy now",
  "purchase",
  "subscribe",
  "subscription",
  "upgrade",
  "start trial",
  "delete account",
  "remove account",
  "close account",
  "deactivate account",
  "cancel account",
  "change account",
  "switch account",
  "account change",
  "delete profile",
  "remove profile",
  "delete user",
  "remove user",
  "security settings",
  "install",
  "install update",
  "install updates",
  "install now",
  "install and relaunch",
  "download and install",
  "update now",
  "upgrade now",
  "relaunch to update",
  "restart to update",
  "replace app",
  "move to applications",
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
  "install now",
  "install and relaunch",
  "update now",
  "update installation",
  "download update",
  "relaunch to update",
  "restart to update",
  "replace app",
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

const COMMERCE_UNTIL_FINAL_CONFIRMATION_DENIED_TERMS = [
  ...DEFAULT_DENIED_GUI_SURFACE_TERMS,
  "payment method",
  "change payment",
  "add payment",
  "credit card",
  "debit card",
  "payment card",
  "card details",
  "card number",
  "security code",
  "cvv",
  "cvc",
  "expiration date",
  "expiry date",
  "pay",
  "pay now",
  "book",
  "final booking",
  "confirm",
  "order",
  "order now",
  "reserve",
  "place order",
  "confirm booking",
  "confirm order",
  "confirm purchase",
  "confirm payment",
  "confirm charge",
  "buy now",
  "purchase",
  "subscribe",
  "subscription",
  "upgrade",
  "start trial",
  "start free trial",
  "book now",
  "complete booking",
  "complete order",
  "otp",
  "one-time password",
  "two-factor",
  "2fa",
  "login",
  "log in",
  "sign in",
  "passkey",
  "password",
  "account settings",
  "security settings",
  "delete account",
  "remove account",
  "close account",
  "deactivate account",
  "cancel account",
  "change account",
  "switch account",
  "account change",
  "delete profile",
  "remove profile",
  "delete user",
  "remove user",
  "destructive",
  "cancel booking",
  "cancel order",
  "delete order",
  "refund",
  "void",
];

// Commerce flows need two different safety lenses:
// - the selected control/reason should block final booking, purchase, payment,
//   auth, and destructive controls;
// - the broader page context should block hard-stop auth/payment/security pages
//   even when the selected button is generically labeled "Continue".
//
// Keep final-booking words like "book" out of the context-only list because
// normal search/result pages can legitimately have titles like "Book your
// ticket" while still being reversible pre-payment navigation.
const COMMERCE_HARD_STOP_CONTEXT_TERMS = [
  "login",
  "log in",
  "sign in",
  "auth",
  "authentication",
  "password",
  "passkey",
  "verification code",
  "captcha",
  "security key",
  "authentication request",
  "sign-in request",
  "login request",
  "approve authentication",
  "approve sign in",
  "approve login",
  "payment",
  "billing",
  "account settings",
  "payment method",
  "change payment",
  "add payment",
  "credit card",
  "debit card",
  "payment card",
  "card details",
  "card number",
  "security code",
  "cvv",
  "cvc",
  "expiration date",
  "expiry date",
  "pay with",
  "apple pay",
  "paypal",
  "pay now",
  "pay",
  "final confirmation",
  "review and confirm",
  "place order",
  "confirm order",
  "confirm purchase",
  "confirm payment",
  "confirm charge",
  "buy now",
  "purchase",
  "subscribe",
  "subscription",
  "upgrade",
  "start trial",
  "start free trial",
  "book now",
  "complete booking",
  "complete order",
  "otp",
  "one-time password",
  "two-factor",
  "2fa",
  "account settings",
  "security settings",
  "delete account",
  "remove account",
  "close account",
  "deactivate account",
  "cancel account",
  "change account",
  "switch account",
  "account change",
  "delete profile",
  "remove profile",
  "delete user",
  "remove user",
  "destructive",
  "cancel booking",
  "cancel order",
  "delete order",
  "refund",
  "void",
];

const SOFTWARE_UPDATE_FLOW_DENIED_TERMS = [
  ...DEFAULT_DENIED_GUI_SURFACE_TERMS,
  "install update",
  "install updates",
  "install now",
  "install on quit",
  "install and relaunch",
  "download and install",
  "download & install",
  "download/install",
  "download update",
  "update now",
  "upgrade now",
  "relaunch",
  "restart to update",
  "relaunch to update",
  "quit and install",
  "replace app",
  "replace existing",
  "move to applications",
];

// This profile is intentionally narrower than "anything updater-like." It
// permits the Sparkle-style install controls we can prove after explicit user
// approval, while keeping download/replace/move flows blocked until they have
// their own proof and approval semantics.
const SOFTWARE_UPDATE_INSTALL_APPROVED_DENIED_TERMS = [
  ...DEFAULT_DENIED_GUI_SURFACE_TERMS,
  "download and install",
  "download & install",
  "download/install",
  "download update",
  "update now",
  "upgrade now",
  "restart to update",
  "relaunch to update",
  "quit and install",
  "replace app",
  "replace existing",
  "move to applications",
];

export const GUI_TASK_POLICY_PROFILES: Record<GuiTaskPolicyProfile, GuiTaskPolicy> = {
  trusted_local_gui_control: {
    taskId: "trusted_local_gui_control",
    taskName: "Trusted local GUI control",
    allowedApps: ["*"],
    grantedCapabilities: [
      "read_screen",
      "navigate_url",
      "write_text_to_target",
      "submit_message_to_target",
      "click_verified_button",
    ],
    deniedSurfaceTerms: TRUSTED_LOCAL_GUI_HARD_STOP_TERMS,
    requiredVerificationMode: "post_state",
  },
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
    taskName: "Navigate safe local app settings surfaces",
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
  commerce_flow_until_final_confirmation: {
    taskId: "commerce_flow_until_final_confirmation",
    taskName: "Commerce flow until payment or final confirmation",
    allowedApps: ["Safari", "Google Chrome", "Chrome", "Arc", "Firefox"],
    grantedCapabilities: [
      "read_screen",
      "navigate_url",
      "write_text_to_target",
      "click_verified_button",
    ],
    deniedSurfaceTerms: COMMERCE_UNTIL_FINAL_CONFIRMATION_DENIED_TERMS,
    requiredVerificationMode: "post_state",
  },
  software_update_flow: {
    taskId: "software_update_flow",
    taskName: "Software update discovery before install/relaunch",
    allowedApps: ["*"],
    grantedCapabilities: ["read_screen", "click_verified_button"],
    deniedSurfaceTerms: SOFTWARE_UPDATE_FLOW_DENIED_TERMS,
    requiredVerificationMode: "post_state",
  },
  software_update_install_approved: {
    taskId: "software_update_install_approved",
    taskName: "Approved software update install/relaunch",
    allowedApps: ["*"],
    grantedCapabilities: ["read_screen", "click_verified_button"],
    deniedSurfaceTerms: SOFTWARE_UPDATE_INSTALL_APPROVED_DENIED_TERMS,
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
  taskId: "trusted_local_gui_control",
  taskName: "Trusted local GUI control",
  allowedApps: ["*"],
  grantedCapabilities: [
    "read_screen",
    "navigate_url",
    "write_text_to_target",
    "submit_message_to_target",
    "click_verified_button",
  ],
  deniedSurfaceTerms: TRUSTED_LOCAL_GUI_HARD_STOP_TERMS,
  requiredVerificationMode: "post_state",
};

export type GuiPolicyDecision = {
  allowed: boolean;
  risk: GuiMutationRisk;
  reason?: string;
  requiredCapability?: GuiCapability;
  taskPolicy?: GuiTaskPolicy;
  approvalScope?: GuiApprovalScope;
  requiredSensitiveApproval?: GuiApprovalScope;
};

/**
 * The semantic target covered by one explicit GUI approval.
 *
 * Refs and bounds are deliberately excluded because accessibility runtimes can
 * renumber or reposition the same control. Secrets and current field values are
 * also excluded so an approval scope is safe to retain in audit/debug output.
 */
export type GuiApprovalScope = {
  actionType: GuiActionType;
  runtimeName: GuiRuntimeName | "unknown";
  appName: string;
  windowTitle: string;
  windowId: string;
  taskPolicyId: string;
  selectedControl: string[];
  actionParameters: string[];
  visibleTransactionDetails: string[];
  visibleContextSummary: string[];
  visibleContextFingerprint: string;
  sensitiveTerms: string[];
};

export type GuiPolicyInput = {
  actionType: GuiActionType;
  runtimeName?: GuiRuntimeName;
  target: AppTarget;
  snapshot?: GuiSnapshot;
  element?: ElementRef;
  secondaryAction?: string;
  keys?: string[];
  scroll?: { direction?: "up" | "down" | "left" | "right"; amount?: number };
  reason: string;
  approvedPolicyRisk?: boolean;
  approvedSensitiveScope?: GuiApprovalScope;
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
    input.secondaryAction,
    input.reason,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function visibleContextText(input: GuiPolicyInput): string {
  return [
    input.target.appName,
    input.target.windowTitle,
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    input.snapshot?.summary,
    ...(input.snapshot?.visibleText ?? []),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function sanitizeAccountChooserManagementSibling(part: string): string {
  const normalized = normalizeText(part);
  const match =
    /^(?:(?:\d+\s+)?(?:button|link|row|cell|list item)\s+)?remove (?:an )?account(?<metadata>\s+(?:id|value|description|secondary actions|frame):.*)?$/.exec(
      normalized,
    );
  if (!match) {
    // Unknown formats and prose remain intact so provider schema drift cannot
    // silently erase future safety evidence.
    return part;
  }

  const metadata = normalizeText(match.groups?.metadata);
  if (!metadata) {
    return "";
  }

  // OCU sometimes duplicates the element label into Description or Value.
  // Remove only an exact duplicate at recognized field boundaries. Distinct
  // values, actions/frame data, and unknown trailing formats remain available
  // to the normal hard-stop scan.
  return normalizeText(
    metadata.replace(
      /(?:^|\s)(?:description|value):\s*remove (?:an )?account(?=\s+(?:id|value|description|secondary actions|frame):|$)/g,
      " ",
    ),
  );
}

function preAuthHardStopContextParts(input: GuiPolicyInput): Array<string | undefined> {
  const selectedSafeChooserTarget = isSafeAccountChooserSelection(input);
  const visibleText = (input.snapshot?.visibleText ?? [])
    .map((part) => {
      if (!selectedSafeChooserTarget) {
        return part;
      }

      // Google account choosers expose this management affordance beside normal
      // rows. Sanitize only when the selected target is independently proven
      // safe; selected removal controls never enter this branch.
      return sanitizeAccountChooserManagementSibling(part);
    })
    .filter(Boolean);
  const summary = selectedSafeChooserTarget
    ? input.snapshot?.summary
        ?.split(/\r?\n/)
        // Text-only OCU snapshots duplicate every accessible element into the
        // fallback summary. Strip the sibling label but retain metadata, titles,
        // prose, and every other source of risk evidence.
        .map(sanitizeAccountChooserManagementSibling)
        .filter(Boolean)
        .join("\n")
    : input.snapshot?.summary;

  return [
    input.target.appName,
    input.target.windowTitle,
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    summary,
    ...visibleText,
  ];
}

function preAuthHardStopContextText(input: GuiPolicyInput): string {
  return preAuthHardStopContextParts(input).map(normalizeText).filter(Boolean).join(" ");
}

function commerceHardStopContextText(input: GuiPolicyInput): string {
  return preAuthHardStopContextParts(input)
    .map(commerceHardStopContextPart)
    .filter(Boolean)
    .join(" ");
}

function commerceHardStopContextPart(value: string | undefined): string {
  const text = normalizeText(value);
  if (!text || !hasAnyTerm(text, COMMERCE_HARD_STOP_CONTEXT_TERMS)) {
    return "";
  }
  return text;
}

function reasonAsDeniedSurfaceText(input: GuiPolicyInput, deniedTerms: string[]): string {
  const reason = normalizeText(input.reason);
  if (!reason || !hasAnyTerm(reason, deniedTerms)) {
    return "";
  }
  const hasStopBeforeBoundary = /\bstop before\b/.test(reason);

  // A boundary phrase only helps when the action itself remains reversible. If
  // the request says to proceed into payment/card/final-confirmation territory,
  // the negative clause after it cannot launder the transition into a safe
  // pre-payment click.
  if (
    /\b(continue|proceed|go|advance|navigate|move|open)\s+(?:to|into|through|toward|towards)\s+(?:the\s+)?(pay|payment|billing|card details|final confirmation|final booking|purchase confirmation|booking confirmation)\b/.test(
      reason,
    ) ||
    /\b(enter|add|provide|submit|save|use)\s+(?:a\s+|the\s+|this\s+)?(payment|payment method|card|credit card|debit card|card details|card number)\b/.test(
      reason,
    ) ||
    (!hasStopBeforeBoundary &&
      /\b(book|reserve|confirm|purchase|buy|order|subscribe|upgrade)\b/.test(reason))
  ) {
    return reason;
  }

  // Operators often state a boundary in the reason, for example "open this
  // result; stop before booking or payment." That text should document the
  // safety boundary, not make a harmless selected element look committal.
  if (/\b(stop before|do not|don't|without|avoid|not|no)\b/.test(reason)) {
    return "";
  }

  return reason;
}

function sensitiveSurfaceText(input: GuiPolicyInput, deniedTerms: string[]): string {
  if (input.actionType === "observe") {
    return searchableText(input);
  }

  if (input.taskPolicy?.taskId === "commerce_flow_until_final_confirmation") {
    return [selectedMutationSurfaceText(input), reasonAsDeniedSurfaceText(input, deniedTerms)]
      .map(normalizeText)
      .filter(Boolean)
      .join(" ");
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
    input.secondaryAction,
    reasonAsDeniedSurfaceText(input, deniedTerms),
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
    input.secondaryAction,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

const AUTHENTICATION_BOUNDARY_TERMS = [
  "login",
  "log in",
  "sign in",
  "sign-in",
  "auth",
  "authentication",
  "oauth",
  "token",
  "secret",
  "password",
  "passkey",
  "touch id",
  "face id",
  "biometric",
  "fingerprint",
  "otp",
  "one-time password",
  "verification code",
  "two-factor",
  "2fa",
  "captcha",
  "security key",
  "authentication request",
  "sign-in request",
  "login request",
  "approve authentication",
  "approve sign in",
  "approve login",
];

// Opening an authentication flow is navigation; completing a challenge is an
// authentication act. Keep this list limited to visible evidence that a click
// can use or assert a credential. Generic "Sign In" text is intentionally not
// included: many native apps and websites use it only to open the next screen.
const AUTHENTICATION_ACT_CONTEXT_TERMS = [
  "password",
  "text field",
  "textfield",
  "textbox",
  "secure text field",
  "securetextfield",
  "axtextfield",
  "axsecuretextfield",
  "passkey",
  "touch id",
  "face id",
  "biometric",
  "fingerprint",
  "otp",
  "pin",
  "one-time password",
  "one-time code",
  "authentication code",
  "verification code",
  "security code",
  "access code",
  "recovery code",
  "backup code",
  "digit code",
  "apple account",
  "apple id",
  "email",
  "e-mail",
  "username",
  "user name",
  "phone",
  "mobile",
  "magic link",
  "account identifier",
  "two-factor",
  "2fa",
  "captcha",
  "security key",
  "token",
  "secret",
  "authentication request",
  "sign-in request",
  "login request",
  "approve authentication",
  "approve sign in",
  "approve login",
];

function hasAuthenticationActContext(input: GuiPolicyInput): boolean {
  // Include every observed element's role and metadata. Some runtimes attach
  // challenge evidence only to a secure field or to the selected button's
  // description instead of duplicating it into visibleText. App Store exposes
  // its persistent toolbar Search field in the same flat AX tree as the modal,
  // so exclude only that exact chrome control; all other editable fields remain
  // challenge evidence.
  const ignoredSearchMetadata = new Set<string>();
  const elementContext = (input.snapshot?.elements ?? []).flatMap((element) => {
    const stableIdentity = [element.name, element.title, element.label]
      .map(normalizeText)
      .filter(Boolean);
    const metadata = [
      element.name,
      element.title,
      element.label,
      element.description,
      element.value,
    ]
      .map(normalizeText)
      .filter(Boolean);
    const role = normalizeText(element.role);
    const rolePrefixedSearch = [role, ...stableIdentity].some((part) =>
      /^(?:textfield|text field|textbox|axtextfield)\s+(?:search|search app store)$/.test(part),
    );
    const isKnownToolbarSearch =
      rolePrefixedSearch ||
      (/^(?:textfield|text field|textbox|axtextfield)$/.test(role) &&
        stableIdentity.some((part) => ["search", "search app store"].includes(part)));
    if (isKnownToolbarSearch) {
      const stableSearchMetadata = [element.name, element.title, element.label, element.description]
        .map(normalizeText)
        .filter(Boolean);
      for (const part of stableSearchMetadata) {
        ignoredSearchMetadata.add(part);
      }
      const value = normalizeText(element.value);
      if (value && !hasAnyTerm(value, AUTHENTICATION_ACT_CONTEXT_TERMS)) {
        ignoredSearchMetadata.add(value);
      }
      ignoredSearchMetadata.add([role, ...stableSearchMetadata, value].filter(Boolean).join(" "));
    }
    return isKnownToolbarSearch ? [] : [element.role, ...metadata];
  });
  const visibleContext = [
    input.target.appName,
    input.target.windowTitle,
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    ...(input.snapshot?.summary?.split(/\r?\n/).filter((line) => {
      const normalized = normalizeText(line);
      return (
        !ignoredSearchMetadata.has(normalized) &&
        !/^\d+\s+(?:textfield|text field|textbox|axtextfield)\s+(?:search|search app store)\b/.test(
          normalized,
        )
      );
    }) ?? []),
    ...(input.snapshot?.visibleText ?? []).filter(
      (part) => !ignoredSearchMetadata.has(normalizeText(part)),
    ),
    ...elementContext,
    ...selectedMutationSurfaceParts(input),
  ]
    .filter(Boolean)
    .map((part) => normalizeText(part))
    .join(" ");
  if (hasAnyTerm(visibleContext, AUTHENTICATION_ACT_CONTEXT_TERMS)) {
    return true;
  }

  return /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i.test(
    visibleContext,
  );
}

function selectedMutationSurfaceParts(input: GuiPolicyInput): string[] {
  return [
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    input.element?.description,
    input.element?.value,
    input.secondaryAction,
  ]
    .map(normalizeText)
    .filter(Boolean);
}

function isSafeAccountChooserSelection(input: GuiPolicyInput): boolean {
  if (input.actionType !== "click" && input.actionType !== "secondaryAction") {
    return false;
  }

  const visibleContext = visibleContextText(input);
  if (!/\b(?:choose|select|pick) an account\b|\baccount chooser\b/.test(visibleContext)) {
    return false;
  }

  const role = normalizeText(input.element?.role);
  const selectedSurface = selectedMutationSurfaceText(input);

  // A signed-out row is navigation to a later credential gate, not a credential
  // itself. Require explicit signed-out state (or the non-auth "Use another
  // account" option): an email address alone may represent an active session
  // whose selection would complete sign-in immediately.
  return (
    /\b(button|row|cell|link|list item)\b/.test(role) &&
    /\b(?:signed out|use another account)\b/.test(selectedSurface) &&
    !hasAnyTerm(selectedSurface, AUTHENTICATION_BOUNDARY_TERMS)
  );
}

function isReversibleAuthenticationEntry(input: GuiPolicyInput): boolean {
  if (input.actionType !== "click" && input.actionType !== "secondaryAction") {
    return false;
  }

  // Specialized profiles intentionally narrow the default capability. For
  // example, the web dry-run profile must still stop at every login boundary.
  // This parity rule applies only to Jarvis's founder-local trusted GUI mode.
  const taskPolicyId = input.taskPolicy?.taskId ?? DEFAULT_GUI_TASK_POLICY.taskId;
  if (taskPolicyId !== "trusted_local_gui_control") {
    return false;
  }

  // This is a proven native App Store handoff: the button opens Apple's
  // authentication sheet before redemption. Do not generalize from the label
  // alone because a browser or SSO Sign In control can complete authentication
  // immediately when an existing session is present.
  if (
    normalizeText(input.target.appName) !== "app store" ||
    normalizeText(input.snapshot?.appName) !== "app store" ||
    !/\btap continue and sign in to redeem code\b/.test(visibleContextText(input))
  ) {
    return false;
  }

  const role = normalizeText(input.element?.role);
  if (!/\b(button|link|menu item|row|cell)\b/.test(role)) {
    return false;
  }

  const selectedParts = selectedMutationSurfaceParts(input);
  // OCU's structured snapshots separate role and label, while its supported
  // text-dump parser can expose the combined string "button Sign In" in both
  // fields. Accept only that bounded role prefix plus the exact action label.
  const opensAuthentication = selectedParts.some((part) =>
    /^(?:(?:button|link|menu item|row|cell)\s+)?(?:sign in|sign-in|log in|login)$/.test(part),
  );
  if (!opensAuthentication) {
    return false;
  }

  // Even inside the known prompt, fail closed if accessibility exposes an
  // actual password, passkey, OTP, secure field, or approval challenge.
  return !hasAuthenticationActContext(input);
}

function isReversiblePreAuthNavigation(input: GuiPolicyInput): boolean {
  if (input.actionType !== "click" && input.actionType !== "secondaryAction") {
    return false;
  }

  const selectedParts = selectedMutationSurfaceParts(input);

  // These controls change only which challenge is shown, or dismiss it. Match
  // complete accessibility fields rather than substrings so "Close account"
  // can never borrow the safe semantics of a plain "Close" button.
  if (
    selectedParts.some((part) =>
      ["close", "cancel", "back", "go back", "try another way"].includes(part),
    )
  ) {
    return true;
  }

  return isSafeAccountChooserSelection(input) || isReversibleAuthenticationEntry(input);
}

function isAuthenticationBoundaryTerm(term: string): boolean {
  return AUTHENTICATION_BOUNDARY_TERMS.includes(normalizeText(term));
}

function hasNonAuthenticationBoundaryTerm(haystack: string, deniedTerms: string[]): boolean {
  return deniedTerms.some(
    (term) => !isAuthenticationBoundaryTerm(term) && surfaceTermPattern(term).test(haystack),
  );
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
    input.secondaryAction,
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

function redactApprovalDisplayText(value: string | undefined): string {
  return normalizeText(value)
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]")
    .replace(/\b(?:[a-z0-9_-]{24,})\b/gi, "[token]")
    .replace(/\b\d{4,}\b/g, "[number]");
}

function nonEditableApprovalValue(input: GuiPolicyInput): string {
  if (input.actionType === "setValue") {
    return "";
  }
  const role = normalizeText(input.element?.role);
  if (!/\b(button|checkbox|radio|menu item|row|cell|link|static text)\b/.test(role)) {
    return "";
  }
  return normalizeText(input.element?.value);
}

function extractApprovalFact(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  if (
    /^(?:merchant|seller|vendor|item|product|route|flight|passenger|traveler|shipping(?: address)?|delivery(?: address)?|payment method|card|source|publisher|developer|version|total|price|amount|quantity|order|booking)\b(?:\s*[:#=-]\s*|\s+).+/.test(
      normalized,
    ) ||
    /\b(?:visa|mastercard|amex|american express|discover)\b.*\bending\s+\d{2,}\b/.test(normalized)
  ) {
    return normalized;
  }
  return "";
}

function createGuiApprovalScope(
  input: GuiPolicyInput,
  taskPolicy: GuiTaskPolicy,
): GuiApprovalScope {
  // Bind approval to both the selected control and the risk classes visible in
  // its current window. A stale ref may keep the same identifier while a page
  // changes from "Sign In" to "Pay Now"; the changed risk set must invalidate
  // the old approval before any retry.
  const context = [
    sensitiveSurfaceText(input, taskPolicy.deniedSurfaceTerms),
    preAuthHardStopContextText(input),
    commerceHardStopContextText(input),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  const sensitiveTerms = [
    ...new Set([
      ...taskPolicy.deniedSurfaceTerms,
      ...TRUSTED_LOCAL_GUI_HARD_STOP_TERMS,
      ...COMMERCE_HARD_STOP_CONTEXT_TERMS,
    ]),
  ]
    .filter((term) => surfaceTermPattern(term).test(context))
    .map(normalizeText)
    .toSorted();
  const observedDetailParts = [
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    input.snapshot?.summary,
    ...(input.snapshot?.visibleText ?? []),
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    input.element?.description,
    nonEditableApprovalValue(input),
    input.secondaryAction,
  ]
    .map(normalizeText)
    .filter(Boolean);
  const approvalDetailContext = observedDetailParts.join(" ");
  const visibleTransactionDetails = [
    // Currency amounts and version identifiers are material approval facts but
    // are not credentials. Bind them without retaining arbitrary visible text,
    // passwords, OTPs, account identifiers, or field values.
    ...approvalDetailContext.matchAll(
      /(?:[$€£¥₹]\s?\d[\d,.]*|\b(?:usd|eur|gbp|jpy|inr|idr|aed|cad|aud)\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:usd|eur|gbp|jpy|inr|idr|aed|cad|aud)\b)/gi,
    ),
    ...approvalDetailContext.matchAll(
      /\b(?:version|ver\.?|v)\s*\d+(?:\.\d+){1,4}(?:[-+][a-z0-9.-]+)?\b/gi,
    ),
  ]
    .map((match) => normalizeText(match[0]))
    .filter(Boolean)
    .toSorted();
  const stableVisibleFacts = [
    input.snapshot?.summary,
    ...(input.snapshot?.visibleText ?? []),
    nonEditableApprovalValue(input),
  ]
    .map(extractApprovalFact)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);
  const stableIdentityContext = [
    input.snapshot?.appName,
    input.snapshot?.windowTitle,
    input.snapshot?.windowId,
    input.element?.role,
    input.element?.name,
    input.element?.title,
    input.element?.label,
    nonEditableApprovalValue(input),
    input.secondaryAction,
    ...(input.actionType === "setValue" ? [input.element?.description, input.element?.value] : []),
    ...visibleTransactionDetails,
    ...stableVisibleFacts,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  const visibleContextFingerprint = createHmac("sha256", GUI_APPROVAL_SCOPE_HMAC_KEY)
    .update(stableIdentityContext)
    .digest("hex");
  const withholdVisibleContext =
    sensitiveTerms.some((term) =>
      /password|passkey|otp|one-time password|verification code|token|secret|security code|cvv|cvc/.test(
        term,
      ),
    ) || input.actionType === "setValue";
  const visibleContextSummary = withholdVisibleContext
    ? []
    : stableVisibleFacts
        .map(redactApprovalDisplayText)
        .filter(Boolean)
        .map((value) => value.slice(0, 160));

  return {
    actionType: input.actionType,
    runtimeName: input.runtimeName ?? "unknown",
    appName: redactApprovalDisplayText(input.snapshot?.appName ?? input.target.appName),
    windowTitle: redactApprovalDisplayText(input.snapshot?.windowTitle ?? input.target.windowTitle),
    windowId: normalizeText(input.snapshot?.windowId ?? input.target.windowId),
    taskPolicyId: taskPolicy.taskId,
    selectedControl: [
      input.element?.role,
      input.element?.name,
      input.element?.title,
      input.element?.label,
      redactApprovalDisplayText(nonEditableApprovalValue(input)),
      input.secondaryAction,
    ]
      .map(redactApprovalDisplayText)
      .filter(Boolean),
    actionParameters: [
      ...(input.keys ?? []).map((key) => `key:${normalizeText(key)}`),
      ...(input.secondaryAction
        ? [`secondary-action:${normalizeText(input.secondaryAction)}`]
        : []),
      ...(input.scroll?.direction ? [`scroll-direction:${input.scroll.direction}`] : []),
      ...(input.scroll?.amount !== undefined ? [`scroll-amount:${input.scroll.amount}`] : []),
    ],
    visibleTransactionDetails: [...new Set(visibleTransactionDetails)],
    visibleContextSummary,
    visibleContextFingerprint,
    sensitiveTerms,
  };
}

export function guiApprovalScopesMatch(
  left: GuiApprovalScope | undefined,
  right: GuiApprovalScope | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
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

function isExplicitUserSuppliedDetailReason(reason: string): boolean {
  return /\b(explicitly supplied|user supplied|supplied by (the )?user|provided by (the )?user|user provided|given by (the )?user|from (the )?user)\b/.test(
    reason,
  );
}

function commerceDetailEntryRequiresExplicitSource(input: GuiPolicyInput): boolean {
  if (
    input.taskPolicy?.taskId !== "commerce_flow_until_final_confirmation" ||
    input.actionType !== "setValue"
  ) {
    return false;
  }

  const selectedSurface = selectedMutationSurfaceText(input);
  if (
    /\b(passenger|traveler|traveller)\b/.test(selectedSurface) &&
    /\b(count|number|quantity|adult|adults|child|children|infant|infants)\b/.test(selectedSurface)
  ) {
    return false;
  }

  const detailSurface = [selectedSurface, visibleContextText(input)]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");

  return Boolean(
    hasAnyTerm(detailSurface, [
      "passenger",
      "traveler",
      "traveller",
      "contact",
      "email",
      "email address",
      "phone",
      "phone number",
      "mobile",
      "mobile number",
      "address",
      "name",
      "given name",
      "first name",
      "last name",
      "full name",
      "surname",
      "date of birth",
      "birth date",
      "dob",
      "nationality",
      "passport",
    ]) && !isExplicitUserSuppliedDetailReason(normalizeText(input.reason)),
  );
}

function hasVisibleSoftwareUpdateInstallContext(input: GuiPolicyInput): boolean {
  if (
    input.taskPolicy?.taskId !== "software_update_install_approved" ||
    input.actionType === "observe"
  ) {
    return true;
  }

  // Explicit approval is not enough for the broad install-approved profile. The
  // visible target also has to look like an updater surface, otherwise a generic
  // "Install" button in another installer could inherit update privileges.
  return /\b(software update|update available|new version|install update|install updates|install and relaunch|install on quit|relaunch to update)\b/.test(
    visibleContextText(input),
  );
}

function allowedSoftwareUpdateControlReason(input: GuiPolicyInput): string | undefined {
  if (
    input.actionType === "observe" ||
    (input.taskPolicy?.taskId !== "software_update_flow" &&
      input.taskPolicy?.taskId !== "software_update_install_approved")
  ) {
    return undefined;
  }

  const selectedSurface = selectedMutationSurfaceText(input);
  if (input.taskPolicy.taskId === "software_update_flow") {
    return /\b(check for updates?|check updates?|release notes?|view release notes?|more info|details)\b/.test(
      selectedSurface,
    )
      ? undefined
      : "Software update discovery only allows check/update-info controls.";
  }

  return /\b(install|install update|install updates|install now|install on quit|install and relaunch|relaunch)\b/.test(
    selectedSurface,
  )
    ? undefined
    : "Approved software update install only allows install or relaunch controls.";
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

  // Sensitive surfaces are approval gates, not permanent capability bans. The
  // user owns this personal computer and may explicitly authorize the exact
  // action. Capability and post-state checks below still constrain what the
  // selected task profile and runtime can execute.
  const text = sensitiveSurfaceText(input, taskPolicy.deniedSurfaceTerms);
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
  if (
    blockedSurface &&
    isAuthenticationBoundaryTerm(blockedSurface) &&
    !hasNonAuthenticationBoundaryTerm(text, taskPolicy.deniedSurfaceTerms) &&
    // Scan broad visible context for mixed risks, excluding only a proven-safe
    // account chooser's unrelated management sibling.
    !hasNonAuthenticationBoundaryTerm(
      preAuthHardStopContextText(input),
      taskPolicy.deniedSurfaceTerms,
    ) &&
    isReversiblePreAuthNavigation(input)
  ) {
    // Window titles and challenge summaries provide the context needed to
    // block generic commit controls such as Next. They must not turn every
    // control in that window into authentication: chooser rows, method
    // discovery, and dismissal remain reversible until a credential is used.
    blockedSurface = undefined;
  }
  const approvalScope = createGuiApprovalScope(input, taskPolicy);
  let sensitiveApprovalReason =
    blockedSurface && input.actionType !== "observe"
      ? `Blocked sensitive GUI surface: ${blockedSurface}; explicit sensitive-action approval required.`
      : undefined;
  if (taskPolicy.taskId === "software_update_install_approved" && input.actionType !== "observe") {
    sensitiveApprovalReason ??=
      "Software update installation or relaunch requires explicit sensitive-action approval.";
  }

  if (commerceDetailEntryRequiresExplicitSource(input)) {
    return {
      allowed: false,
      risk: "blocked",
      reason:
        "Commerce detail entry requires the reason to state that the passenger, traveler, contact, or address detail was explicitly supplied by the user.",
      requiredCapability,
      taskPolicy,
    };
  }

  if (!hasVisibleSoftwareUpdateInstallContext(input)) {
    return {
      allowed: false,
      risk: "blocked",
      reason: "Approved software update install requires a visible software-update context.",
      requiredCapability,
      taskPolicy,
    };
  }

  const softwareUpdateControlBlock = allowedSoftwareUpdateControlReason(input);
  if (softwareUpdateControlBlock) {
    return {
      allowed: false,
      risk: "blocked",
      reason: softwareUpdateControlBlock,
      requiredCapability,
      taskPolicy,
    };
  }

  if (taskPolicy.taskId === "commerce_flow_until_final_confirmation") {
    const hardStopContextText = commerceHardStopContextText(input);
    let hardStopContext = hasAnyTerm(hardStopContextText, COMMERCE_HARD_STOP_CONTEXT_TERMS);
    if (
      hardStopContext &&
      isAuthenticationBoundaryTerm(hardStopContext) &&
      !hasNonAuthenticationBoundaryTerm(hardStopContextText, COMMERCE_HARD_STOP_CONTEXT_TERMS) &&
      isReversiblePreAuthNavigation(input)
    ) {
      hardStopContext = undefined;
    }
    if (hardStopContext) {
      sensitiveApprovalReason ??= `Blocked sensitive GUI context: ${hardStopContext}; explicit sensitive-action approval required.`;
    }
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

  // Ask only after every static capability, target, task-profile, and
  // verification check has passed. This prevents prompting the user for an
  // action that the same invocation could never execute.
  if (
    sensitiveApprovalReason &&
    !guiApprovalScopesMatch(input.approvedSensitiveScope, approvalScope)
  ) {
    return {
      allowed: false,
      risk: "blocked",
      reason: sensitiveApprovalReason,
      requiredCapability,
      taskPolicy,
      requiredSensitiveApproval: approvalScope,
    };
  }

  return {
    allowed: true,
    risk: "allowed-mutation",
    requiredCapability,
    taskPolicy,
    approvalScope,
  };
}
