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

function configuredProfile(coreVoice: string): string {
  return `---
schema_version: 1
status: configured
source: explicit-user-setup
---

# Personal Tone of Voice

## Core Voice

${coreVoice}

## Mechanics

- Sentence length and rhythm: Concise, varied sentences.
- Directness and warmth: Direct and warm.
- Formality and politeness: Context-aware and polite.
- Capitalization and punctuation: Standard capitalization and light punctuation.
- Vocabulary and jargon: Plain language.
- Formatting: Short paragraphs.

## Context Rules

### Professional email and outreach

Lead with the purpose and close with a clear next step.

### Chat, SMS, WhatsApp, Telegram, and iMessage

Keep messages conversational and compact.

### Follow-ups and replies

Answer the open point before adding context.

## Use

- Concrete requests and natural phrasing.

## Avoid

- Empty pleasantries and invented familiarity.

## Evidence Basis

- Basis: interview
- Confidence and uncertainty: Confirmed defaults; adapt to explicit requests.
- Raw example retention: none

## Confirmation

- Confirmed by user: yes
- Profile revision: 1
`;
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

  it("permits verified personal owner contexts while rejecting shared or ambiguous ones", () => {
    expect(canonicalSkill).toContain("verified personal owner context");
    expect(canonicalSkill).toContain("direct/private owner session");
    expect(canonicalSkill).toContain(
      "owner-only group or topic the\nruntime classifies as personal",
    );
    expect(canonicalSkill).toMatch(/owner-created autonomous goal or monitor\s+continuation/);
    expect(canonicalSkill).toContain("Do not\ninfer that a group or topic is personal");
    expect(canonicalSkill).toContain(
      "genuinely shared, delegated, non-owner, or ambiguous context",
    );
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

  it("rejects duplicate or malformed frontmatter instead of trusting a matching line", () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, "TONE_OF_VOICE.md"),
      `---
schema_version: 1
status: configured
status: unconfigured
---

# Ambiguous
`,
    );

    expect(runStatus(workspace)).toEqual({
      event: "personal_tone_profile_status",
      state: "unconfigured",
      schemaVersion: null,
      reason: "malformed_frontmatter",
    });
  });

  it("rejects a status-only profile that omits schema-v1 completion sections", () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, "TONE_OF_VOICE.md"),
      `---
schema_version: 1
status: configured
source: explicit-user-setup
---

# Personal Tone of Voice

## Core Voice

Minimal voice description.
`,
    );

    expect(runStatus(workspace)).toEqual({
      event: "personal_tone_profile_status",
      state: "unconfigured",
      schemaVersion: 1,
      reason: "missing_required_sections",
    });
  });

  it.each([
    {
      name: "explicit user confirmation",
      profile: configuredProfile("Direct and warm.").replace(
        "- Confirmed by user: yes",
        "- Confirmed by user: no",
      ),
      reason: "user_not_confirmed",
    },
    {
      name: "a positive integer revision",
      profile: configuredProfile("Direct and warm.").replace(
        "- Profile revision: 1",
        "- Profile revision: 0",
      ),
      reason: "invalid_revision",
    },
  ])("rejects a complete profile without $name", ({ profile, reason }) => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "TONE_OF_VOICE.md"), profile);

    expect(runStatus(workspace)).toEqual({
      event: "personal_tone_profile_status",
      state: "unconfigured",
      schemaVersion: 1,
      reason,
    });
  });

  it("reports a complete confirmed profile as configured without leaking prose or paths", () => {
    const workspace = makeWorkspace();
    const privateSentinel = "PRIVATE_SENTINEL_PHRASE";
    fs.writeFileSync(path.join(workspace, "TONE_OF_VOICE.md"), configuredProfile(privateSentinel));

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
