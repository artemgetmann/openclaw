# Jarvis Delivery Boundary

Use this contract for every task that changes, fixes, or adds Jarvis behavior.
Its job is simple: make the delivery surface explicit and make inflated
completion claims fail before testing or release ownership begins.

## Classification

Classify once in the plan, carry the same classification into the PR receipt,
and update only proof status as work advances:

- `artem-specific`: explicit personal, local, private, or one-Mac behavior.
- `product-wide`: behavior intended for Jarvis users generally.

An unqualified Jarvis behavior request is product-wide. Explicit `my Jarvis`,
`local`, `on this Mac`, or private customization is Artem-specific unless the
same request also names users, product delivery, packaging, or release. When a
request deliberately includes both, use product-wide and record any local/live
proof as a separate authorized layer; do not downgrade the product target.

Choose the requested delivery boundary: `local-only`, `source`, `package`,
`installed-runtime`, or `public-release`. If no boundary is stated,
product-wide behavior targets `public-release`; a request explicitly limited to
source or a PR may target `source`.

Classification does not need approval. Reversible source work proceeds in the
normal isolated worktree. Return only at a real credential, destructive
migration, live/shared-runtime, signing/notarization, or publication boundary.

## Proof layers

Each receipt records every layer as `pending`, `proven`, or `not-applicable`,
with one short evidence or rationale string:

| Layer                | What it proves                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `localConfiguration` | A personal/home customization exists. It proves no product delivery.                                                             |
| `source`             | The exact repository candidate and focused tests implement the behavior. Merge ancestry remains a separate PR lifecycle receipt. |
| `packagedArtifact`   | The exact app/package contains the candidate.                                                                                    |
| `installedRuntime`   | An isolated or explicitly authorized installed app/runtime adopted it.                                                           |
| `upgradeMigration`   | Existing-user state upgrades safely. Use `upgradeImpact=required` when compatibility or migration is affected.                   |
| `publicRelease`      | The signed/notarized/published update is actually available.                                                                     |
| `endUserBehavior`    | The shipped build demonstrates the promised behavior.                                                                            |

The installed consumer runtime is app-owned under
`~/Library/Application Support/Jarvis/.jarvis`. A home-directory edit, source
merge, package build, installed runtime, upgrade migration, and public release
are different receipts.

## Completion claims

- `in-progress`: classification is valid, but the task is not ready for worker
  handoff or closeout.
- `local-only-complete`: valid only for an Artem-specific `local-only` target
  with proven local evidence. Closeout must say it was not shipped to users.
- `declared-boundary-complete`: the explicitly requested source, package, or
  installed boundary is proven. It does not mean consumer shipment.
- `blocked-at-boundary`: reversible work is complete but at least one required
  target layer remains pending. Name the exact remaining boundary and authority.
- `consumer-delivered`: valid only for a product-wide public-release target with
  source, package, installed runtime, applicable migration, public release, and
  end-user behavior proven.

Local experiments graduate by opening product-wide work with a new receipt.
The local evidence may be referenced as discovery input, but it cannot be
relabelled as source, package, migration, release, or end-user proof.

## Commands and enforcement

Generate a PR block:

```bash
scripts/jarvis-delivery-boundary example \
  --work-scope product-wide \
  --delivery-target public-release
```

Validate a standalone receipt before closeout:

```bash
scripts/jarvis-delivery-boundary validate-receipt \
  --receipt .local/jarvis-delivery-receipt.json \
  --stage closeout
```

The PR template is the durable receipt surface. CI validates classification for
Jarvis-named PRs and direct consumer-app/product paths. `scripts/pr-lifecycle`
revalidates the same receipt at handoff and requires proven product source plus
a truthful non-progress completion claim. The release packet carries the PR
title/body claim surface as well as changed paths, so the independent release
queue can recompute classification and reject an omitted or inflated receipt.
The validator implementation in `scripts/lib/jarvis-delivery-boundary.mjs` is
the canonical machine-readable policy consumed by every enforcement point.

Rollback is one source revert: remove the CI job and lifecycle import together,
then revert the template/instruction pointers. Existing product or runtime state
is not mutated by this contract.
