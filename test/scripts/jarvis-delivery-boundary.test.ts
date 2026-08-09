import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_LAYERS,
  extractJarvisDeliveryReceipt,
  validateJarvisDeliveryReceipt,
  validateJarvisPullRequest,
} from "../../scripts/lib/jarvis-delivery-boundary.mjs";

const ROOT = process.cwd();
const CLI = path.join(ROOT, "scripts", "jarvis-delivery-boundary.mjs");

type LayerStatus = "not-applicable" | "pending" | "proven";

function receipt(overrides: Record<string, unknown> = {}) {
  const layers = Object.fromEntries(
    DELIVERY_LAYERS.map((layer) => [
      layer,
      { status: "pending" as LayerStatus, evidence: `${layer} remains pending` },
    ]),
  );
  layers.localConfiguration = {
    status: "not-applicable",
    evidence: "No personal-home mutation is part of this product task.",
  };
  layers.upgradeMigration = {
    status: "not-applicable",
    evidence: "The change does not alter persisted user state.",
  };

  return {
    schemaVersion: 1,
    workScope: "product-wide",
    deliveryTarget: "public-release",
    completionClaim: "in-progress",
    upgradeImpact: "not-applicable",
    layers,
    ...overrides,
  };
}

function block(value: unknown) {
  return `<!-- jarvis-delivery-boundary:start -->
\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\`
<!-- jarvis-delivery-boundary:end -->`;
}

describe("Jarvis delivery boundary", () => {
  it("allows a personal customization to close only as local-only", () => {
    const local = receipt({
      workScope: "artem-specific",
      deliveryTarget: "local-only",
      completionClaim: "local-only-complete",
      layers: {
        ...receipt().layers,
        localConfiguration: {
          status: "proven",
          evidence: "The named local configuration was inspected in the personal home.",
        },
      },
    });

    expect(validateJarvisDeliveryReceipt(local, { stage: "closeout" })).toMatchObject({
      ok: true,
      requiredLayers: ["localConfiguration"],
      pendingRequiredLayers: [],
    });

    const inflated = { ...local, completionClaim: "consumer-delivered" };
    expect(validateJarvisDeliveryReceipt(inflated, { stage: "closeout" })).toMatchObject({
      ok: false,
    });
  });

  it("accepts reversible product source work without approval receipts", () => {
    const sourceOnly = receipt({
      deliveryTarget: "source",
      completionClaim: "declared-boundary-complete",
      layers: {
        ...receipt().layers,
        source: {
          status: "proven",
          evidence: "Exact candidate head passed focused contract tests.",
        },
      },
    });

    expect(validateJarvisDeliveryReceipt(sourceOnly, { stage: "handoff" })).toMatchObject({
      ok: true,
      requiredLayers: ["source"],
      pendingRequiredLayers: [],
    });
  });

  it("requires migration proof at the declared boundary when upgrades are affected", () => {
    const upgradeSource = receipt({
      deliveryTarget: "source",
      completionClaim: "declared-boundary-complete",
      upgradeImpact: "required",
      layers: {
        ...receipt().layers,
        source: {
          status: "proven",
          evidence: "Exact candidate source passed focused tests.",
        },
        upgradeMigration: {
          status: "pending",
          evidence: "Existing-user migration proof remains pending.",
        },
      },
    });

    const rejected = validateJarvisDeliveryReceipt(upgradeSource, { stage: "handoff" });
    expect(rejected.ok).toBe(false);
    expect(rejected.pendingRequiredLayers).toEqual(["upgradeMigration"]);

    upgradeSource.layers.upgradeMigration = {
      status: "proven",
      evidence: "Upgrade fixture preserved existing-user state.",
    };
    expect(validateJarvisDeliveryReceipt(upgradeSource, { stage: "handoff" })).toMatchObject({
      ok: true,
      pendingRequiredLayers: [],
    });
  });

  it("rejects a consumer-delivered claim backed only by source proof", () => {
    const inflated = receipt({
      completionClaim: "consumer-delivered",
      layers: {
        ...receipt().layers,
        source: {
          status: "proven",
          evidence: "Exact candidate head passed focused contract tests.",
        },
      },
    });

    const result = validateJarvisDeliveryReceipt(inflated, { stage: "closeout" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("consumer-delivered is missing proven receipts");
    expect(result.pendingRequiredLayers).toEqual([
      "packagedArtifact",
      "installedRuntime",
      "publicRelease",
      "endUserBehavior",
    ]);
  });

  it("rejects declared-boundary-complete as a local-only closeout alias", () => {
    const local = receipt({
      workScope: "artem-specific",
      deliveryTarget: "local-only",
      completionClaim: "declared-boundary-complete",
    });
    local.layers.localConfiguration = {
      status: "proven",
      evidence: "A bounded personal configuration check passed.",
    };

    const result = validateJarvisDeliveryReceipt(local, { stage: "closeout" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "local-only work must close with completionClaim=local-only-complete",
    );
  });

  it("accepts complete consumer proof including a required upgrade migration", () => {
    const allProductProof = Object.fromEntries(
      DELIVERY_LAYERS.map((layer) => [
        layer,
        {
          status: layer === "localConfiguration" ? "not-applicable" : "proven",
          evidence:
            layer === "localConfiguration"
              ? "No personal-home mutation was used."
              : `${layer} receipt is attached and bound to the release candidate.`,
        },
      ]),
    );
    const delivered = receipt({
      completionClaim: "consumer-delivered",
      upgradeImpact: "required",
      layers: allProductProof,
    });

    expect(validateJarvisDeliveryReceipt(delivered, { stage: "closeout" })).toMatchObject({
      ok: true,
      pendingRequiredLayers: [],
    });
  });

  it("reports the remaining product boundary without pretending completion", () => {
    const blocked = receipt({
      completionClaim: "blocked-at-boundary",
      upgradeImpact: "required",
      layers: {
        ...receipt().layers,
        source: {
          status: "proven",
          evidence: "Exact candidate head passed focused contract tests.",
        },
        upgradeMigration: {
          status: "pending",
          evidence: "Disposable upgraded-user adoption still needs package proof.",
        },
      },
    });

    expect(validateJarvisDeliveryReceipt(blocked, { stage: "handoff" })).toMatchObject({
      ok: true,
      pendingRequiredLayers: [
        "packagedArtifact",
        "installedRuntime",
        "publicRelease",
        "endUserBehavior",
        "upgradeMigration",
      ],
    });
  });

  it("requires a receipt for Jarvis-named PRs and direct product paths", () => {
    const missing = validateJarvisPullRequest({
      title: "fix(jarvis): preserve behavior",
      body: "Observable claim + acceptance criteria: behavior is preserved",
      changedPaths: ["src/agents/system-prompt.ts"],
    });
    expect(missing).toMatchObject({ ok: false, required: true });

    const classified = receipt();
    expect(
      validateJarvisPullRequest({
        title: "fix(mac): preserve behavior",
        body: block(classified),
        changedPaths: ["apps/macos/Sources/Jarvis/App.swift"],
      }),
    ).toMatchObject({ ok: true, required: true });
  });

  it("detects Jarvis in the claim while ignoring the template heading itself", () => {
    expect(
      validateJarvisPullRequest({
        title: "fix(agent): preserve behavior",
        body: "Observable claim + acceptance criteria: Jarvis preserves reminders",
        changedPaths: ["src/agents/system-prompt.ts"],
      }),
    ).toMatchObject({ ok: false, required: true });

    expect(
      validateJarvisPullRequest({
        title: "fix(agent): preserve behavior",
        body: "Observable claim + acceptance criteria: reminders are preserved\n\n## Jarvis Delivery Boundary\nNot required",
        changedPaths: ["src/agents/system-prompt.ts"],
      }),
    ).toMatchObject({ ok: true, required: false });
  });

  it.each([
    "src/consumer/setup.ts",
    "skills/consumer-setup/SKILL.md",
    "docs/consumer/project-status.md",
    "scripts/consumer-preflight.sh",
    "src/agents/consumer-default-bundled-skills.ts",
    "scripts/check-consumer-config.sh",
    "src/agents/default-consumer.ts",
  ])("requires classification for direct consumer product path %s", (changedPath) => {
    expect(
      validateJarvisPullRequest({
        title: "fix(product): preserve behavior",
        body: "Observable claim + acceptance criteria: existing users retain configured behavior",
        changedPaths: [changedPath],
      }),
    ).toMatchObject({ ok: false, required: true });
  });

  it("ignores engine-only PRs and rejects duplicate receipt blocks", () => {
    expect(
      validateJarvisPullRequest({
        title: "fix(gateway): preserve behavior",
        body: "No consumer product change",
        changedPaths: ["src/gateway/server.ts"],
      }),
    ).toMatchObject({ ok: true, required: false });

    expect(extractJarvisDeliveryReceipt(`${block(receipt())}\n${block(receipt())}`)).toMatchObject({
      ok: false,
    });
  });

  it("validates the GitHub event and changed-path files used by CI", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-delivery-boundary-"));
    const eventPath = path.join(root, "event.json");
    const pathsPath = path.join(root, "paths.txt");
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          title: "fix(jarvis): classify delivery",
          body: block(receipt()),
        },
      }),
    );
    fs.writeFileSync(pathsPath, "src/agents/system-prompt.ts\n");

    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          CLI,
          "validate-pr",
          "--event",
          eventPath,
          "--changed-paths",
          pathsPath,
          "--stage",
          "classification",
        ],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );
    expect(result).toMatchObject({ ok: true, required: true });
  });
});
