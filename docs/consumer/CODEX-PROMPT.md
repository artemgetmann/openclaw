# Codex Kickoff Prompt — OpenClaw Consumer Sprint

Copy and paste this into Codex to start execution.

---

## Prompt

We are building the OpenClaw consumer product on the `consumer` branch of this repo.

Read `CONSUMER.md` in the repo root first — it has full context on what we're building, the design philosophy, branch rules, and what's in/out of scope.

Read `docs/consumer/openclaw-consumer-execution-spec.md` for the full execution plan.

**Your job for this session is Week 1, Days 1-3: the Browser Spike.**

### What to do

We need to benchmark 4 browser automation approaches against 5 real tasks to determine which one to use as the primary browser for the consumer product. The winner becomes the foundation of the product.

**Approaches to test:**

1. Browserbase (cloud Chrome — sign up at browserbase.com if needed, check if there's an existing API key in env/config)
2. OpenClaw's built-in Chrome Extension (connects to user's real Chrome — find it in `extensions/`, test if it can be improved for reliability)
3. Computer-use vision (screenshots + clicks — OpenClaw already has this capability, test it as-is)
4. Investigate the Claude-in-Chrome MCP approach (used by Claude Code — understand how it works, see what can be adapted)

**Tasks to test each approach on:**

1. Search Google Flights for flights NYC → London in April, extract and compare top 3 results
2. Navigate to a real booking/signup form, fill it out with test data
3. Navigate to a URL, extract and summarize the content
4. Read and summarize a Twitter/X post (test this specifically — it's a differentiator vs ChatGPT)
5. Multi-step: search for something, compare 3 results, take an action (e.g., add to cart or save)

**Scoring each approach (priority order):**

1. Can it access the user's real logged-in browser sessions? (most important)
2. Speed — how long does each task take?
3. Reliability — does it complete without failure?
4. Bot protection handling — can it get past CAPTCHAs?
5. Session persistence — does login state survive between tasks?

### Output

Write your results to `docs/consumer/browser-spike-results.md` with:

- A table: each approach × each task, with pass/fail + time
- Screenshots or notes on failure modes
- A clear recommendation: which approach to use as primary, which as fallback
- Any quick wins identified (e.g., "the Chrome extension just needs X to be reliable")

### Rules

- Work on the `consumer` branch only — never commit to `main`
- Keep changes isolated to browser testing/research — don't refactor core OpenClaw code yet
- If you need to install new packages (e.g., Browserbase SDK), add them to a new `package.json` in a consumer-specific location, don't pollute the root
- Document every failure — we need the failure data, not just successes

### After the spike

Once results are documented, your next session will be Days 4-5: setting up the consumer branch to run independently as a gateway on port 19001 with the consumer runtime root.

Go.
