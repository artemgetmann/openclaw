---
name: acp-router
description: Route plain-language requests for Pi, Claude Code, Codex, OpenCode, Gemini CLI, or ACP harness work into either OpenClaw ACP runtime sessions or direct acpx-driven sessions ("telephone game" flow). For coding-agent thread requests, read this skill first, then use only `sessions_spawn` for thread creation.
user-invocable: false
---

# ACP Harness Router

When user intent is "run this in Pi/Claude Code/Codex/OpenCode/Gemini/Kimi (ACP harness)", do not use subagent runtime or PTY scraping. Route through ACP-aware flows.

## Intent detection

Trigger this skill when the user asks OpenClaw to:

- run something in Pi / Claude Code / Codex / OpenCode / Gemini
- continue existing harness work
- relay instructions to an external coding harness
- keep an external harness conversation in a thread-like conversation

Mandatory preflight for coding-agent thread requests:

- Before creating any thread for Pi/Claude/Codex/OpenCode/Gemini work, read this skill first in the same turn.
- After reading, follow `OpenClaw ACP runtime path` below; do not use `message(action="thread-create")` for ACP harness thread spawn.

## Mode selection

Choose one of these paths:

1. OpenClaw ACP runtime path (default): use `sessions_spawn` / ACP runtime tools.
2. Direct `acpx` path (telephone game): use `acpx` CLI through `exec` only for explicit one-shot/direct-acpx intent.

Use direct `acpx` only when one of these is true:

- user explicitly asks for direct `acpx` driving
- user explicitly asks for one-shot behavior instead of a reusable session/thread

Do not use direct `acpx` as a fallback for:

- `runtime: "acp"` requests
- thread-bound harness requests
- persistent/session requests
- requests to continue or relay to an existing harness worker

Do not use:

- `subagents` runtime for harness control
- `/acp` command delegation as a requirement for the user
- PTY scraping of pi/claude/codex/opencode/gemini/kimi CLIs when `acpx` is available

## AgentId mapping

Use these defaults when user names a harness directly:

- "pi" -> `agentId: "pi"`
- "claude" or "claude code" -> `agentId: "claude"`
- "codex" -> `agentId: "codex"`
- "opencode" -> `agentId: "opencode"`
- "gemini" or "gemini cli" -> `agentId: "gemini"`
- "kimi" or "kimi cli" -> `agentId: "kimi"`

These defaults match current acpx built-in aliases.

If policy rejects the chosen id, report the policy error clearly and ask for the allowed ACP agent id.

## OpenClaw ACP runtime path

Required behavior:

1. For ACP harness thread spawn requests, read this skill first in the same turn before calling tools.
2. Use `sessions_spawn` with:
   - `runtime: "acp"`
   - `thread: true`
   - `mode: "session"` (unless user explicitly wants one-shot)
3. For ACP harness thread creation, do not use `message` with `action=thread-create`; `sessions_spawn` is the only thread-create path.
4. Put requested work in `task` so the ACP session gets it immediately.
5. Set `agentId` explicitly unless ACP default agent is known.
6. Do not ask user to run slash commands or CLI when this path works directly.

Persistence invariant:

- If the user wants a reusable harness worker, a bound thread, a follow-up relay target, or a continued ACP conversation, stay on the ACP runtime path.
- For those requests, do not silently switch execution models.
- If ACP cannot be repaired into a usable persistent session, fail loudly with the exact ACP error instead of using direct `acpx exec`.

Example:

User: "spawn a test codex session in thread and tell it to say hi"

Call:

```json
{
  "task": "Say hi.",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

## Thread spawn recovery policy

When the user asks to start a coding harness in a thread (for example "start a codex/claude/pi/kimi thread"), treat that as an ACP runtime request and try to satisfy it end-to-end.

Required behavior when ACP backend is unavailable for a persistent/thread-bound ACP request:

1. Do not immediately ask the user to pick an alternate path.
2. First attempt automatic local repair:
   - ensure plugin-local pinned acpx is installed in `extensions/acpx`
   - verify `${ACPX_CMD} --version`
3. After reinstall/repair, restart the gateway and explicitly offer to run that restart for the user.
4. Retry ACP thread spawn once after repair.
5. Only if repair+retry fails, report the concrete error and stop.

Fail-closed rule for persistent requests:

- Do not offer direct `acpx` telephone-game flow as fallback for thread-bound or persistent ACP requests.
- Do not convert a persistent ACP request into one-shot `acpx exec`.
- The only acceptable outcomes are:
  - persistent ACP session created or reused successfully
  - explicit failure with the exact ACP error and failing step

Do not default to subagent runtime for these requests.

## ACPX install and version policy (direct acpx path)

For this repo, direct `acpx` calls must follow the same pinned policy as the `@openclaw/acpx` extension.

1. Prefer plugin-local binary, not global PATH:
   - `${ACPX_CMD}` when already injected into the environment
   - otherwise `./dist/extensions/acpx/node_modules/.bin/acpx`
   - otherwise `./extensions/acpx/node_modules/.bin/acpx`
2. Resolve pinned version from extension dependency:
   - `node -e "console.log(require('./extensions/acpx/package.json').dependencies.acpx)"`
3. If binary is missing or version mismatched, install plugin-local pinned version:
   - `cd extensions/acpx && npm install --omit=dev --no-save acpx@<pinnedVersion>`
4. Verify before use:
   - `"${ACPX_CMD}" --version`
5. If install/repair changed ACPX artifacts, restart the gateway and offer to run the restart.
6. Do not run `npm install -g acpx` unless the user explicitly asks for global install.
7. Never replace `${ACPX_CMD}` with guessed package-manager paths like `/opt/homebrew/lib/node_modules/...`.

Set and reuse:

```bash
if [[ -z "${ACPX_CMD:-}" ]]; then
  if [[ -x "./dist/extensions/acpx/node_modules/.bin/acpx" ]]; then
    ACPX_CMD="./dist/extensions/acpx/node_modules/.bin/acpx"
  elif [[ -x "./extensions/acpx/node_modules/.bin/acpx" ]]; then
    ACPX_CMD="./extensions/acpx/node_modules/.bin/acpx"
  else
    echo "acpx binary missing in dist/ and extensions/" >&2
    exit 1
  fi
fi
```

## Direct acpx path ("telephone game")

Use this path to drive harness sessions without `/acp` or subagent runtime.
This path is for explicit direct-acpx or explicit one-shot requests only.

### Rules

1. Use `exec` commands that call `${ACPX_CMD}`.
2. Reuse a stable session name per conversation so follow-up prompts stay in the same harness context.
3. Do not invent unsupported `acpx` flags. For Codex direct calls, prefer only flags shown by `${ACPX_CMD} codex --help`.
4. Use `exec` (one-shot) only when the user wants one-shot behavior.
5. Keep working directory explicit via the shell/tool `workdir`, not by adding unsupported `--cwd` flags to `acpx`.
6. Do not use this path to satisfy a request that was already identified as a persistent/thread-bound ACP request.

### Session naming

Use a deterministic name, for example:

- `oc-<harness>-<conversationId>`

Where `conversationId` is thread id when available, otherwise channel/conversation id.

### Command templates

Persistent session (create if missing, then prompt):

```bash
${ACPX_CMD} codex sessions show oc-codex-<conversationId> \
  || ${ACPX_CMD} codex sessions new --name oc-codex-<conversationId>

printf '%s' "<prompt>" | ${ACPX_CMD} codex prompt -s oc-codex-<conversationId> -f -
```

Run that command from the target repo as the shell/tool `workdir`.

One-shot:

```bash
printf '%s' "<prompt>" | ${ACPX_CMD} codex exec -f -
```

Run that command from the target repo as the shell/tool `workdir`.

Cancel in-flight turn:

```bash
${ACPX_CMD} codex cancel -s oc-codex-<conversationId>
```

Close session:

```bash
${ACPX_CMD} codex sessions close oc-codex-<conversationId>
```

### Harness aliases in acpx

- `pi`
- `claude`
- `codex`
- `opencode`
- `gemini`
- `kimi`

### Built-in adapter commands in acpx

Defaults are:

- `pi -> npx pi-acp`
- `claude -> npx -y @zed-industries/claude-agent-acp`
- `codex -> npx @zed-industries/codex-acp`
- `opencode -> npx -y opencode-ai acp`
- `gemini -> gemini`
- `kimi -> kimi acp`

If `~/.acpx/config.json` overrides `agents`, those overrides replace defaults.

### Failure handling

- `acpx: command not found`:
  - for explicit direct-acpx requests, install plugin-local pinned acpx in `extensions/acpx` immediately
  - restart gateway after install and offer to run the restart automatically
  - then retry once
  - do not ask for install permission first unless policy explicitly requires it
  - do not install global `acpx` unless explicitly requested
- adapter command missing (for example `claude-agent-acp` not found):
  - for explicit direct-acpx requests, first restore built-in defaults by removing broken `~/.acpx/config.json` agent overrides
  - then retry once before offering fallback
  - if user wants binary-based overrides, install exactly the configured adapter binary
- `NO_SESSION`: run `${ACPX_CMD} <agent> sessions new --name <sessionName>` then retry prompt.
- queue busy: either wait for completion (default) or use `--no-wait` when async behavior is explicitly desired.

### Output relay

When relaying to user, return the final assistant text output from `acpx` command result. Avoid relaying raw local tool noise unless user asked for verbose logs.
