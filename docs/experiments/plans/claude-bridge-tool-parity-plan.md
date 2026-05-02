# Claude Bridge Tool Parity Plan

## TL;DR

Turn `claude-bridge/sonnet` from a continuity-only backend into a real tool-capable OpenClaw backend.

Do **not** rebuild the whole backend blindly.

Do this by:

1. preserving the currently working continuity behavior
2. minimizing Claude-specific prompt surface and OpenClaw fingerprints
3. proving real tool execution with a tiny probe first
4. then expanding to `exec`, `browser`, and the normal OpenClaw tool surface

The rollout may be staged for validation, but the product goal is **full practical tool parity**, not a permanent toy allowlist.

---

## Problem Statement

`claude-bridge/sonnet` currently has proven multi-turn continuity, including `Claude -> GPT -> Claude` context preservation in Telegram.

But it does **not** have real tool parity with Codex/GPT.

Current hard evidence:

- In [`src/agents/cli-runner.ts`](../../../src/agents/cli-runner.ts), the Claude bridge prompt injects:
  - `Tools are disabled in this session. Do not call tools.`
- That same bridge path builds the prompt stack with `tools: []`.
- Live Telegram evidence showed Claude bridge claiming it could not run shell commands.
- Therefore prior “tool-like” replies such as printing the working directory were likely prompt-guessing, not real tool execution.

This is not acceptable as the long-term product state.

---

## Goal

Make `claude-bridge/sonnet` a **real tool-capable backend** with behavior close to Codex/GPT on the OpenClaw runtime.

The intended end state is:

- continuity still works
- real tool calls are allowed
- tool results come back into the same conversation correctly
- `exec` works
- `browser` works
- follow-up questions can correctly use prior tool results

---

## Non-Goals

- Do not rebuild the backend architecture from scratch unless forced by evidence.
- Do not regress current continuity behavior just to chase tool parity.
- Do not cargo-cult another repo wholesale.
- Do not add giant prompt dumps if a smaller prompt surface can work.
- Do not ship a permanent “tiny allowlist only” product unless hard evidence proves Anthropic constraints make full parity impossible.

---

## Working Theory

The current bridge was intentionally constrained because Anthropic Claude CLI / subscription usage appeared sensitive to:

- large OpenClaw-style system prompts
- OpenClaw-specific markers / fingerprints
- possibly explicit tool-platform framing

So the earlier bridge implementation likely took the survival route:

- keep continuity
- disable tools
- simplify the prompt

That solved the first problem but left the product in a fake-parity state.

The next step is to determine how much real tool capability can be restored **without** triggering the earlier Claude-side rejection behavior.

---

## External Inspiration

### GlueClaw

Useful as a **pattern library**, not as something to adopt blindly.

Important takeaways:

- it treats Claude CLI as more of a first-class engine
- it adapts stream output into runtime events
- it persists Claude session ids
- it is willing to scrub prompt content aggressively
- it appears more aggressive about tool integration

Important caveats:

- it leans on compatibility hacks
- it patches installed OpenClaw dist in place
- it likely has a higher Claude-specific breakage risk

Instruction for implementer:

- borrow ideas where useful
- do not copy its whole architecture without an explicit reason

### Anthropic First-Party Surfaces

Also note that Anthropic now has more official surfaces around subscription-backed Claude usage:

- web
- desktop
- remote control
- channels
- Chrome

This means the implementation should avoid overfitting to one fragile unofficial hack when a smaller compatibility layer may be enough.

---

## Product Direction

The end goal is **full practical parity**, but the implementation should use staged proof.

That means:

- staged rollout is a diagnostic tactic
- not the final product vision

The product intent should remain:

- Claude bridge should be able to use the same important OpenClaw tools as Codex/GPT

At minimum that includes:

- file/context tools
- `exec`
- `browser`

---

## Required Questions To Answer

The implementation work must answer these explicitly:

1. What exactly caused earlier Claude-side failures?
   - token volume only?
   - prompt semantics?
   - OpenClaw branding/markers?
   - tool schema bulk?
   - some combination?

2. Can Claude bridge execute at least one real OpenClaw tool call without triggering Anthropic-side rejection?

3. Can tool results be fed back into the same bridge conversation and used correctly in the next turn?

4. Can `exec` be enabled safely and actually execute commands?

5. Can `browser` be enabled and use real browser lanes instead of falling back into advice/Peekaboo chatter?

6. Does any of this require:
   - persisted Claude session ids
   - more aggressive prompt scrubbing
   - compact tool manifests instead of full inline tool descriptions

---

## Likely Architecture Direction

The likely good direction is:

### 1. Keep the current bridge session reuse model initially

Do not throw away what already works unless evidence forces it.

Preserve:

- working continuity
- in-process bridge session reuse

### 2. Reduce Claude prompt surface

The Claude path should likely use:

- a small, Claude-compatible bridge prompt
- reduced OpenClaw-specific markers
- minimal tool summary inline

Avoid:

- giant full tool bible inline
- excessive OpenClaw-specific wording if that appears to trigger rejection

### 3. Move toward compact modular tool description

The likely good shape is:

- tiny inline summary of available tools
- concise tool list
- small on-demand detail for relevant tools

This does **not** mean “just point Claude at a huge `TOOLS.md` and hope.”

It means:

- minimize always-on prompt weight
- expand tool detail only when useful

### 4. Restore tools incrementally for proof

Even though the goal is full parity, the validation path should be staged:

1. one harmless real tool
2. then `exec`
3. then `browser`
4. then broader tool surface

This gives high-signal failure points.

---

## Recommended Validation Sequence

### Phase 0: Establish Baseline

Before changing behavior:

- capture current bridge prompt composition
- capture current Claude-side failure constraints if reproducible
- capture current live continuity behavior as baseline

### Phase 1: Minimal Real Tool Probe

Re-enable one truly harmless real tool path, likely one of:

- `read`
- `ls`
- `grep`

Success condition:

- Claude emits a real tool call
- runtime executes it
- Claude consumes the real result correctly

Failure condition:

- Anthropic/Claude CLI rejects the run
- tool call is never emitted
- tool result is ignored or malformed

### Phase 2: `exec`

If minimal tool probe succeeds:

- re-enable `exec`
- validate with a command that cannot be guessed from prompt alone

Examples:

- create a nonce file
- read it back
- run `pwd`
- run `ls` with a path whose result is not trivially known from prompt

Success condition:

- real command execution
- result returned
- follow-up question uses that exact result correctly

### Phase 3: `browser`

If `exec` succeeds:

- re-enable `browser`
- validate against real browser lanes

Required checks:

- does Claude use `browser` instead of giving advice prose?
- can it use `profile="signed-in"` or `profile="openclaw"` correctly?
- does it avoid spurious Peekaboo fallback?
- does it actually open/snapshot/act instead of just describing steps?

### Phase 4: Tool-Result Continuity

After tool execution works:

- verify a tool result can be referenced in a later turn
- verify a tool result survives `Claude -> GPT -> Claude` switching if that matters to product behavior

---

## Browser-Specific Notes

The browser problem should be treated carefully.

Current evidence suggests:

- the platform has a real browser tool
- browser profiles/lane config are not fundamentally missing
- `signed-in` and `user-live` exist in the browser system
- historical logs show `signed-in` has worked before
- `user-live` attach is flaky
- the model may be nudged into Peekaboo fallback by injected operator guidance instead of actually trying `browser`

So the browser problem is likely some combination of:

- prompt/routing bias
- missing real tool exposure on Claude bridge
- lane selection confusion
- separate `user-live` attach fragility

Do **not** assume “browser is broken” as a single root cause.

---

## Implementation Constraints

The implementing AI must respect these:

- preserve current continuity behavior unless there is a strong reason not to
- keep changes scoped to Claude bridge parity work
- do not bundle unrelated Telegram/runtime cleanup
- do not rely on fake-success replies as evidence
- prefer explicit proof over intuition

If introducing modular prompt docs:

- keep always-on prompt surface small
- avoid giant always-injected tool docs
- prefer compact manifest + targeted expansion

---

## Evidence Standards

Do not claim parity from prose.

Required proof for each tool class:

### For any tool

- exact tool call emitted
- exact tool result returned
- exact assistant follow-up using that result

### For `exec`

- command cannot be trivially guessed
- output includes a nonce or machine-specific state

### For `browser`

- actual browser action happened
- snapshot/screenshot/tab state proves it
- no “I would need permission” fallback unless that permission block is real and verified

### For continuity with tools

- tool result referenced correctly in a later turn
- if testing model switching, verify after `Claude -> GPT -> Claude`

---

## Deliverables

The implementing AI should return:

1. exact prompt/tool strategy chosen
2. exact files changed
3. exact proof of the first successful real tool call
4. exact proof for `exec`
5. exact proof for `browser`
6. exact remaining parity gaps, if any
7. a blunt answer:
   - full practical parity achieved
   - partial parity achieved
   - blocked by Anthropic/Claude constraints

---

## Decision Rule

If the first minimal real tool probe fails because Claude-side prompt compatibility breaks immediately:

- stop
- report exact failure mode
- do not blindly continue to add more tools

If the first minimal probe succeeds:

- continue quickly to `exec`
- then `browser`

Because the product goal is not a forever-limited tool allowlist. The probe is only there to avoid wasting time.

---

## Suggested First Task Prompt

Use this as the handoff seed to another AI:

> Convert `claude-bridge/sonnet` from continuity-only mode into a real tool-capable OpenClaw backend without regressing current continuity. The current bridge explicitly disables tools in `src/agents/cli-runner.ts`. Preserve continuity, minimize Claude-specific prompt surface, and prove real tool execution with a small harmless tool first. If that works, immediately expand to `exec`, then `browser`, and provide exact evidence for each. Do not assume success from prose-only answers. The final goal is full practical tool parity, not a permanent tiny allowlist. Borrow useful ideas from GlueClaw where appropriate, but do not cargo-cult its whole architecture.
