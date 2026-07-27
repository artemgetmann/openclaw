import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceSkillCommandSpecs,
  loadWorkspaceSkillEntries,
} from "../src/agents/skills.js";

const root = process.cwd();
const skillDir = path.join(root, "skills", "personal-tone-of-voice");
const canonicalSkill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const profileTemplate = fs.readFileSync(
  path.join(skillDir, "references", "profile-template.md"),
  "utf8",
);
const statusScript = path.join(skillDir, "scripts", "profile-status.mjs");

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-personal-tone-"));
}

function runStatus(workspace: string): {
  event: string;
  state: string;
  schemaVersion: number | null;
  reason: string;
} {
  return JSON.parse(
    execFileSync(process.execPath, [statusScript, "--workspace", workspace], {
      encoding: "utf8",
    }),
  );
}

describe("personal-tone-of-voice contract", () => {
  it("routes all common recipient-facing draft requests through one hidden capability", () => {
    for (const trigger of [
      "WhatsApp",
      "Telegram",
      "email",
      "SMS/iMessage",
      "outreach",
      "follow-up",
      "reply draft",
    ]) {
      expect(canonicalSkill).toContain(trigger);
    }
    expect(canonicalSkill).toContain("Use this alongside `message-drafting`");
    expect(canonicalSkill).toContain("user-invocable: false");

    const entries = loadWorkspaceSkillEntries(makeWorkspace(), {
      bundledSkillsDir: path.join(root, "skills"),
    });
    const entry = entries.find((candidate) => candidate.skill.name === "personal-tone-of-voice");
    expect(entry?.invocation?.userInvocable).toBe(false);
    expect(
      buildWorkspaceSkillCommandSpecs(makeWorkspace(), {
        entries: entry ? [entry] : [],
      }),
    ).not.toContainEqual(expect.objectContaining({ skillName: "personal-tone-of-voice" }));
  });

  it("uses explicit per-draft instructions before profiles and neutral fallback", () => {
    expect(canonicalSkill).toMatch(
      /explicit instruction for the current draft[\s\S]*context or channel rule[\s\S]*configured profile's default voice[\s\S]*neutral, clear drafting default/,
    );
    expect(canonicalSkill).toContain('"write in your own voice"');
    expect(canonicalSkill).toContain('"use Jarvis\'s voice"');
    expect(canonicalSkill).toContain('"ignore my saved style"');
    expect(canonicalSkill).toMatch(
      /Do not inspect, apply, or offer to configure the profile when\s+the user explicitly asks for Jarvis's own voice/,
    );
    expect(canonicalSkill).toContain("facts,");
    expect(canonicalSkill).toContain("approval requirements");
  });

  it("offers setup once without blocking or nagging", () => {
    expect(canonicalSkill).toMatch(
      /Complete the requested draft now[\s\S]*Offer once, briefly, after the draft/,
    );
    expect(canonicalSkill).toContain("Setup must not block the user's work");
    expect(canonicalSkill).toContain('declines, says "not now", ignores the offer');
    expect(canonicalSkill).toMatch(
      /do not offer again in\s+the same conversation or autonomous run/,
    );
    expect(canonicalSkill).toContain("Never nag on every draft");
    expect(canonicalSkill).toContain("Do not persist a decline or deferral");
  });

  it("keeps owner profiles out of shared or ambiguous contexts", () => {
    expect(canonicalSkill).toContain("verified private owner context");
    expect(canonicalSkill).toContain("owner-created autonomous goal or monitor continuation");
    expect(canonicalSkill).toContain("group, shared, delegated, non-owner, or ambiguous context");
    expect(canonicalSkill).toMatch(
      /do not read, quote, summarize, reveal, apply, create, or update the profile/,
    );
    expect(canonicalSkill).toContain("Never infer owner identity");
  });

  it("uses evidence or one compact interview without importing another user's values", () => {
    expect(canonicalSkill).toContain("two to five user-authored examples");
    expect(canonicalSkill).toContain("ask one compact set of questions");
    expect(canonicalSkill).toContain("Show a concise proposed profile summary");
    expect(canonicalSkill).toContain("Only after confirmation");
    expect(canonicalSkill).toContain("Never copy another user's profile");
    expect(canonicalSkill).toContain(
      "Derive style rules instead of retaining full private messages",
    );
    expect(canonicalSkill).not.toContain("Artem");
    expect(profileTemplate).not.toContain("Artem");
    expect(profileTemplate).not.toContain("founder");
  });

  it("ships a visibly unconfigured neutral template", () => {
    expect(profileTemplate).toContain("schema_version: 1");
    expect(profileTemplate).toContain("status: unconfigured");
    expect(profileTemplate).toContain("This is an unconfigured template");
    expect(profileTemplate).toContain("every `{{...}}` placeholder is replaced");
    expect(profileTemplate).toContain("Not specified; use a neutral default.");
    expect(profileTemplate).toContain("Raw example retention: none");
  });

  it("keeps the drafting contract as the approval owner while requiring tone consultation", () => {
    const draftingSkill = fs.readFileSync(
      path.join(root, "skills", "message-drafting", "SKILL.md"),
      "utf8",
    );
    expect(draftingSkill).toContain("apply the bundled");
    expect(draftingSkill).toContain("`personal-tone-of-voice` skill");
    expect(draftingSkill).toContain("still owns recipient-ready output");
    expect(draftingSkill).toContain("approval");
    expect(draftingSkill).toContain("send safety");
  });
});

describe("personal tone profile status observability", () => {
  it("reports absent without a profile", () => {
    expect(runStatus(makeWorkspace())).toEqual({
      event: "personal_tone_profile_status",
      state: "absent",
      schemaVersion: null,
      reason: "missing",
    });
  });

  it("reports the untouched template as unconfigured", () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "TONE_OF_VOICE.md"), profileTemplate);

    expect(runStatus(workspace)).toEqual({
      event: "personal_tone_profile_status",
      state: "unconfigured",
      schemaVersion: 1,
      reason: "status_not_configured",
    });
  });

  it("rejects a marker-only configuration with placeholders remaining", () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, "TONE_OF_VOICE.md"),
      profileTemplate.replace("status: unconfigured", "status: configured"),
    );

    expect(runStatus(workspace)).toEqual({
      event: "personal_tone_profile_status",
      state: "unconfigured",
      schemaVersion: 1,
      reason: "placeholders_remaining",
    });
  });

  it("reports configured without leaking profile prose or paths", () => {
    const workspace = makeWorkspace();
    const privateSentinel = "PRIVATE_SENTINEL_PHRASE";
    fs.writeFileSync(
      path.join(workspace, "TONE_OF_VOICE.md"),
      `---
schema_version: 1
status: configured
source: explicit-user-setup
---

# Personal Tone of Voice

## Core Voice

${privateSentinel}
`,
    );

    const raw = execFileSync(process.execPath, [statusScript, "--workspace", workspace], {
      encoding: "utf8",
    });
    expect(JSON.parse(raw)).toEqual({
      event: "personal_tone_profile_status",
      state: "configured",
      schemaVersion: 1,
      reason: "configured",
    });
    expect(raw).not.toContain(privateSentinel);
    expect(raw).not.toContain(workspace);
    expect(raw).not.toContain("TONE_OF_VOICE.md");
  });
});
