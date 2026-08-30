# Jarvis Maintenance Boundary

Status: active policy

Jarvis is in maintenance mode, not general product development. This policy
governs whether Jarvis work may start. It supersedes conflicting launch,
onboarding, and expansion posture in stale planning material until the startup
reactivation criteria below are met.

## Start gate

Before starting Jarvis work, classify it as exactly one of these allowed work
classes:

- serious current-user incident;
- retained compatibility blocker;
- approved portable component or evidence artifact; or
- explicitly reactivated startup work.

If the work does not fit, stop. Do not turn a maintenance request into feature
work, a broad refactor, or a comparison project. New-user onboarding is out of
scope; direct prospective new users to ChatGPT or Codex instead. Existing
active users may receive bounded compatibility or migration help. Dormant
installs do not create work obligations.

PR #1450 is closed as merged/adopted. Do not assign further work to it.

## Hard limits

- One active Jarvis engineering item at a time.
- At most two merged Jarvis PRs and one Jarvis app release per calendar month.
- Zero speculative feature PRs.
- A serious current-user incident may exceed a limit only by displacing normal
  maintenance work; record that displacement in the dashboard.

Do not begin a full rebuild, broad reliability refactor, speculative feature,
or commodity Google Drive, email, or browser comparison under this policy.
Preserve Artem's personal workspace and portable skills/tools; do not migrate
or inspect private workspace content without separately scoped approval.

Machine-specific slowdown or local-state degradation is not, by itself,
authorized maintenance work. Do not begin host or runtime diagnosis for it.
Reopen diagnosis only when a retained workflow remains blocked after migration
alternatives are considered, or when multiple current active users reproduce
the problem.

## Startup reactivation

Startup work becomes eligible only when all of the following evidence exists:

1. Five independent paying accounts.
2. Four accounts using the same workflow weekly for six weeks.
3. At least 80% workflow completion without Artem rescue.
4. Support and maintenance are below 25% of product time.

These are decision criteria, not claims that the conditions currently hold.
`docs/consumer/project-status.md` is stale and must not be used as current
activity, paying-user, launch, resourcing, reliability, scaling, or architecture
evidence until its declared source is refreshed.

## Maintenance dashboard

Use a committed dashboard entry for each accepted item. It records countable
receipts, not estimated founder hours. Do not derive a fake time budget from
this table.

| Date       | Task                               | Class                         | Affected active user      | PR               | App release       | Founder decisions or approvals | Manual rescues | Result                | Displaced work   |
| ---------- | ---------------------------------- | ----------------------------- | ------------------------- | ---------------- | ----------------- | ------------------------------ | -------------- | --------------------- | ---------------- |
| 2026-08-18 | Enforce bounded X API reads        | serious current-user incident | 1                         | #1468            | none              | 1: approved spend-control fix  | 1              | Source guard merged   | none             |
| 2026-08-18 | Restore voice transcription        | serious current-user incident | 1                         | #1469            | none              | 1: approved transcription fix  | 1              | Source fix CI pending | none             |
| 2026-08-27 | Pair GoPlaces runtime state        | serious current-user incident | 1                         | none             | none              | 1: approved root-cause fix     | 1              | Source fix verified   | Next normal item |
| 2026-08-29 | Preserve agent message line breaks | serious current-user incident | 1                         | none             | none              | 1: approved cross-channel fix  | 1              | Source fix verified   | Next normal item |
| 2026-08-29 | Avoid duplicate restart approval   | serious current-user incident | 1                         | #1473            | none              | 2: approved fix and correction | 1              | Behavior reverted     | Next normal item |
| 2026-08-30 | Disable unsafe Apple Notes writes  | serious current-user incident | 1                         | none             | none              | 1: approved capability removal | 1              | Source PR in progress | Next normal item |
| YYYY-MM-DD | Short observable task              | One allowed class             | Anonymous count or `none` | `#123` or `none` | Version or `none` | Count and short receipt        | Count          | Closed result         | Task or `none`   |

Rules for the fields:

- `Affected active user` is an anonymous count; never add names or private data.
- `Founder decisions or approvals` is a count plus a short, non-sensitive
  receipt such as `1: approved compatibility fix`.
- `Manual rescues` is a count of times Artem had to complete or recover the
  user workflow. `0` is meaningful; unknown is `unknown`.
- `PR` and `App release` stay `none` until merged or released. A draft PR is
  not a merged-PR receipt.
- `Result` states the observed maintenance outcome or the remaining blocker.

Keep the table short: the current calendar month plus a compact monthly totals
row is enough. Archive old rows with normal product documentation when they no
longer affect the active maintenance decision.

## Scope and delivery

This is a product-wide, source-only repository policy. It does not authorize a
package, install, runtime change, release, external message, or private-workspace
access. The normal Jarvis delivery boundary still applies to behavior changes.

Rollback is a source revert of this policy and its entry-point pointers.
