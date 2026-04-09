You are implementing the "agent-first durable monitors" redesign in OpenClaw.

Important: the formal plan is provided separately and is the source of truth. Implement that plan faithfully instead of redesigning it again.

Known context:

- We already investigated a live bug where a WhatsApp monitor kept repeating the same negotiation message across wakes, like it had amnesia.
- The repeated-reply bug was real.
- The immediate live symptom came from a stateless wake flow that effectively reasoned from the newest inbound message instead of resuming the same conversational task.
- A small WhatsApp helper-level continuity fix already exists, but it is not the architectural solution.
- The real problem is broader: scheduled monitors do not behave like the same assistant continuing the same task.
- This should apply beyond WhatsApp to Gmail/email and future sources.

Current PR state you must account for explicitly:

- Main draft PR: #415
  - branch: codex/whatsapp-monitor-continuity-20260408
  - worktree: /Users/user/Programming_Projects/openclaw/.worktrees/whatsapp-monitor-continuity-20260408
- Consumer draft PR: #416
  - branch: codex/whatsapp-monitor-continuity-consumer
  - worktree: /Users/user/Programming_Projects/openclaw-consumer/.worktrees/whatsapp-monitor-continuity-consumer

These PRs came from a narrow WhatsApp continuity fix and may now be superseded by the broader redesign.
You must explicitly account for them:

- inspect them
- decide whether to update them, supersede them, or close them later
- do not silently forget them

If you continue in the existing main worktree, keep PR #415 in sync.
If you decide a fresh redesign lane is necessary, explicitly note in the new PR/body that it supersedes #415, and decide separately what to do with #416.

Implementation expectations:

- follow the plan exactly
- inspect existing cron/session/monitor code paths before editing
- keep the MVP polling-based
- do not broaden scope into unrelated OAuth healing, verbose mode, or Telegram-specific behavior
- preserve backward compatibility where reasonable unless the plan says otherwise
- keep source-specific logic thin
- add comments where the continuity model would otherwise be easy to misunderstand

Testing expectations:

- repeated wakes resume the same monitor session
- monitor session preserves prior context
- origin chat routing is correct
- notify + draft is the default
- minimal checkpointing prevents reprocessing forever
- WhatsApp negotiation no longer behaves like stateless latest-message-only logic
- Gmail/email monitoring works through the same generic monitor model

Workflow expectations:

- make a checkpoint commit once the first coherent implementation slice exists
- open/update a draft PR to main once that coherent slice exists
- after validation, decide whether the fix should also be ported to consumer; if yes, open/update the consumer draft PR too; if not, explain why
- final report must include branch, worktree, changed files, validation proof, PR link(s), and what happened with #415/#416

Deliverables:

- code changes
- tests
- concise root-cause-to-fix explanation
- notes on migration/backward-compat implications
- short summary of what remains intentionally out of scope for MVP
