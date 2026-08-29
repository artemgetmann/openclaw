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
product-wide behavior targets `source`. Classification remains product-wide;
the source default changes only the authorized delivery and proof boundary.

## Choose the proof boundary from the failure surface

Use the lowest proof layer that can close the reported problem. Do not require
installed-runtime or live-channel proof merely because a change mentions
Jarvis.

- A bug observed on Artem's main Jarvis targets `installed-runtime` by default.
  It is complete only after the fix is merged, the main runtime reports the
  expected commit, and one smallest symptom-specific acceptance passes.
- Internal agent workflow, repository policy, documentation, CI, test
  infrastructure, and behavior-neutral refactors target `source` unless the
  user explicitly requests a later boundary. Main-Jarvis deployment adds no
  useful proof for these changes.
- Behavior that needs a running gateway, provider, or channel but not Artem's
  personal production state should first use an isolated runtime. Isolated
  proof is sufficient when the original acceptance surface is isolated; it
  does not close a bug originally observed on main Jarvis until that installed
  runtime adopts the fix.
- Packaging, runtime seeding, signing, installation, update, or migration work
  requires the matching package/install/upgrade proof. Main-Jarvis proof alone
  does not prove a public release.

Keep acceptance narrow. Test only the changed or originally failing behavior,
once, after lower proof layers pass. Do not add broad Telegram, browser,
permissions, restart, or provider scenarios unless those surfaces changed or
the focused scenario depends on them.

Authorization comes from the user's requested action, not from this
classification. Generic `ship` or `ship end-to-end` language authorizes the
source lifecycle through focused proof, PR, and normal merge; it does not
authorize package, sign, notarize, install, deploy, restart, live traffic, or
public release work.
`Fix this on my Jarvis`, `ship this to my main Jarvis`, or equivalent language
that explicitly names the installed target authorizes the canonical deployment,
one targeted acceptance, and exact cleanup. The product default still asks for
restart confirmation. When the owner explicitly configures
`commands.restartConfirmation: false`, the same installed-runtime authority also
includes its documented gateway restart without a second approval turn.
`Investigate`, `review`, or `make a PR` does not authorize deployment, restart,
live traffic, or cleanup.
If main acceptance is required but not authorized, finish safe source work and
stop at `blocked-at-boundary` with the missing actions named; do not silently
downgrade the target to source.

A public Jarvis app release or Sparkle update requires fresh action-time
confirmation that clearly names that public-release action. A current request
that unmistakably and explicitly asks for that same public release or Sparkle
update satisfies the confirmation; source, PR, merge, generic `ship`, and
generic end-to-end language do not.

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

## Closeout and archive labels

Begin the final closeout with exactly one plain-language status that matches the
receipt:

- `SOURCE COMPLETE — MAIN JARVIS NOT REQUIRED`
- `BLOCKED — NOT YET ON MAIN JARVIS`
- `COMPLETE — ON MAIN JARVIS, TARGETED TEST PASSED`
- `PUBLICLY RELEASED`

A main-Jarvis incident is not fully closed and must not be described as safe to
archive while installed adoption or its targeted acceptance remains pending.
Source-only work may be archived when its declared source boundary is complete,
but the closeout must make the absence or non-requirement of deployment
unmistakable. Archive state is housekeeping, never delivery proof.

## Commands and enforcement

Generate a PR block:

```bash
scripts/jarvis-delivery-boundary example \
  --work-scope product-wide \
  --delivery-target source
```

Validate a standalone receipt before closeout:

```bash
scripts/jarvis-delivery-boundary validate-receipt \
  --receipt .local/jarvis-delivery-receipt.json \
  --stage closeout
```

The PR template is the durable receipt surface. CI validates classification for
Jarvis-named PRs and direct consumer-app/product paths. The validator
implementation in `scripts/lib/jarvis-delivery-boundary.mjs` is the canonical
machine-readable policy consumed by every enforcement point.

Rollback is one source revert of the CI, template, and instruction pointers.
Existing product or runtime state is not mutated by this contract.
