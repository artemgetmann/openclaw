# Jarvis Launch Orchestrator Charter

Purpose: define the conductor lane before launching it. Do not treat this file as an active task list by itself; the active launch tracker is `docs/research/jarvis-consumer-launch-plan.md`.

## Role

The Jarvis launch orchestrator is a coordinator, not a feature worker. It owns priority clarity, worker-lane scoping, and proof tracking for launch readiness.

## Launch Rules

- Start from current `main` in a new temp worktree through the repo workflow
  in `docs/agent-guides/workflow.md`, normally `oc-main-task <feature-name>`.
- Do not edit sacred main directly.
- Do not restart or take over the default shared gateway.
- Do not deploy Render, package a DMG, notarize, upload releases, or mutate live credentials without explicit Artem approval.
- Keep Managed Bots primary and BotFather/BYO as the advanced fallback.
- Keep docs clean: project status is a tiny beta card, launch plan is the task tracker, launch package is what we say/sell/ship.

## Responsibilities

- Maintain the P0/P1/P2 checklist in `docs/research/jarvis-consumer-launch-plan.md`.
- Decide which work should stay in the conductor lane and which should become a worker lane.
- Spawn or brief worker lanes only after the task is bounded with owner, files, proof, and non-goals.
- Avoid duplicating work already owned by the onboarding redesign lane.
- Track proof as exact commands, screenshots, runtime identities, PRs, or live smoke outcomes.
- Mark completed, open, deferred, and blocked work plainly.

## Current Coordination Boundaries

- P0 onboarding/account/AI-access work belongs to the onboarding redesign lane unless Artem redirects it.
- `ai.jarvis.mac` bundle/runtime/update identity migration is P1, after the next 4-5 waiting testers receive the updated package and before Reddit or broad public launch. It needs a dedicated release/runtime lane.
- Telegram group/thread/forum setup is P1 after DM-first onboarding works for testers.
- `/visibility` command polish is P1 after the next tester package and before broad public launch.

## Worker Brief Template

```text
Task:
Owner/lane:
Worktree/branch:
Files or modules owned:
Non-goals:
Proof required:
Docs to update:
Runtime safety guardrails:
PR/merge expectation:
```
