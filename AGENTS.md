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

- In chat replies, use repo-root-relative file references only.
- Read `SECURITY.md` before any security triage, advisory work, or severity decision.
- Read `docs/consumer/project-status.md` before high-level product, launch, pricing, reliability, scaling, or architecture decisions. If that card is stale, its numbers are not decision-grade until refreshed.
- Read `docs/jarvis/VISION.md` before product, UX, launch, pricing, onboarding, or strategy work. Do not load it for unrelated engineering tasks.
- Before Jarvis implementation or shipping, apply the Work Scope Contract in `CONSUMER.md` and state whether the work and delivery target are product-wide or Artem-specific.
- Before any X/Twitter/xurl operation, read `docs/consumer/archive/jarvis-x-connector-deferred-20260725.md`: keep agent-driven access read-only and at 10 results per batch; raw API, streaming, MCP, pagination, writes, credentials, OAuth consent, and billing require the explicit approval described there.
- For Jarvis launch docs, follow the docs operating system in `docs/jarvis/README.md`: short-lived mission trackers, max 3 Now items, max 5 open gates, and cold storage for non-blocking ideas.
- Before creating, moving, or cleaning up worktrees, read `docs/agent-guides/workflow.md`. Default workflow is now the sacred home clone `~/Programming_Projects/openclaw` on `main`; `~/Programming_Projects/openclaw-consumer` is legacy/emergency fallback only. The home clone is a pull-only runtime anchor. All implementation work happens in temporary worktrees created from the correct sacred home clone, and default task spawn should create that temp worktree immediately.
- Before changing bundled skills, repo-local `.agents/skills`, or mirrored skills, read `docs/agent-guides/skill-updates.md` and patch the owning source instead of downstream mirrors.
- Before touching gateway runtime ownership, worktree bot validation, or LaunchAgent behavior, read `docs/agent-guides/workflow.md` and `docs/agent-guides/runtime-ops.md`.
- Before any local command that can run longer than 30 seconds, start workers, build/package an app, run a broad test/review suite, or perform browser/GUI E2E, read `docs/agent-guides/fleet-resource-control.md` and run it through `scripts/with-heavy-local-slot.sh`. Never run more than one heavy local command across worktrees; prefer remote CI for full suites.
- For every implementation PR, follow the canonical builder -> tester -> release-worker lifecycle in `docs/agent-guides/workflow.md`. The builder owns source, review fixes, and CI readiness but never merges; the fresh user-visible release task owns the normal merge after exact-head tester `PASS`. When the user says `ship this end-to-end`, keep that lifecycle moving without returning routine coordination to the user. Package, deploy, restart, install, shared-runtime mutation, credentials, destructive cleanup, and live/external actions retain their explicit authority boundaries.
- Never use a nested sub-agent for a live/external tester or any release worker. Before either delegation—even after context compaction—run `scripts/pr-lifecycle handoff-test` or `scripts/pr-lifecycle handoff-release`, then consume its contract with a fresh user-visible project-scoped Codex task as required by `docs/agent-guides/workflow.md`.
- The Control Tower skill is an emergency-only incident playbook. Never self-elect or create a Tower/dashboard from ordinary implementation, parallel work, repo reading, open PRs, worktree count, or resource pressure. Use `.agents/skills/codex-control-tower-emergency/SKILL.md` only when the user explicitly invokes `Control Tower` or an authorized incident owner declares a fleet incident.
- When the user says “Ship this PR to my main Jarvis” or equivalent, read `docs/agent-guides/runtime-ops.md` and invoke `bash scripts/ship-jarvis-hotfix.sh --pr <number>` from the sacred main clone; do not assemble the deployment manually or route it through a personal/global skill.
- For consumer macOS packaging/relaunch iteration, prefer `bash scripts/rebuild-relaunch-consumer-mac-app.sh --instance <id>` and the notes in `apps/macos/README.md` instead of rediscovering the warm-path flags by hand.
- For a sendable Jarvis DMG or app update, follow the canonical release lane in `apps/macos/README.md`; keep this file as a pointer, not the release playbook.
- Use `docs/agent-guides/workflow.md` as the source of truth for the two-clone model, migration path, feature-branch rule, and draft-PR workflow. Do not rely on memory for branch/home-clone conventions.
- Before opening or updating a PR:
  - For fork PRs targeting `artemgetmann/openclaw` `main`, read `FORK_CONTRIBUTING.md`
  - For explicit emergency backports targeting `codex/consumer-openclaw-project`, also read `FORK_CONTRIBUTING.md`
  - For upstream PRs or other targets, read `CONTRIBUTING.md`
- Read `.github/pull_request_template.md` before opening or updating a PR.
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

- `.agents/skills/codex-control-tower-emergency/SKILL.md`
- `.agents/skills/telegram-live-e2e/SKILL.md`
- `.agents/skills/parallels-discord-roundtrip/SKILL.md`
