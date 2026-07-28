import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillRoot = path.join(process.cwd(), ".agents", "skills", "codex-control-tower-emergency");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
const normalizedSkill = skill.replace(/\s+/g, " ");
const validator = fs.readFileSync(path.join(skillRoot, "scripts", "validate_dashboard.py"), "utf8");
const validatorPath = path.join(skillRoot, "scripts", "validate_dashboard.py");
const pythonHasYaml =
  spawnSync("python3", ["-B", "-c", "import yaml"], { encoding: "utf8" }).status === 0;

function dashboardFixture(): Record<string, unknown> {
  return {
    epoch: {
      started_at: new Date().toISOString(),
      lifecycle_state: "healthy-idle",
      wake_mode: "manual-pull",
      wake_driver_status: "complete",
      goal_state: "absent",
      capacity_retry_count: 0,
      capacity_retry_limit: 3,
      reconciliation_due: false,
      next_reconcile_by: null,
      alert_required: false,
      context_compactions: 0,
      terminal_lane_transitions: 0,
      elapsed_hours: 0,
      transcript_bytes: 0,
      rotation_due: false,
      rotation_reasons: [],
      rotate_at: {
        context_compactions: 10,
        terminal_lane_transitions: 10,
        elapsed_hours: 24,
        transcript_bytes: 8 * 1024 * 1024,
      },
      rotation_status: "healthy",
    },
    campaign: {
      active_worker_count: 0,
      parked_lane_count: 0,
      open_lane_count: 0,
      target_active_workers: 5,
      parallelism_gap: 5,
      max_active_workers: 8,
      max_open_lanes: 20,
      intake_state: "open",
    },
    heavy: { owner_lane_id: null, state: "free" },
    lanes: [],
  };
}

function validateText(contents: string) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tower-dashboard-contract-"));
  const dashboardPath = path.join(tempRoot, "dashboard.yaml");
  try {
    fs.writeFileSync(dashboardPath, contents, "utf8");
    return spawnSync("python3", ["-B", validatorPath, dashboardPath], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateFixture(document: Record<string, unknown>) {
  return validateText(JSON.stringify(document));
}

describe("emergency Control Tower skill contract", () => {
  it("cannot trigger or self-elect during ordinary repository work", () => {
    expect(skill).toContain("name: codex-control-tower-emergency");
    expect(skill).toContain("EMERGENCY ONLY");
    expect(skill).toContain("user explicitly invokes 'Control Tower'");
    expect(skill).toContain("Never self-elect");
    expect(normalizedSkill).toContain("ordinary implementation");
    expect(normalizedSkill).toContain("many worktrees");
    expect(normalizedSkill).toContain("do not declare a fleet incident by themselves");
    expect(skill).toContain("never:");
    expect(skill).toContain("create or adopt a dashboard");
    expect(skill).toContain("admit, reroute, pause, resume, or schedule workers");
  });

  it("preserves bounded incident handoff, validation, drain, and receipt mechanics", () => {
    expect(skill).toContain("scripts/validate_dashboard.py");
    expect(skill).toContain("append-only archive");
    expect(skill).toContain("## Separate incidents");
    expect(skill).toContain("## Rotate manually");
    expect(skill).toContain("rotation_status: draining");
    expect(skill).toContain("elapsed_hours: 24");
    expect(skill).toContain("rotation_due: false");
    expect(skill).toContain("rotation_reasons: []");
    expect(validator).toContain(
      'errors.append("epoch.rotation_due must match the measured rotation thresholds")',
    );
    expect(validator).toContain(
      'errors.append("epoch.rotation_reasons must match the measured thresholds")',
    );
    expect(skill).toContain("Archive the predecessor only after takeover verification");

    for (const helper of ["measure_epoch.py", "record_event.py", "validate_dashboard.py"]) {
      const helperPath = path.join(skillRoot, "scripts", helper);
      expect(fs.existsSync(helperPath)).toBe(true);
      expect(fs.statSync(helperPath).mode & 0o111).not.toBe(0);
    }
  });

  it.runIf(pythonHasYaml)("accepts YAML timestamps and rejects duplicate keys", () => {
    const baseline = dashboardFixture();
    const startedAt = (baseline.epoch as Record<string, unknown>).started_at as string;
    const yamlTimestamp = JSON.stringify(baseline, null, 2).replace(
      JSON.stringify(startedAt),
      startedAt,
    );
    expect(validateText(yamlTimestamp).status).toBe(0);

    const duplicateWakeMode = JSON.stringify(baseline).replace(
      '"wake_mode":"manual-pull"',
      '"wake_mode":"manual-pull","wake_mode":"finite-goal"',
    );
    const duplicateResult = validateText(duplicateWakeMode);
    expect(duplicateResult.status).toBe(2);
    expect(duplicateResult.stderr).toContain("found duplicate key (wake_mode)");
  });

  it.runIf(pythonHasYaml)("fails closed for stale time receipts and disabled thresholds", () => {
    const baseline = dashboardFixture();
    expect(validateFixture(baseline).status).toBe(0);

    const stale = structuredClone(baseline);
    const staleEpoch = stale.epoch as Record<string, unknown>;
    staleEpoch.started_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const staleResult = validateFixture(stale);
    expect(staleResult.status).toBe(1);
    expect(staleResult.stderr).toContain(
      "epoch.elapsed_hours is stale relative to epoch.started_at",
    );
    expect(staleResult.stderr).toContain(
      "reached rotation threshold requires epoch.rotation_status=draining",
    );

    const disabled = dashboardFixture();
    const disabledEpoch = disabled.epoch as Record<string, unknown>;
    disabledEpoch.rotate_at = {
      context_compactions: 0,
      terminal_lane_transitions: 0,
      elapsed_hours: 0,
      transcript_bytes: 0,
    };
    const disabledResult = validateFixture(disabled);
    expect(disabledResult.status).toBe(1);
    expect(disabledResult.stderr).toContain("epoch.rotate_at.context_compactions must be positive");
    expect(disabledResult.stderr).toContain("epoch.rotate_at.elapsed_hours must be positive");
  });

  it.runIf(pythonHasYaml)("accepts a correctly draining elapsed-time rotation", () => {
    const draining = dashboardFixture();
    const drainingEpoch = draining.epoch as Record<string, unknown>;
    drainingEpoch.started_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    drainingEpoch.elapsed_hours = 25;
    drainingEpoch.rotation_due = true;
    drainingEpoch.rotation_reasons = ["elapsed_hours"];
    drainingEpoch.rotation_status = "draining";
    drainingEpoch.lifecycle_state = "draining";
    (draining.campaign as Record<string, unknown>).intake_state = "frozen";

    expect(validateFixture(draining).status).toBe(0);
  });
});
