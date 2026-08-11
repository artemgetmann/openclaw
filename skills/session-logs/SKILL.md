---
name: session-logs
description: Search relevant excerpts from the active agent's own session history when the user asks about earlier conversations.
metadata: { "openclaw": { "emoji": "📜", "requires": { "bins": ["jq"] } } }
---

# session-logs

Recover relevant context from the active agent's own live session history. Session transcripts are private and can contain credentials, personal data, tool output, and content the user later deleted. Search narrowly and disclose only what answers the request.

## Trigger

Use this skill only when the user asks about prior chats, parent conversations, or historical context that is not already available in the current conversation or memory files. Do not mine session history proactively.

## Safety boundary

- Scope every search to the active `agent=<id>` from the system prompt Runtime line. Never enumerate the state directory's `agents/` children, guess another agent ID, or search another agent's history by default.
- Treat `sessions.json` as the live index. Search only transcripts referenced by its current entries. Exclude `*.deleted.*`, `*.reset.*`, rotated indexes, orphan transcripts, and other remnants unless the user explicitly asks to recover that material.
- Read only `user` and `assistant` text blocks needed for the request. Exclude `toolResult`, tool calls, thinking, usage metadata, and unrelated messages by default.
- Start with dates, session labels, and a narrow keyword. Expand the search only when the first pass cannot answer the request.
- Never paste a full transcript. Return the smallest relevant excerpts with enough date/session context to understand them. Redact credentials, tokens, secrets, and unrelated personal data even if they appear in a matching message.
- Session search is read-only. Do not edit, delete, restore, or rewrite session files.

## Location

Session logs live under the active state directory: `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/` (use the `agent=<id>` value from the system prompt Runtime line). If `$OPENCLAW_STATE_DIR` is not set, source/dev OpenClaw defaults to `~/.openclaw`.

- **`sessions.json`** - Index mapping session keys to session IDs
- **`<session-id>.jsonl`** - Full conversation transcript per session

## Structure

Each `.jsonl` file contains messages with:

- `type`: "session" (metadata) or "message"
- `timestamp`: ISO timestamp
- `message.role`: "user", "assistant", or "toolResult"
- `message.content[]`: Text, thinking, or tool calls (filter `type=="text"` for human-readable content)
- `message.usage.cost.total`: Cost per response

Set the scope once and keep every command inside it:

```bash
SESSION_ROOT="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/<active-agent-id>/sessions"
SESSION_INDEX="$SESSION_ROOT/sessions.json"
```

Do not replace `<active-agent-id>` with an ID discovered by listing other agents.

## Safe search workflow

### 1. List recent live indexed sessions

Read metadata first. This avoids opening every transcript and keeps deleted or orphaned files out of the search.

```bash
jq -r 'to_entries[] | [(.value.updatedAt // 0), (.value.displayName // .value.subject // .value.chatType // "session"), (.value.sessionId // ""), (.value.sessionFile // "")] | @tsv' "$SESSION_INDEX" |
  sort -rn | head -50
```

Use the timestamp, safe display label, and user-provided clues to select the smallest plausible set. Do not print raw session keys because they can contain routing identifiers. Resolve each selected entry to its current `sessionFile`, or to `$SESSION_ROOT/<sessionId>.jsonl` when `sessionFile` is absent. Reject any path that does not resolve inside `$SESSION_ROOT`, is not a regular `.jsonl` transcript, or has a `.deleted.` or `.reset.` suffix.

### 2. Search human-readable messages only

For each selected live transcript, extract user and assistant text before searching. This deliberately excludes tool results, tool calls, and thinking:

```bash
jq -r '
  select(.type == "message")
  | select(.message.role == "user" or .message.role == "assistant")
  | .timestamp as $timestamp
  | .message.role as $role
  | .message.content[]?
  | select(.type == "text")
  | [$timestamp, $role, (.text | gsub("[\\r\\n]+"; " "))]
  | @tsv
' "$SESSION_FILE" | grep -i -n -C 1 -m 10 -- 'specific phrase'
```

Keep the phrase specific. If output lines are long, inspect locally and quote only the short clause that answers the user's question.

### 3. Answer with minimal disclosure

Summarize the finding and include only relevant short excerpts, attributed by date or session label. Do not expose file paths, raw JSONL, routing identifiers, tool payloads, or unrelated neighboring messages unless the user needs them and explicitly asks.

## Focused diagnostics

These read-only queries remain useful when the user's request is about their own session rather than conversation content.

### Count messages in one selected live session

```bash
jq -s '{
  messages: [.[] | select(.type == "message")] | length,
  user: [.[] | select(.type == "message" and .message.role == "user")] | length,
  assistant: [.[] | select(.type == "message" and .message.role == "assistant")] | length,
  first: .[0].timestamp,
  last: .[-1].timestamp
}' "$SESSION_FILE"
```

### Total recorded model cost for one selected live session

```bash
jq -s '[.[] | .message.usage.cost.total // 0] | add' "$SESSION_FILE"
```

Do not run cost or usage aggregation across unrelated sessions unless the user asked for that analysis.
