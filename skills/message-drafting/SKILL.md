---
name: message-drafting
description: "Compose, draft, revise, shorten, translate, review, approve, or prepare recipient-facing messages for sending across email, chat, and messaging channels. Use for direct requests involving message wording, tone, cross-language presentation, revisions, approval-ready output, or sending a message to another person."
user-invocable: false
---

# Message Drafting

## Composition Contract

- Follow the destination channel's context, safety, freshness, and send rules.
- Before composing external recipient-facing text, apply the bundled
  `personal-tone-of-voice` skill. It owns private profile setup, safe profile
  state checks, per-draft overrides, and personalized style. This drafting skill
  still owns recipient-ready output, review, approval, and send safety.
- Produce one final message by default, not a menu of stylistic alternatives.
- Match the requested tone and preserve the user's facts, commitments, names,
  dates, numbers, and links.
- Make the output ready for the user to approve, revise, or send.

## Exact Recipient Payload Formatting

- Render every exact recipient-ready payload as one Markdown blockquote: prefix
  every payload line with `>`, including blank separator lines between
  paragraphs. This preserves one tap-to-copy block for the complete draft.
- Keep the exact draft plain and copyable. Do not switch to native rich
  presentation merely because the content is structured.
- For cross-language drafts, keep the meaning/review block as normal prose and
  render only the exact target-language outbound block as quoted payload lines.
- For single-language drafts, render the exact recipient-ready message as quoted
  payload lines too.

## Cross-Language Review

First choose the review language using this precedence:

1. An explicit review-language instruction in the current request.
2. The most recent explicit conversation-wide review-language instruction in the
   current conversation.
3. The established language of the current conversation.
4. If none of the above resolves it, the language of the user's unquoted
   drafting or directive clause, excluding quoted or clearly delimited recipient
   text. If that directive text is genuinely mixed, use the language of its first
   complete directive clause, invite correction, and proceed with the draft.

Never infer the review language from nationality or assume it is the user's
native language. Do not select it merely from locale, timezone, profile data, or
the fact of a single code-switched message. Mere code-switching is not preference
evidence; the fallback above selects a review language only for the current
draft. An explicit review-language instruction remains explicit when it appears
in a code-switched message.

An explicit current-request instruction wins for that draft. Treat wording such
as "this time" as one-time. Wording such as "always" or "from now on" may
establish a conversation-wide review-language instruction for later drafts in
the current conversation; the most recent such instruction wins. This skill must
not read or write `USER.md` or any profile or memory file. Durable persistence is
deferred to an owner-verified profile or memory path outside this skill.

In a group, shared, non-owner, or ambiguous context, never consult or apply owner
profile preferences.

When the target language differs from the selected review language, present one
aligned pair in this order:

1. `Meaning (<review language>)` — what the recipient-ready message means.
2. `Ready to send (<target language>)` — the exact outbound message.

Keep both blocks equivalent in facts, commitments, tone, names, dates, numbers,
and links. For example, an English-speaking Jarvis conversation with an Italian
recipient-ready message shows the English meaning first and the Italian message
second.

Ask for approval unambiguously against the target-language version, for example:
`Approve the Italian version for sending?` After approval, send only the exact
target-language block. Never include the review block, headings, or commentary
in the outbound payload.

When the user revises or shortens the same draft, retain its previously selected
review language, including a one-time selection, unless the current revision
explicitly changes or corrects the review language. Then recompute the output
shape. If the selected review and target languages still differ, regenerate both
blocks and keep them aligned. If they match, emit only the target-ready message.
Nothing is sent until the updated target-language message is approved. Provide
multiple stylistic variants only when explicitly requested; every variant must be
its own aligned review/target pair.

## Single-Language Exceptions

Do not duplicate the message into review and target blocks when:

- the target language matches the selected review language;
- the user asks for target-language-only output, such as "Italian only";
- the user explicitly says in the current conversation that they are fluent and
  want target-only output;
  or
- the request is raw translation rather than a sendable recipient-facing
  message.
