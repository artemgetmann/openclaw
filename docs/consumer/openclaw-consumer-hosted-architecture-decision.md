# OpenClaw Consumer — Hosted Architecture Decision

Last updated: 2026-04-22
Status: decided

Companion document:

- `openclaw-consumer-go-to-market-plan.md` — current GTM recommendation leaning Mac-first, Telegram-first, with MacBook Neo as easiest entry and Mac mini as best serious setup.

## Decision outcome

The default consumer product remains Mac-first.

That means:

- the primary runtime lives on the user's own Mac
- Telegram remains the primary interface
- users should not have to think about VPS provisioning or runtime placement
- hosted cloud infrastructure may still appear later as an internal helper layer or separate product tier, but it is not the default consumer execution model

This resolves the main architecture decision in favor of local-first Mac execution for the consumer product.

## Purpose

This document exists to force hard decisions before implementation.

The current consumer docs still assume "your personal AI operator running on your own Mac."
The hosted consumer idea changes that shape materially:

- the always-on gateway may run on managed infrastructure
- the macOS app may become a lightweight node instead of the primary runtime
- Telegram onboarding may move from manual token copy/paste to a managed-bot flow
- support, privacy, and debugging expectations change immediately once OpenClaw runs on infrastructure we operate

The remaining sections preserve the tradeoffs and the rejected or deferred paths, but the default consumer direction is no longer open.

## Problem statement

We need one coherent product story that answers all of these at once:

- How the user gets an always-on OpenClaw without renting or managing a VPS manually
- How OpenClaw still accesses local Mac-only capabilities when needed
- How hosted support/debugging works without lying about privacy
- How self-hosted and local-first modes remain valid for users who want full control
- How coding workflows stay fluid instead of bouncing awkwardly between a Linux VPS and a MacBook

If these pieces do not fit together cleanly, the onboarding and product promise will collapse.

## Candidate product shapes considered

### Option A — Local-first Mac runtime

User runs the full gateway on their own Mac.

Pros:

- simplest trust model
- native Apple build and GUI capability
- no hosted infra required
- strongest privacy story

Cons:

- not reliably always-on
- sleep/wake becomes product debt
- harder to support from our side
- worse async agent experience

### Option B — Hosted cloud brain + local Mac node

User gets a managed per-user gateway on our infrastructure.
Their macOS app connects outbound as a node when local capabilities are needed.

Pros:

- always-on gateway and queue
- better default UX for mainstream users
- cleaner support story than DIY infrastructure
- Mac-only capabilities still possible through the node
- maps onto existing gateway/node architecture

Cons:

- requires clear privacy boundaries
- requires infra automation and per-user isolation
- requires explicit task routing between hosted and local execution
- requires a meaningful redesign of the macOS app

### Option C — Shared multi-tenant hosted gateway

Many users share one gateway/runtime surface.

Pros:

- cheapest infra on paper
- simplest first demo

Cons:

- wrong trust model for a personal operator
- bad debugging and blast-radius story
- bad per-user tooling/customization story
- conflicts with the repo's documented security assumptions

Decision:

- Option A is the default consumer product shape.
- Option B is deferred for later evaluation as an advanced or separate offering.
- Option C is rejected for consumer use.

## Current architectural constraints

These are not opinions. They are constraints.

1. Apple build/sign/package work still requires macOS.
2. A Linux VPS can do a large amount of coding work, but it cannot replace a Mac for Xcode, Simulator, signing, or true local Mac GUI control.
3. Hosted browser automation and local authenticated browser automation are different capabilities and should not be treated as interchangeable.
4. OpenClaw already has a gateway/node model; a hosted gateway plus local Mac node is compatible with the existing architecture.
5. The repo security docs do not support hostile multi-tenant operation on one shared gateway.

## Conclusions after review

### 1. Consumer default should not provision a VPS for the user

For the default consumer product, we should not start by provisioning hosted infrastructure.

Why:

- it creates an unnecessary second execution world
- it forces runtime-placement complexity into the product
- it weakens the promise that the agent works where the user's real digital life already exists

Conclusion:

- no default consumer onboarding flow should depend on renting, provisioning, or explaining a Linux VPS
- hosted mode, if it exists later, should be framed as an advanced or separate offering

### 2. Hosted mode implies operator access for support/debugging

If we run the user's gateway on our infrastructure, we need access sufficient to debug and recover it.

Why:

- without operational access, hosted support becomes fake
- users will blame the product when their gateway breaks, regardless of whose machine owns the VM
- observability, upgrades, incident response, and abuse handling require administrative access

Conclusion:

- the product must state clearly that hosted mode is managed infrastructure, not zero-knowledge private hosting
- "full privacy" users should be directed to self-hosted or local-open-source deployment
- this is one of the reasons hosted mode should not be the default consumer promise

### 3. Self-hosted remains a first-class escape hatch

Open source is not just philosophy here; it is the clean answer to the privacy/control objection.

Why:

- users who want full host privacy can run locally or on their own Mac Mini/VPS
- users who want maximum convenience can use hosted mode
- this keeps the product honest instead of trying to satisfy contradictory demands in one deployment model

Conclusion:

- hosted and self-hosted need to be framed as different modes with different trust assumptions

### 4. If hosted mode is explored later, the macOS app should become a local capability node

In hosted mode, the macOS app should stop being described as "where OpenClaw runs."
It should become "the local connector that gives your cloud agent access to this Mac when needed."

Likely responsibilities:

- permission broker
- local browser session surface
- Apple build/test/package surface
- local file/system actions inside an explicit policy
- optional later GUI automation surface

### 5. GUI/computer-use should not be a launch blocker

Hosted mode should not depend on generic full desktop automation being perfect on day one.

Why:

- it widens scope badly
- it adds failure modes and permission burden
- it is not required for the first hosted version to deliver value

Implication:

- local browser session and Apple build/test are higher priority than arbitrary desktop control

## Hosted support and privacy stance

This is the point that needs to be stated cleanly instead of danced around.

### Hosted mode

Hosted mode is a managed service.
That means:

- we provision the runtime
- we operate it
- we can inspect logs, config state, and runtime health needed to support it
- we need admin/debug access to recover broken instances

This should be framed as a product feature, not hidden:

- better reliability
- better support
- faster incident recovery

### Self-hosted mode

Self-hosted mode is the privacy/control path.
That means:

- user owns the machine/VPS
- user accepts setup and support complexity
- we do not need infrastructure access

### Open question

How far do we go in minimizing hosted support access?

Examples:

- full root/admin access to managed runtime
- restricted operator tooling with audit logs
- user-visible "support access" audit trail
- explicit break-glass support actions

This is a design choice, not just a policy note.

## Debugging model if hosted mode is revisited

If hosted mode exists, the debugging model needs to be explicit.

### Minimum hosted debugging requirements

- per-user health checks
- structured logs
- deployment/version visibility
- runtime config visibility
- queue/job status visibility
- node connectivity status
- browser/session capability status
- remote restart/redeploy controls

### Questions to decide

1. Do we allow support staff to inspect full task logs by default?
2. Do we redact prompts, tool output, or user data in hosted logs?
3. Do we expose support-access events to the user?
4. Do we provide a "privacy mode" that limits support visibility at the cost of degraded support?
5. What is the policy when a user asks us to debug a broken hosted instance but also demands zero operator visibility?

The likely honest answer to question 5 is:

- no, not in hosted mode
- they need self-hosted if that is their requirement

## Local vs hosted coding workflow problem

This is the operational friction you called out correctly.

The failure mode looks like this:

- coding work starts on the VPS
- later the task needs local browser or local GUI/computer use
- the agent now has to move context and code to the Mac
- the workflow becomes fragmented and annoying

This problem is real. It should not be minimized.

### Candidate answers

#### 1. Keep the source of truth on the hosted runtime

Mac-only tasks operate remotely against the same repo state through the node or a paired execution path.

Risk:

- may be awkward for tasks that need a true local checkout or local IDE/agent interaction

#### 2. Use Git as the explicit handoff boundary

Hosted agent commits work.
Mac-side work pulls the branch and continues there.

Pros:

- simple mental model
- durable audit trail

Cons:

- too clunky for frequent back-and-forth transitions

#### 3. Run "local capability requests" through the Mac node without moving the main coding workspace

Hosted gateway keeps the primary task state.
The Mac node only performs targeted local actions:

- browser session actions
- Xcode builds/tests
- simulator runs
- local GUI actions

Pros:

- least context switching
- best fit for hosted-first architecture

Cons:

- node API surface must be designed carefully
- local actions need good observability and return paths

Conclusion:

- the split-brain workflow cost is real enough that it should block hosted-first consumer architecture
- if hosted mode is revisited later, targeted local delegation is the only plausible default; full workspace handoff should remain exceptional

## Linux VPS vs Mac-hosted development question

This remains relevant only for future hosted tiers or internal infrastructure, not the default consumer offering.

### Linux hosted gateway

Pros:

- cheap
- standard infra
- good for generic coding/server work

Cons:

- no native Apple build path
- no native Mac GUI/computer-use path
- requires a Mac node for Apple/local-browser work

### Mac-hosted runtime (Mac Mini, Mac cloud, MacStadium-style)

Pros:

- full Apple capability on the main runtime
- better local parity for macOS/iOS dev tasks
- fewer cross-platform gaps

Cons:

- more expensive
- harder to scale
- ops complexity rises immediately

### Conclusion

- do not let this question drive the default consumer product
- if hosted offerings emerge later, they may require a tiered answer rather than one universal platform

## Computer use and local agent integration questions

These are still open and need explicit testing/research.

1. Can a hosted gateway reliably delegate targeted local browser actions to a Mac node without making the workflow feel split-brain?
2. Can a hosted gateway reliably trigger local GUI automation on the paired Mac in a way that is robust enough for product use?
3. Can the Mac node expose a stable enough surface for:
   - browser interaction
   - Xcode build/test/package
   - screen capture / GUI visibility
   - optional local CLI execution
4. If the user wants local coding-agent behavior from Codex/Claude Code specifically, do we:
   - treat that as outside hosted MVP scope
   - or add a dedicated local-agent bridge later
5. Is Peekaboo useful primarily as visibility, or as part of a complete local GUI-control stack?

## Telegram onboarding questions

These questions matter only if hosted mode becomes a real product path later.

Questions still worth deciding:

1. Is Telegram mandatory in onboarding, or can the user complete hosted setup before attaching Telegram?
2. Do we replace manual BotFather token copy/paste with the managed-bot flow for hosted users?
3. What is the fallback when Telegram setup fails but the hosted runtime is already provisioned?
4. How do we explain the relationship between:
   - the hosted gateway
   - the local Mac node
   - the user's Telegram bot

## Billing and infra questions

Questions still worth deciding:

1. Is hosted mode billed as one subscription that includes infra and model usage?
2. Do we separate infra cost from model cost?
3. What plan, if any, includes local Mac node features?
4. Do we support bring-your-own model keys in hosted mode at launch?
5. Do we support bring-your-own VPS at launch?

Conclusion:

- hosted billing and infrastructure design should not complicate the Mac-first MVP
- do not mix hosted infra economics into the default consumer launch story

## Assumptions that were broken in this review

These are the assumptions most likely to produce nonsense if we leave them vague.

1. "A Linux VPS can basically do everything if it can just SSH into a Mac."
2. "Hosted browser automation and local authenticated browser automation are close enough."
3. "Computer use can be bolted on later without affecting the architecture."
4. "Users will tolerate a split-brain workflow between hosted coding and local Mac actions."
5. "We can offer hosted support without meaningful access to hosted runtimes."
6. "A shared multi-user hosted gateway is good enough for consumer launch."
7. "Mac-hosted infrastructure is only a later optimization rather than a possible product tier."
8. "Open source self-hosted mode is enough to answer all privacy objections without changing hosted product messaging."

## Research items for later hosted exploration

These need dedicated follow-up research or spikes, not armchair answers.

1. Hosted provisioning design:
   - per-user VM vs per-user container vs per-user profile on shared host
2. Hosted debugging design:
   - support access model
   - audit trail
   - redaction policy
3. Telegram managed-bot onboarding:
   - exact UX and backend flow
4. Mac node capability matrix:
   - browser
   - Xcode
   - simulator
   - local file/exec
   - GUI visibility/control
5. Hermess / similar products:
   - hosted/runtime model
   - privacy/support stance
   - local connector story
   - whether they use managed infrastructure, local app, or both
6. Mac infrastructure economics:
   - does a Mac-hosted tier make sense for coding-heavy users

## Working decision frame

Use this frame going forward:

- default consumer product = Mac-first local runtime
- self-hosted/local = valid privacy and control path
- hosted per-user gateway = later extension, not default
- local macOS app in hosted mode = paired node, not main runtime
- shared multi-tenant gateway = out of scope
- generic full GUI/computer-use = not required for the default consumer MVP

## Resolved by this document

This document now resolves these points:

1. Default deployment model chosen
2. Hosted privacy/debugging tradeoff stated plainly
3. Shared multi-tenant gateway rejected for consumer use
4. Split-brain hosted/local workflow identified as a product-level cost, not a minor detail

Still open for later hosted exploration:

1. Hosted provisioning model
2. Hosted operator-access design
3. Mac node surface for a future hybrid offering
4. Telegram onboarding changes for a future hosted tier
5. Billing/infra ownership model for hosted offerings
