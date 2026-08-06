---
name: personal-tone-of-voice
description: "Set up, inspect, apply, or update the user's personal writing voice for recipient-facing external drafts. Use with every WhatsApp, Telegram, email, SMS/iMessage, outreach, follow-up, or reply draft when a personal owner context is verified, including an owner-only group or topic the runtime classifies as personal; if the workspace tone profile is absent or unconfigured, offer one lightweight setup without blocking the draft."
user-invocable: false
metadata: { "openclaw": { "emoji": "✍️", "displayName": "Personal Tone of Voice" } }
---

# Personal Tone of Voice

Use this alongside `message-drafting`. This skill owns personal style setup and
application. `message-drafting` still owns recipient-ready formatting,
cross-language review, approval, and send safety.

## Precedence

Apply these rules in order:

1. The user's explicit instruction for the current draft.
2. A relevant context or channel rule in a configured profile.
3. The configured profile's default voice.
4. A neutral, clear drafting default.

An explicit request such as "write in your own voice", "use Jarvis's voice",
"ignore my saved style", or a specific current-draft tone overrides the profile
for that draft. Do not inspect, apply, or offer to configure the profile when
the user explicitly asks for Jarvis's own voice.

The profile affects wording and style only. It never overrides facts,
commitments, names, dates, numbers, links, safety rules, approval requirements,
or the user's current instructions.

## Owner And Privacy Gate

Consult or change a personal profile only in a verified personal owner context.
This includes a direct/private owner session, an owner-only group or topic the
runtime classifies as personal, or an owner-created autonomous goal or monitor
continuation whose workspace and user scope are already established. Do not
infer that a group or topic is personal; rely on the runtime classification and
verified owner scope.

In a genuinely shared, delegated, non-owner, or ambiguous context:

- do not read, quote, summarize, reveal, apply, create, or update the profile;
- use the explicit current-request tone or a neutral default;
- do not offer personal-profile setup.

Never infer owner identity from a name, locale, timezone, nationality, contact,
channel, or writing sample.

## Profile State

The profile path is `TONE_OF_VOICE.md` at the active agent workspace root. Do
not store the profile in this bundled skill, `USER.md`, `SOUL.md`, shared
personal skill mirrors, runtime mirrors, or ordinary memory.

When local tools are available, run
`node <this-skill-directory>/scripts/profile-status.mjs` from the active
workspace before an external draft. Its content-free JSON result is the
observable state:

- `absent`: no profile exists;
- `unconfigured`: a template, malformed profile, unsupported schema, or
  placeholder-filled profile exists;
- `configured`: schema version 1 declares `status: configured` and contains no
  template placeholders.

Never infer configuration from file existence alone. Treat unreadable,
malformed, unknown-version, or placeholder-filled files as `unconfigured` and
do not apply them. The status helper must never output profile prose.

If tools are unavailable, use only profile state already established in the
current session. Otherwise treat the profile as absent and continue safely.

## Drafting Behavior

For `configured` in verified owner context:

1. Read only `TONE_OF_VOICE.md`.
2. Apply the smallest relevant default and channel/context rules.
3. Follow explicit current-draft instructions when they conflict.
4. Draft normally through `message-drafting`.

For `absent` or `unconfigured`:

1. Complete the requested draft now using the explicit tone or a neutral,
   clear default. Setup must not block the user's work.
2. Offer once, briefly, after the draft: explain that Jarvis can learn the
   user's writing voice from a few examples or a short interview.
3. If the user declines, says "not now", ignores the offer, or continues with
   drafting, do not offer again in the same conversation or autonomous run.
   A later explicit setup request always reopens setup.
4. Do not persist a decline or deferral unless the user explicitly asks for a
   durable preference.

Never nag on every draft. Never silently learn a durable profile from ordinary
conversation or outbound messages.

## Lightweight Setup

Start only after the user agrees or explicitly asks to configure their voice.
Prefer evidence over personality labels:

1. Ask for two to five user-authored examples, ideally from the contexts they
   care about. Private snippets may be redacted.
2. If examples are unavailable, ask one compact set of questions covering:
   directness and warmth, sentence rhythm, greetings and closings,
   capitalization and punctuation, words or patterns to use or avoid, and
   meaningful differences between professional and casual messages.
3. Extract concrete rules, context differences, and anti-patterns. Separate
   observed evidence from user-stated preferences and mark uncertainty.
4. Show a concise proposed profile summary plus one short test rewrite. Ask the
   user to correct or confirm it.
5. Only after confirmation, create or replace `TONE_OF_VOICE.md` from
   `references/profile-template.md`, replace every `{{...}}` placeholder, and
   change `status: unconfigured` to `status: configured`.
6. Run the status helper again and report only whether it is configured. If it
   remains unconfigured, fix the template or explain the exact non-sensitive
   reason.

Keep the profile useful and minimal:

- Derive style rules instead of retaining full private messages.
- Do not store secrets, credentials, contact details, private third-party
  facts, or unnecessary biography.
- Do not infer values, politics, identity, profession, or personality from
  sparse writing evidence.
- Never copy another user's profile, examples, phrases, values, or personal
  formatting habits. Bundled examples must stay neutral.
- Use `Not specified; use a neutral default.` for an unresolved field instead
  of inventing a preference.

## Updates

Update a configured profile only when the owner explicitly asks or clearly
corrects a durable style rule. Summarize the proposed change and get
confirmation before replacing the file. Preserve unrelated confirmed rules.

When asked for diagnostics, report only profile state, schema version, and the
non-sensitive reason returned by the helper unless the owner explicitly asks
to review the profile contents.
