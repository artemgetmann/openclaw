---
name: "message-drafting"
description: "Draft, revise, shorten, translate, and prepare approval-ready recipient-facing messages while preserving the user's meaning and voice. Use for replies, outreach, email, chat, or any sendable message, especially when the recipient language differs from the language the user reviews."
---

# Message Drafting

Own the recipient-facing composition: wording, tone, cross-language
presentation, revisions, and the exact payload offered for approval. Let the
relevant channel skill own source freshness, recipient identity, permissions,
and send mechanics.

## Compose One Message

1. Establish the message's facts, commitments, audience, desired tone, and
   target language from the user's request and current source context.
2. Preserve facts, commitments, tone, names, dates, numbers, and links. Do not
   silently strengthen, weaken, add, or remove any of them.
3. Determine the user's review language from the current request or an
   established preference such as `USER.md`. Treat that as a personal
   preference, not a product-wide default; never hardcode English as the review
   language.
4. Produce one coherent, sendable message. Do not offer stylistic alternatives
   unless the user explicitly requests alternatives.

## Present Cross-Language Drafts

When the recipient-ready send language differs from the user's review language,
present one conceptual message as an aligned pair in this order:

1. `Meaning for your review (<review language>):`
2. `Exact message to send (<target language>):`

Keep both blocks semantically aligned. The first block explains exactly what
the recipient-ready second block means; the blocks are not stylistic
alternatives.

For example, when the user reviews in English and the recipient should receive
Italian, present:

```text
Meaning for your review (English):
<the exact English meaning>

Exact message to send (Italian):
<the recipient-ready Italian text>
```

Use a single target-language block instead when:

- the review and target languages are the same;
- the user explicitly requests target-language-only output;
- an established fluent or target-only preference applies; or
- the user requests a raw translation rather than a sendable message.

## Revise Both Blocks

When the user revises, shortens, softens, strengthens, or corrects a paired
draft, update both blocks together. Re-check their alignment and preserve the
same facts, commitments, names, dates, numbers, and links in both.

Do not turn a revision request into multiple alternatives unless the user
explicitly asks for alternatives.

## Prepare Approval and Send

For a paired draft, ask for approval by identifying the recipient and the exact
target-language payload unambiguously, for example: `Ready to send this exact
Italian text to <recipient>?`

After approval, pass only the recipient-ready target-language block to the send
tool. Never send the review-language block, headings, explanation, or
alternatives. If either block changes after approval, request approval again for
the updated target-language payload.
