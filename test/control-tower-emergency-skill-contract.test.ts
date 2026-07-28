import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillRoot = path.join(process.cwd(), ".agents", "skills", "codex-control-tower-emergency");
const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
const normalizedSkill = skill.replace(/\s+/g, " ");
const validator = fs.readFileSync(path.join(skillRoot, "scripts", "validate_dashboard.py"), "utf8");

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
      expect(fs.existsSync(path.join(skillRoot, "scripts", helper))).toBe(true);
    }
  });
});
