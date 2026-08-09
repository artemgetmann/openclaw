export type JarvisDeliveryLayer =
  | "localConfiguration"
  | "source"
  | "packagedArtifact"
  | "installedRuntime"
  | "upgradeMigration"
  | "publicRelease"
  | "endUserBehavior";

export type JarvisLayerStatus = "not-applicable" | "pending" | "proven";

export type JarvisDeliveryReceipt = {
  schemaVersion: 1;
  workScope: "product-wide" | "artem-specific";
  deliveryTarget: "local-only" | "source" | "package" | "installed-runtime" | "public-release";
  completionClaim:
    | "in-progress"
    | "local-only-complete"
    | "declared-boundary-complete"
    | "consumer-delivered"
    | "blocked-at-boundary";
  upgradeImpact: "required" | "not-applicable";
  layers: Record<JarvisDeliveryLayer, { status: JarvisLayerStatus; evidence: string }>;
};

export type JarvisDeliveryValidation = {
  ok: boolean;
  errors: string[];
  requiredLayers: JarvisDeliveryLayer[];
  pendingRequiredLayers: JarvisDeliveryLayer[];
};

export const DELIVERY_LAYERS: readonly JarvisDeliveryLayer[];

export function validateJarvisDeliveryReceipt(
  receipt: unknown,
  options?: { stage?: "classification" | "handoff" | "closeout" },
): JarvisDeliveryValidation;

export function extractJarvisDeliveryReceipt(
  body: string,
): { ok: true; receipt: JarvisDeliveryReceipt } | { ok: false; errors: string[] };

export function jarvisDeliverySignals(input?: {
  title?: string;
  body?: string;
  changedPaths?: string[];
}): string[];

export function validateJarvisPullRequest(
  input: { title?: string; body?: string; changedPaths?: string[] },
  options?: { stage?: "classification" | "handoff" | "closeout" },
): {
  ok: boolean;
  errors: string[];
  required: boolean;
  signals: string[];
  receipt?: JarvisDeliveryReceipt;
  requiredLayers?: JarvisDeliveryLayer[];
  pendingRequiredLayers?: JarvisDeliveryLayer[];
};

export function exampleJarvisDeliveryReceipt(options?: {
  workScope?: JarvisDeliveryReceipt["workScope"];
  deliveryTarget?: JarvisDeliveryReceipt["deliveryTarget"];
}): JarvisDeliveryReceipt;
