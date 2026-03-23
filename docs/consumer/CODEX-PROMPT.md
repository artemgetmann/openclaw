# Codex Kickoff Prompt — OpenClaw Consumer Sprint

Copy and paste this into Codex to start execution.

---

## Prompt

We are building the OpenClaw consumer product on the `consumer` branch of this repo.

Read `CONSUMER.md` in the repo root first — it has full context on what we're building, the design philosophy, branch rules, and what's in/out of scope.

Read `docs/consumer/openclaw-consumer-execution-spec.md` for the full execution plan.

**Your job for this session is to continue the consumer browser decision work without reopening already-settled debates.**

### What to do

We already have directional evidence that the cloned real-Chrome lane is the MVP winner for signed-in and hostile tasks, with the managed `openclaw` browser as the fallback. Your job is to preserve that decision, tighten the prompt/routing behavior, and avoid wasting cycles on side-lane tooling unless there is a specific unresolved gap.

**Current browser lane rule:**

1. Prefer cloned real-Chrome state for signed-in or hostile tasks.
2. Use managed `openclaw` browser for public/generic tasks or when clean isolation matters more than session reuse.
3. Do not silently switch from the cloned lane to the managed lane when that would change auth/session semantics. Surface the blocker first.

**Current benchmark set:**

1. Gmail read-first-email
2. Google Sign-In first visible decision point
3. Reddit DM/reply access
4. Emirates `DPS -> DXB` on `2026-03-22`

**What still matters:**

1. Signed-in session reuse
2. Reliability on hostile sites
3. Clear fallback behavior
4. Setup UX for non-technical users
5. Auth/session portability roadmap

### Output

Write your results to `docs/consumer/browser-spike-results.md` with:

- Updated benchmark results and failure notes
- A clear recommendation: primary lane, fallback lane, and when not to auto-fallback
- Follow-up work for auth/session portability and browser setup UX

### Rules

- Work on the `consumer` branch only — never commit to `main`
- Prefer the smallest repo surface that changes real behavior
- Browser routing guidance belongs in the browser tool / prompt seam, not a giant new prompt block
- Document every failure — failures are product evidence, not noise

### Follow-up direction

Once the lane decision is locked, the next workstreams are:

1. auth/session portability:
   - credential broker
   - login skill
   - MFA strategy
   - future 1Password integration
2. browser setup UX:
   - what to do if Chrome is missing
   - how to detect or choose the right profile without making users inspect internals
3. founder live validation:
   - end-to-end test on the main Jarvis Claw bot after the routing update lands

Go.
