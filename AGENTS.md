# OpenClaw Agent Guide

> CONSUMER PRODUCT: Read `CONSUMER.md` before starting work here.
>
> This file is intentionally lean. If a section starts turning into a playbook, move it into a focused doc and leave a pointer here.

## Default repo stance

- Treat this checkout as the consumer-product fork unless the user says otherwise.
- Do not assume upstream `openclaw/openclaw` workflow by default.
- Main/consumer consolidation has landed. New consumer-product work targets this repo's `main`.
- Do not recreate or target a `consumer` branch for new work.
- Do not target `codex/consumer-openclaw-project` for new work unless the user explicitly declares an emergency backport.
- If the user says "consumer branch", ask whether they mean the legacy fallback before doing work there.
- Never merge `upstream/main` into fork branches. Upstream intake is selective only.
- PR targets:
  - Consumer-product work: this repo's `main`
  - General fork work: this repo's `main`
  - Upstream work: `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream PR or review flow
- `consumer` and `codex/consumer-openclaw-project` are legacy/emergency fallback branches. Do not target new PRs there unless the user explicitly asks.

## Always-on rules

- Before starting any Jarvis work, read `docs/jarvis/MAINTENANCE.md`. Proceed
  only with an allowed work class, enforce its active-item and monthly limits,
  and record an accepted item with its countable receipts. If it does not fit
  the policy, stop for Artem.
- In chat replies, use repo-root-relative file references only.
- Read `SECURITY.md` before any security triage, advisory work, or severity decision.
- Read `docs/consumer/project-status.md` before high-level product, launch, pricing, reliability, scaling, or architecture decisions. If that card is stale, its numbers are not decision-grade until refreshed.
- Read `docs/jarvis/VISION.md` before product, UX, launch, pricing, onboarding, or strategy work. Do not load it for unrelated engineering tasks.
- Before Jarvis implementation or shipping, apply the Work Scope Contract in `CONSUMER.md` and state whether the work and delivery target are product-wide or Artem-specific.
- For any task that changes, fixes, or adds Jarvis behavior, follow `docs/agent-guides/jarvis-delivery-boundary.md`. Unqualified Jarvis behavior means product-wide delivery; a local-only result must be explicitly requested and can never be reported as consumer shipment.
- Source, PR, merge, generic `ship`, and `ship end-to-end` requests never authorize package, sign, notarize, or public Sparkle release work. Before a public Jarvis app release or update, obtain fresh action-time confirmation that explicitly names the public release or Sparkle update; a current request that unmistakably names that same action already satisfies this confirmation.
- Before any X/Twitter/xurl operation, read `docs/consumer/archive/jarvis-x-connector-deferred-20260725.md` and use the executable read-cost guard in `skills/xurl/SKILL.md`. Keep agent-driven access read-only. More than 10 results requires the guard's fresh exact-count and cost confirmation; raw API, streaming, MCP, pagination, writes, credentials, OAuth consent, and billing remain outside that approval and require their own explicit authority.
- For Jarvis launch docs, follow the docs operating system in `docs/jarvis/README.md`: short-lived mission trackers, max 3 Now items, max 5 open gates, and cold storage for non-blocking ideas.
- Before creating, moving, or cleaning up worktrees, read `docs/agent-guides/workflow.md`. Default workflow is now the sacred home clone `~/Programming_Projects/openclaw` on `main`; `~/Programming_Projects/openclaw-consumer` is legacy/emergency fallback only. The home clone is a pull-only runtime anchor. All implementation work happens in temporary worktrees created from the correct sacred home clone, and default task spawn should create that temp worktree immediately.
- Before changing bundled skills, repo-local `.agents/skills`, or mirrored skills, read `docs/agent-guides/skill-updates.md` and patch the owning source instead of downstream mirrors.
- Before touching gateway runtime ownership, worktree bot validation, or LaunchAgent behavior, read `docs/agent-guides/workflow.md` and `docs/agent-guides/runtime-ops.md`.
- Before package/sign/notarize/install work, shared runtime or gateway mutation, or bounded live/external acceptance, read `docs/agent-guides/fleet-resource-control.md` and lock only the named shared resource being changed. Ordinary isolated tests, typechecks, builds, dependency installation, reviews, authentication, and independent worktrees run concurrently. Locks are OS-owned; native chat identity and wakeups are never ownership or recovery mechanisms.
- For every implementation PR, follow `docs/agent-guides/workflow.md`. One primary chat owns the issue through implementation, Codex review when required, focused proof, CI, normal non-admin merge, and any already-authorized delivery. Optional nested read-only validation is useful for an immutable risky diff, but separate tester/release chats, native wake callbacks, and chat archival are never correctness requirements. Package, deploy, restart, install, shared-runtime mutation, credentials, destructive cleanup, and live/external actions retain their explicit authority boundaries.
- When the user says “Ship this PR to my main Jarvis” or equivalent, read `docs/agent-guides/runtime-ops.md`, record `exact-pr` or `current-green-main` authority at task start, and pass it explicitly with `scripts/ship-jarvis-hotfix.sh --pr <number> --main-policy <policy>` from the sacred main clone so its clean production shebang owns process startup; do not invoke it through `bash`, assemble the deployment manually, or route it through a personal/global skill.
- For consumer macOS packaging/relaunch iteration, prefer `bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance <id>` and the notes in `apps/macos/README.md` instead of rediscovering the warm-path flags by hand.
- For a sendable Jarvis DMG or app update, follow the canonical release lane in `apps/macos/README.md`; keep this file as a pointer, not the release playbook.
- Use `docs/agent-guides/workflow.md` as the source of truth for the two-clone model, migration path, feature-branch rule, and draft-PR workflow. Do not rely on memory for branch/home-clone conventions.
- Before opening or updating a PR:
  - For fork PRs targeting `artemgetmann/openclaw` `main`, read `FORK_CONTRIBUTING.md`
  - For explicit emergency backports targeting `codex/consumer-openclaw-project`, also read `FORK_CONTRIBUTING.md`
  - For upstream PRs or other targets, read `CONTRIBUTING.md`
- Read `.github/pull_request_template.md` before opening or updating a PR.
- Codex Review must answer from the diff and proof:
  - Does the PR solve one clear, observable problem?
  - Is every production change necessary for that problem?
  - Does proof cover the intended behavior and likely regression?
  - Are unrelated refactors, cleanup, abstractions, and future work excluded?
- For prompt, skill, or agent-bootstrap changes, Codex Review must also verify:
  - detailed procedures live in a focused skill or document, not the main system prompt;
  - the system prompt does not duplicate guidance supplied by an injected skill name or description;
  - any explicit skill pointer has measured evidence that description-based triggering failed and proof that the pointer fixes it.
- `FORK_CONTRIBUTING.md` owns the full review procedure and severity policy.
- Do not edit security-owned paths unless a listed owner asked for the change or is already reviewing it.
- Do not edit generated `docs/zh-CN/**` unless the user explicitly asks.
- Never edit `node_modules`.
- Never update the Carbon dependency.
- Do not patch dependencies without explicit approval.
- Before reporting a host-level blocker from a sandboxed or restricted result,
  identify whether the check depends on host-only state such as credentials or
  keyring access, network reachability, signing or trust, TCC, launchd,
  services, or listeners. A sandbox-only failure is indeterminate. Rerun only
  the smallest decisive read-only diagnostic in authorized host context before
  claiming host failure. Never automatically repeat a mutation, send, merge,
  deploy, restart, credential change, or destructive action after an ambiguous
  result; inspect state read-only, preserve its approval and expected-head
  rules, and never print tokens or secrets.
- Treat the default shared gateway service as sacred: tester/consumer/rescue runtimes must use explicit profile/config/state/port isolation instead of plain `openclaw gateway install`.
- Only replace the default shared gateway service intentionally, via `openclaw gateway install --force --allow-shared-service-takeover`.
- When adding a new `AGENTS.md`, add a sibling `CLAUDE.md` symlink to it.

## Implementation defaults

- Preserve supported behavior and backward compatibility unless the current task explicitly authorizes a breaking change. When it does, document the scope, migration path, and rollback in the PR.
- Choose the simplest implementation that fully satisfies the current requirements. Do not add speculative abstractions or compatibility shims for unsupported behavior.
- Prefer established, well-maintained libraries over custom infrastructure when they materially reduce complexity and long-term risk. Existing dependency approval, security, licensing, bundle-size, and Carbon restrictions still apply.

## Load only the docs you need

- Product context and current priorities:
  - `CONSUMER.md`
  - `docs/jarvis/README.md`
  - `docs/jarvis/VISION.md`
  - `docs/consumer/project-status.md`
  - `docs/research/jarvis-consumer-launch-plan.md`
  - `docs/consumer/jarvis-launch-package.md`
  - Historical launch/package details live under `docs/consumer/archive/`
- Branching, PR targets, commits, GitHub footguns:
  - `docs/agent-guides/workflow.md`
- Fork maintenance and upstream intake:
  - `docs/agent-guides/fork-maintenance.md`
- Build, test, style, and validation:
  - `docs/agent-guides/dev-and-test.md`
- Docs authoring, Mintlify rules, and i18n:
  - `docs/agent-guides/docs-and-content.md`
- Default local/browser/agent validation:
  - `docs/agent-guides/browser-agent-e2e.md`
- Monitor continuation recovery and regression testing:
  - `docs/agent-guides/monitor-testing.md`
- Future browser monitoring, Instagram observation, or managed observer work:
  - `docs/consumer/archive/jarvis-browser-monitoring-deferred-20260716.md`
- Skill update ownership and mirror drift:
  - `docs/agent-guides/skill-updates.md`
- Telegram-specific live checks and worktree bot setup:
  - `docs/agent-guides/telegram-live.md`
- Runtime ops, logs, timeout triage, and mac app behavior:
  - `docs/agent-guides/runtime-ops.md`
- Parallels smoke runs:
  - `docs/agent-guides/parallels-smoke.md`
- Releases, versions, and security advisories:
  - `docs/agent-guides/release-and-security.md`

## Deep references

- `docs/testing.md`
- `docs/debug/worktree-branch-survival.md`
- `scripts/telegram-e2e/README.md`
- `.agents/skills/PR_WORKFLOW.md`

## Repo-local skills

- `.agents/skills/codex-thread-control-recovery/SKILL.md`
- `.agents/skills/telegram-live-e2e/SKILL.md`
- `.agents/skills/parallels-discord-roundtrip/SKILL.md`
