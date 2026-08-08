const SCHEMA_VERSION = 1;

export const DELIVERY_LAYERS = Object.freeze([
  "localConfiguration",
  "source",
  "packagedArtifact",
  "installedRuntime",
  "upgradeMigration",
  "publicRelease",
  "endUserBehavior",
]);

const WORK_SCOPES = new Set(["product-wide", "artem-specific"]);
const DELIVERY_TARGETS = new Set([
  "local-only",
  "source",
  "package",
  "installed-runtime",
  "public-release",
]);
const COMPLETION_CLAIMS = new Set([
  "in-progress",
  "local-only-complete",
  "declared-boundary-complete",
  "consumer-delivered",
  "blocked-at-boundary",
]);
const UPGRADE_IMPACTS = new Set(["required", "not-applicable"]);
const LAYER_STATUSES = new Set(["not-applicable", "pending", "proven"]);
const VALIDATION_STAGES = new Set(["classification", "handoff", "closeout"]);
const PERSONAL_PROOF_LAYERS = new Set(["localConfiguration", "installedRuntime"]);
const ARTEM_DELIVERY_TARGETS = new Set(["local-only", "installed-runtime"]);

const PRODUCT_TARGET_LAYERS = Object.freeze({
  source: ["source"],
  package: ["source", "packagedArtifact"],
  "installed-runtime": ["source", "packagedArtifact", "installedRuntime"],
  "public-release": [
    "source",
    "packagedArtifact",
    "installedRuntime",
    "publicRelease",
    "endUserBehavior",
  ],
});

const RECEIPT_BLOCK =
  /<!--\s*jarvis-delivery-boundary:start\s*-->\s*```json\s*([\s\S]*?)\s*```\s*<!--\s*jarvis-delivery-boundary:end\s*-->/gi;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEnum(errors, value, allowed, field) {
  if (!allowed.has(value)) {
    errors.push(`${field} must be one of: ${[...allowed].join(", ")}`);
  }
}

function requiredLayersFor(receipt) {
  if (receipt.workScope === "artem-specific") {
    if (receipt.deliveryTarget === "local-only") {
      return ["localConfiguration"];
    }
    if (receipt.deliveryTarget === "installed-runtime") {
      // Personal customizations can be adopted directly by the app-owned
      // runtime. Source and package proof remain optional unless that route was
      // actually used, so the receipt must describe them without inventing it.
      return ["installedRuntime"];
    }
    return [];
  }

  const required = [...(PRODUCT_TARGET_LAYERS[receipt.deliveryTarget] ?? [])];
  if (receipt.upgradeImpact === "required") {
    required.push("upgradeMigration");
  }
  return required;
}

function layerStatus(receipt, layer) {
  return receipt.layers?.[layer]?.status;
}

function validateLayer(errors, receipt, layer) {
  const value = receipt.layers?.[layer];
  if (!isPlainObject(value)) {
    errors.push(`layers.${layer} must be an object`);
    return;
  }
  validateEnum(errors, value.status, LAYER_STATUSES, `layers.${layer}.status`);
  if (typeof value.evidence !== "string" || value.evidence.trim() === "") {
    errors.push(
      `layers.${layer}.evidence must explain the proof, pending boundary, or not-applicable rationale`,
    );
  }
}

/**
 * Validate one delivery receipt at the requested lifecycle stage.
 *
 * Classification is intentionally approval-free: it records intent before
 * reversible source work starts. Handoff adds exact-source and truthful-claim
 * requirements. Closeout uses the same truth rules so a blocked public or live
 * boundary can be reported without being mislabeled as consumer delivery.
 */
export function validateJarvisDeliveryReceipt(receipt, { stage = "classification" } = {}) {
  const errors = [];
  validateEnum(errors, stage, VALIDATION_STAGES, "stage");
  if (!isPlainObject(receipt)) {
    return {
      ok: false,
      errors: ["receipt must be a JSON object"],
      requiredLayers: [],
      pendingRequiredLayers: [],
    };
  }

  if (receipt.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  validateEnum(errors, receipt.workScope, WORK_SCOPES, "workScope");
  validateEnum(errors, receipt.deliveryTarget, DELIVERY_TARGETS, "deliveryTarget");
  validateEnum(errors, receipt.completionClaim, COMPLETION_CLAIMS, "completionClaim");
  validateEnum(errors, receipt.upgradeImpact, UPGRADE_IMPACTS, "upgradeImpact");

  if (!isPlainObject(receipt.layers)) {
    errors.push("layers must be an object");
  }
  for (const layer of DELIVERY_LAYERS) {
    validateLayer(errors, receipt, layer);
  }

  if (receipt.workScope === "product-wide" && receipt.deliveryTarget === "local-only") {
    errors.push("product-wide work cannot use deliveryTarget=local-only");
  }
  if (
    receipt.workScope === "artem-specific" &&
    !ARTEM_DELIVERY_TARGETS.has(receipt.deliveryTarget)
  ) {
    errors.push(
      "artem-specific work must target local-only or installed-runtime; public product boundaries require workScope=product-wide",
    );
  }
  if (receipt.workScope === "product-wide" && receipt.completionClaim === "local-only-complete") {
    errors.push("product-wide work cannot claim local-only completion");
  }
  if (receipt.workScope === "artem-specific" && receipt.completionClaim === "consumer-delivered") {
    errors.push("artem-specific proof cannot claim consumer delivery");
  }

  if (receipt.upgradeImpact === "not-applicable") {
    if (layerStatus(receipt, "upgradeMigration") !== "not-applicable") {
      errors.push(
        "upgradeImpact=not-applicable requires layers.upgradeMigration.status=not-applicable",
      );
    }
  } else if (layerStatus(receipt, "upgradeMigration") === "not-applicable") {
    errors.push("upgradeImpact=required cannot mark upgradeMigration not-applicable");
  }

  const requiredLayers = requiredLayersFor(receipt);
  for (const layer of requiredLayers) {
    if (layerStatus(receipt, layer) === "not-applicable") {
      errors.push(`${layer} is required for deliveryTarget=${receipt.deliveryTarget}`);
    }
  }

  const pendingRequiredLayers = requiredLayers.filter(
    (layer) => layerStatus(receipt, layer) !== "proven",
  );
  const allRequiredProven = pendingRequiredLayers.length === 0;

  if (receipt.completionClaim === "local-only-complete") {
    if (receipt.workScope !== "artem-specific" || receipt.deliveryTarget !== "local-only") {
      errors.push(
        "local-only-complete requires workScope=artem-specific and deliveryTarget=local-only",
      );
    }
    if (!allRequiredProven) {
      errors.push("local-only-complete requires proven localConfiguration evidence");
    }
  }

  if (receipt.completionClaim === "declared-boundary-complete" && !allRequiredProven) {
    errors.push(
      `declared-boundary-complete is missing proven receipts: ${pendingRequiredLayers.join(", ")}`,
    );
  }

  if (receipt.completionClaim === "consumer-delivered") {
    if (receipt.workScope !== "product-wide" || receipt.deliveryTarget !== "public-release") {
      errors.push(
        "consumer-delivered requires workScope=product-wide and deliveryTarget=public-release",
      );
    }
    if (!allRequiredProven) {
      errors.push(
        `consumer-delivered is missing proven receipts: ${pendingRequiredLayers.join(", ")}`,
      );
    }
  }

  if (receipt.completionClaim === "blocked-at-boundary" && allRequiredProven) {
    errors.push("blocked-at-boundary requires at least one pending required proof layer");
  }

  if (stage !== "classification") {
    if (receipt.completionClaim === "in-progress") {
      errors.push(`${stage} receipts cannot use completionClaim=in-progress`);
    }
    if (receipt.workScope === "product-wide" && layerStatus(receipt, "source") !== "proven") {
      errors.push(`${stage} requires proven source evidence for product-wide work`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    requiredLayers,
    pendingRequiredLayers,
  };
}

export function extractJarvisDeliveryReceipt(body) {
  RECEIPT_BLOCK.lastIndex = 0;
  const matches = [...String(body ?? "").matchAll(RECEIPT_BLOCK)];
  if (matches.length === 0) {
    return { ok: false, errors: ["missing Jarvis delivery boundary receipt block"] };
  }
  if (matches.length > 1) {
    return { ok: false, errors: ["PR body must contain exactly one Jarvis delivery receipt"] };
  }
  try {
    return { ok: true, receipt: JSON.parse(matches[0][1]) };
  } catch (error) {
    return {
      ok: false,
      errors: [`Jarvis delivery receipt is not valid JSON: ${error.message}`],
    };
  }
}

/**
 * Keep detection deliberately narrow and inspectable. A Jarvis-named PR or a
 * direct consumer-app/product path must classify its delivery surface. Generic
 * engine changes do not inherit paperwork merely because Jarvis uses OpenClaw.
 */
export function jarvisDeliverySignals({ title = "", body = "", changedPaths = [] } = {}) {
  const signals = [];
  if (/\bjarvis\b/i.test(title)) {
    signals.push("PR title names Jarvis");
  }
  // Ignore the template's own Jarvis section while inspecting the actual claim
  // surface. Summary and acceptance text before that heading still trigger the
  // contract even when an agent gives the PR a generic engine-oriented title.
  const boundaryHeading = String(body).search(/^## Jarvis Delivery Boundary\s*$/im);
  const claimSurface = boundaryHeading >= 0 ? body.slice(0, boundaryHeading) : body;
  if (/\bjarvis\b/i.test(claimSurface)) {
    signals.push("PR summary or acceptance names Jarvis");
  }
  for (const filePath of changedPaths) {
    // Consumer-named files and directories are product-owned even when the PR
    // deliberately avoids the word "Jarvis". Keep the pattern segment-bound
    // so unrelated words such as "consumerism" do not create paperwork.
    if (
      filePath === "CONSUMER.md" ||
      filePath.startsWith("apps/macos/") ||
      filePath.startsWith("docs/jarvis/") ||
      /(^|\/)consumer(?:[-./]|$)/i.test(filePath) ||
      /(^|\/)jarvis[^/]*($|\/|\.)/i.test(filePath)
    ) {
      signals.push(`Jarvis product path: ${filePath}`);
    }
  }
  return [...new Set(signals)];
}

export function validateJarvisPullRequest(
  { title = "", body = "", changedPaths = [] },
  { stage = "classification" } = {},
) {
  const signals = jarvisDeliverySignals({ title, body, changedPaths });
  if (signals.length === 0) {
    return { ok: true, required: false, signals, errors: [] };
  }

  const extracted = extractJarvisDeliveryReceipt(body);
  if (!extracted.ok) {
    return {
      ok: false,
      required: true,
      signals,
      errors: extracted.errors,
      requiredLayers: [],
      pendingRequiredLayers: [],
    };
  }
  const validation = validateJarvisDeliveryReceipt(extracted.receipt, { stage });
  return { ...validation, required: true, signals, receipt: extracted.receipt };
}

function exampleLayer(layer, personalOnly) {
  // Generated receipts start honest and incomplete. Product examples exclude
  // personal-home proof; personal examples exclude product shipment proof.
  // The operator replaces only the pending entries that the task can prove.
  if (layer === "upgradeMigration") {
    return {
      status: "not-applicable",
      evidence: "Explain why existing-user state is unaffected.",
    };
  }
  if (layer === "localConfiguration" && !personalOnly) {
    return {
      status: "not-applicable",
      evidence: "No personal-home mutation is part of this product task.",
    };
  }
  if (personalOnly && !PERSONAL_PROOF_LAYERS.has(layer)) {
    return {
      status: "not-applicable",
      evidence: "Local-only work does not prove this product boundary.",
    };
  }
  return {
    status: "pending",
    evidence: `Record ${layer} proof or the remaining boundary.`,
  };
}

export function exampleJarvisDeliveryReceipt({
  workScope = "product-wide",
  deliveryTarget = "public-release",
} = {}) {
  const personalOnly = workScope === "artem-specific";
  return {
    schemaVersion: SCHEMA_VERSION,
    workScope,
    deliveryTarget,
    completionClaim: "in-progress",
    upgradeImpact: "not-applicable",
    layers: Object.fromEntries(
      DELIVERY_LAYERS.map((layer) => [layer, exampleLayer(layer, personalOnly)]),
    ),
  };
}
