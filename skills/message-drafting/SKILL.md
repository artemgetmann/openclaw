---
name: message-drafting
description: "Compose, draft, revise, shorten, translate, review, approve, or prepare recipient-facing messages for sending across email, chat, and messaging channels. Use for direct requests involving message wording, tone, cross-language presentation, revisions, approval-ready output, or sending a message to another person."
user-invocable: false
---

# Message Drafting

## Composition Contract

- Follow the destination channel's context, safety, freshness, and send rules.
- Produce one final message by default, not a menu of stylistic alternatives.
- Match the requested tone and preserve the user's facts, commitments, names,
  dates, numbers, and links.
- Make the output ready for the user to approve, revise, or send.

## Cross-Language Review

When the recipient-facing language differs from the language the user normally
uses with Jarvis, present one aligned pair in this order:

1. `Meaning (<review language>)` — what the recipient-ready message means.
2. `Ready to send (<target language>)` — the exact outbound message.

Use the language the user normally uses with Jarvis as the review language
unless the user has explicitly preferred another review language. Never infer
the review language from nationality or assume it is the user's native language.

Keep both blocks equivalent in facts, commitments, tone, names, dates, numbers,
and links. For example, an English-speaking Jarvis conversation with an Italian
recipient-ready message shows the English meaning first and the Italian message
second.

Ask for approval unambiguously against the target-language version, for example:
`Approve the Italian version for sending?` After approval, send only the exact
target-language block. Never include the review block, headings, or commentary
in the outbound payload.

When the user revises or shortens the draft, regenerate both blocks and keep
them aligned. Provide multiple stylistic variants only when explicitly
requested; every variant must be its own aligned review/target pair.

## Single-Language Exceptions

Do not duplicate the message into review and target blocks when:

- the send language matches the user's normal Jarvis language;
- the user asks for target-language-only output, such as "Italian only";
- an explicit user preference says they are fluent and want target-only output;
  or
- the request is raw translation rather than a sendable recipient-facing
  message.
