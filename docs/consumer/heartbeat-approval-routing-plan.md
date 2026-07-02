# Heartbeat Approval Routing Plan

Status: short-lived follow-up plan

## TLDR

PR #1021 landed the foundation: heartbeat-derived contexts can preserve a
Telegram source topic and post a receipt after a confirmed external send.

The next slice should make approval safer and quieter:

- Store the exact pending draft before asking for approval.
- Send the stored draft on approval, not reconstructed model text.
- Mirror approval outcomes into the source session by default.
- Post visibly in the source topic only when the task agent or user needs to act.

## Product Contract

The DM is the notification and approval inbox. It is not the task home.

Active task topics remain the task home. Heartbeat can summarize, ask, and route,
but it should not fragment the work by making every approval thread become the
canonical conversation.

## Foundation Already Merged

PR #1021 added source-linked action receipts:

- Heartbeat runtime context can carry Telegram source metadata into embedded runs.
- `message action=send` can deliver a source-topic receipt after a confirmed
  non-Telegram external send.
- Receipt routing uses runtime-trusted metadata, not model-written chat IDs.
- Same-channel source account metadata is preserved only where it belongs.
- Cancelled, failed, partial, or unconfirmed sends skip receipts.

That is useful plumbing. It is not the final UX.

## Target Flow

1. Heartbeat detects an issue from a source session or topic.
2. If no user action is needed, it mirrors a checkpoint into the source session
   and avoids user spam.
3. If user action is needed, it DMs the user with a concise summary and source
   link when available.
4. If the user approves an outbound send, Jarvis sends the stored pending draft
   exactly.
5. If the user gives information that the task agent needs, Jarvis routes it
   back to the source session.
6. If that route is just context, it is mirror-only.
7. If the task agent must wake or the user's words need to appear as the user,
   use Telegram-as-user or a visible source-topic post intentionally.

## Now

- Add a pending approval record for external sends with `draft_id`, channel,
  recipient, exact text or media, source session, expiry, and risk level.
- Add mirror-only source checkpoints as the default post-approval behavior.
- Add routing policy that chooses between mirror-only, visible source-topic
  relay, and Telegram-as-user based on whether the source task needs to act.

## Gates

- Approval must send the exact stored draft, not fresh model output.
- Mirror-only checkpointing must not wake the source topic agent by default.
- Visible topic posts must be opt-in or semantically required for the task.
- Source links should use Telegram topic links when chat and thread IDs are
  available, with a clear fallback when they are not.
- Runtime deploy remains separate from merge and needs explicit approval.

## Implementation Notes

- Prefer a small approval store abstraction before broad UI changes.
- Keep the stored draft payload structured so text, media, target channel, target
  account, source session, and expiry are validated before send.
- Treat stored draft approval as idempotent: approving twice should not duplicate
  an external send.
- Keep source receipt delivery best-effort after confirmed send; never retry the
  external send because a receipt failed.
- Use source-session transcript append for mirror-only checkpoints rather than
  visible Telegram delivery.

## Proof Plan

Run local proof first:

```bash
npx -y pnpm@10.23.0 test -- src/infra/outbound/source-receipt.test.ts src/infra/outbound/message-action-runner.source-receipt.test.ts src/auto-reply/reply/agent-runner-utils.test.ts src/infra/heartbeat-runner.sender-prefers-delivery-target.test.ts src/agents/tools/message-tool.test.ts
npx -y pnpm@10.23.0 check
git diff --check origin/main...HEAD
```

For runtime proof, merge first, fast-forward the sacred main clone, then follow
`/agent-guides/runtime-ops`. Do not run the shared Jarvis runtime from a feature
worktree.
