---
name: builder-priority-triage
description: Prioritize product and build work from messy Codex, OpenClaw, Jarvis, Telegram, or chat task lists. Use when the user asks what to build next, wants recent or pinned chats mapped to real work, needs strict do-next, running, waiting, archive decisions, or wants a polished HTML, PDF, image, or Telegram priority report.
---

# Builder Priority Triage

Turn scattered work into a short action-first report. Rank what needs the user's attention now, not everything that matters.

## Collect evidence

1. Read the exact candidate chat or session before classifying it. Prefer native thread state and latest turns, then verified repository, PR, package, runtime, or live evidence.
2. Preserve the exact title and authoritative owner address. For native Codex, include the full thread ID. For Telegram, verify the topic and deep link. Never invent a deep-link format.
3. Treat a closeout receipt as an index, not unquestionable truth. Inspect deeper when it is missing, stale, contradictory, or makes an important unverified claim.
4. Verify completion claims independently when they concern merges, deployments, releases, installations, or live behavior.
5. Keep source, package, installed runtime, public release, and end-user behavior as separate proof.

## Apply the action gate before scoring

For every item, answer: `Does the user need to act now? Yes or No.`

Only `Yes` items may enter the numbered priority list. Importance alone is not enough.

Use these sections:

- **Your actions now**: a decision, approval, clarification, or manual action is required now.
- **Running without you**: an owner is actively progressing and needs no intervention.
- **Waiting**: progress depends on an external event. Include the deadline or intervention trigger.
- **Finished / archive**: the declared outcome is proven and no unowned remaining work exists.
- **Handled / no action**: compact record used only to prevent resurfacing.

Hard rules:

- `wait`, `monitor`, and `let it run` are not user actions unless they include a deadline or intervention trigger.
- Never recommend `Archive` when a receipt or transcript contains remaining work without a verified owner.
- An active chat requiring no user action belongs under **Running without you**, never in the main stack.
- Pinned, visible, unread, active, or unarchived state is a discovery signal, not a priority verdict.
- If no chat owns important remaining work, state `No owner` and make the ownership decision the actionable item.

## Score only actionable work

- **P0**: broken core product or urgent real-user surface requiring action now.
- **P1**: directly unlocks users, testing, shipping, or revenue and has a current action.
- **P2**: useful support, polish, or capability work with a concrete unfinished blocker.
- **P3**: maintenance or a future wedge with a current but low-value action.
- **NO**: stale, speculative, already handled, or unrelated to current users.

Cap the daily main stack at three to five items. Use up to ten only for an explicit weekly or backlog board.

## Output

Lead with the single highest-value action. Then show:

| Priority | Exact owner title | Meaning | Why now | User action |
| -------- | ----------------- | ------- | ------- | ----------- |

After the main stack, show the compact non-action sections. Every running or waiting row must name its owner and re-entry trigger.

## Closeout receipt contract

When a chat finishes, blocks, hands work elsewhere, recommends archive, or discovers a separate concrete follow-up, look for:

```text
Outcome: <what is proven now>
Remaining: <unfinished work, or None>
Owner: <exact owning chat/thread, or No owner>
Next action: <who does what, or None>
```

If the receipt is absent, read the latest terminal response. Deep-read the full transcript only when the latest response and original request do not resolve the ambiguity.

## Visual reports

Use `scripts/render_priority_report.py` to render the report when the user requests HTML, PDF, or an image. Inspect the generated preview locally before sending it. When Telegram delivery is requested, send the PDF as a document rather than a local path.

## Optional Codex enforcement

To enforce the same contract in native Codex, register the repository hook in the user's Codex config. Replace `<openclaw-repo>` with the absolute checkout path:

```toml
[hooks]
Stop = [{ hooks = [{ type = "command", command = "node <openclaw-repo>/scripts/codex-response-closeout-hook.mjs", timeout = 5 }] }]
```

Codex must trust the configured hook. Never bypass hook trust permanently. The hook performs deterministic checks only and allows the single revision pass, so it cannot loop or make a second independent model call.
