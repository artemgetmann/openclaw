# Workflow

## Branch and PR targets

- Default to this fork, not upstream.
- Consumer-product work targets this repo's `main`.
- General fork work also targets this repo's `main`.
- Use upstream `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream review, triage, or PR flow.
- `consumer` is legacy. Do not target new PRs there unless the user explicitly asks.
- `codex/consumer-openclaw-project` is legacy/emergency fallback. Do not target new PRs there unless the user explicitly declares an emergency backport.
- Do not recreate `consumer` for new work.
- If the user says "consumer branch", clarify whether they mean the legacy fallback before doing work there.
- Never run `git merge upstream/main` on this fork. Port upstream changes selectively via `main`.
- Normal scoped implementation defaults to a merged PR completed through the
  canonical worker lifecycle below. Follow [docs/ci](/ci) for required checks
  and merge mechanics. Package, deployment, restart, and product release remain
  separate actions that require their own authority.

## Canonical PR worker lifecycle

Apply the Work Scope Contract in `CONSUMER.md` before entering this lifecycle.
Source merge is not runtime or product-release proof.

Every implementation PR uses this ownership flow:

`builder -> independent tester -> release worker`

This guide is the policy source. The PR template is its durable receipt surface.
The workers coordinate directly; routine PRs do not need a permanent
dispatcher, coordinator, queue service, or Control Tower.

Worker transport is part of the ownership contract:

- The builder is always a user-visible, project-scoped Codex task.
- A fresh nested read-only sub-agent may test only when every condition is true:
  the validation is short-lived and deterministic; the head is immutable; no
  protected resource, external side effect, durable ownership, cleanup duty,
  long wait, or user decision is possible; and an independently addressable
  transcript is unnecessary. Record its exact agent identity and terminal
  receipt, then resolve it before creating another owner. Nested agents do not
  expose a separate user-visible thread to archive; their terminal exact-identity
  receipt is the lifecycle closure and must not be described as thread archival.
- Use one fresh user-visible project-scoped tester task whenever testing performs
  or may perform end-to-end or live acceptance, Telegram sends or creation of a
  topic, message, or session, runtime/provider/backend ownership or mutation,
  GUI or Computer Use, credential access, external-service access, protected
  machine-resource use, cleanup, a long-running wait, a direct user decision or
  approval, or any result needing a durable independently addressable transcript.
  Record its exact task and host identity, then archive that exact task only
  after its terminal receipt is recorded.
- The release worker is always one fresh user-visible project-scoped Codex task,
  never a nested sub-agent. A default-branch write and any just-in-time approval
  must remain visible in that worker's own transcript. The worker must also be
  independently addressable so it can archive or, for a concrete repair, revive
  the exact builder task.

Transport selection is executable, not a memory decision. Immediately before
tester or release delegation—including after context compaction—the builder
must invoke the matching `scripts/pr-lifecycle handoff-test` or
`scripts/pr-lifecycle handoff-release` command. Do not call `spawn_agent` first
and backfill the receipt later.

The command cannot create a native Codex task from a shell. It therefore makes
the transition a mandatory two-step gate:

1. The command validates the current GitHub PR/head/diff and existing owner
   state, reserves one pending handoff, and emits a machine-readable contract.
2. Only when that contract says `action=create_thread`, the native agent calls
   `list_projects` then `create_thread`, and immediately records the exact
   returned thread and host with `accept-test-owner` or
   `accept-release-owner`.

Recording a release owner is not permission to begin release work. The fresh
release task first archives the exact builder, verifies `archived=true`, and
records that receipt with `accept-release-handoff`. Only the resulting
`release-handoff-accepted` transition opens review, merge, or already-authorized
deployment work.

Re-running a pending or active handoff returns `action=do-not-create`; it never
authorizes a replacement owner. If native task creation definitely failed, use
`cancel-pending --confirm-no-thread-created` only after proving no task was
created. Ambiguous creation fails closed. The command stores local transition
state under ignored `.local/pr-lifecycle/`; the PR contract remains the durable
cross-task receipt surface.
The wrapper first runs the canonical secret-silent GitHub preflight. A
restricted `status=indeterminate` result requires the same read-only lifecycle
command to be rerun in authorized host context; it is not proof that the PR or
GitHub authentication is unavailable.

### 1. Builder owns the candidate

The builder owns implementation in its isolated worktree, focused local proof,
PR creation and updates, review-fix iterations, and required CI readiness. The
builder keeps going through ordinary review findings, CI failures, and safe base
refreshes. It never merges its own PR and never deploys.

When the candidate is ready, the builder records the immutable PR number and
URL, head SHA, base branch and SHA, diff identity and changed paths, observable
claim and fixed acceptance criteria, completed proof, relevant checks, known
risks, and remaining proof. It invokes `scripts/pr-lifecycle handoff-test` so
the command confirms that no tester already owns that candidate, then consumes
the emitted transport contract exactly once.
The handoff contract records `dispatcher.role=builder` plus the structured
nested-eligibility or user-visible-routing rationale. This is receipt data, not
an inference from the worker name. A release worker rejects a tester receipt
that omits or changes either field.

### 2. One independent tester validates one immutable head

The tester checks out and verifies the assigned head before testing. It tries to
falsify the fixed acceptance criteria on that exact head, including the smallest
relevant edge path. It does not change implementation code, relax criteria,
expand scope, merge, deploy, or claim proof for another head. It reports one
terminal `PASS` or `FAIL` receipt with its exact worker identity, tested head and
diff identity, the unchanged dispatcher/routing object, evidence, cleanup state,
and unresolved limitations.

The lifecycle diff fingerprint is SHA-256 over the exact raw stdout bytes from
`gh pr diff <PR> --patch`. A plain `gh pr diff` renders a different format and
must not be used to recompute candidate identity. The emitted tester prompt
records this algorithm so independent validation fails closed for real drift,
not a formatting mismatch.

A user-visible live tester additionally proves exact immutable source and
runtime provenance, uses stable isolated identities, and runs exactly one bounded
scenario when the acceptance contract says one. Its handoff must grant the exact
external actions before they occur. It returns exact cleanup receipts and direct
material callbacks; it does not retry after ambiguity, failure, refusal, or an
uncertain side effect unless fresh authority explicitly permits a new attempt.
Keep source, merged, package, installed, runtime/provider, GUI, and live-behavior
proof as separate claims.

The builder records the terminal receipt before resolving the exact tester. For
a user-visible tester it then archives that exact task; for a nested tester it
records the exact terminal agent closure. It archives nothing if the tester
identity is ambiguous or the receipt is incomplete. A `FAIL` returns source
ownership to the builder. Any behavior-bearing repair, conflict resolution,
rebase, or other head change makes prior tester proof stale; the builder repeats
affected proof and creates exactly one fresh tester for the new immutable head.
There is never more than one active tester owner for a PR candidate.

Mechanically, feed the terminal JSON to
`scripts/pr-lifecycle record-test-receipt`, perform the exact native archival
or nested-agent resolution it returns, then run `close-test` with the same
identity. `handoff-release` refuses a stale, failed, incomplete, or unclosed
tester receipt.

A capacity guard refusal before workload start is not source proof and is not a
generic retry license. After the failed user-visible tester is archived, the
same builder may pass its exact contract plus a typed capacity-owner recovery
receipt to `handoff-test --capacity-retry-contract ...
--capacity-recovery-receipt ...`. The receipt must bind that closed `FAIL`,
record `workloadStarted=false`, prove the recovered disk floor and empty
heavy/release lock directories, and preserve the same immutable candidate and
test contract. The command moves the failed tester unchanged into the attempt
ledger and atomically reserves exactly one fresh tester. Repeating the command
returns the existing reservation; a source failure, completed workload, missing
archive, insufficient capacity, occupied lock, release owner, or different
candidate fails closed.

### 3. One release worker owns merge

Only after a terminal tester `PASS` is recorded and the exact tester lifecycle
is closed does the builder confirm that no release worker already owns the PR.
The builder invokes `scripts/pr-lifecycle handoff-release`; only its first
`action=create_thread` contract may create exactly one fresh user-visible
project-scoped release worker. The contract supplies the immutable PR, head,
base, diff, builder identity, tester
receipt, cleanup receipt, review/check state, dependencies and overlap, risks,
rollback, remaining proof, and the validated task-authority packet. Builders
and testers never merge or deploy.

Release-task model selection is risk-based and executable:

- For `normal-merge` authority only, `handoff-release` emits
  `model=gpt-5.6-luna` and `thinking=max`. Use those exact `create_thread`
  settings for the fresh release task. Immutable-head tester proof has already
  removed the difficult source-discovery work; the remaining job is bounded
  review, CI monitoring, expected-head merge, and receipts.
- If the validated authority packet includes `deploy`, it emits
  `model=gpt-5.6-terra` and `thinking=high` because the task may cross into live
  state. This changes compute selection, not authority: every deployment,
  restart, install, runtime mutation, or external proof boundary still applies.
- Luna or Terra must fail closed and return the exact finding when source repair,
  a real merge conflict, changed behavior, unclear production state, security
  judgment, or an unmodeled irreversible action appears. Resume the exact
  builder for source work. Escalate the same release task to Sol only when the
  concrete finding needs stronger reasoning; never create a recursive release
  worker or a second owner.

The emitted model profile is the default for that handoff, not evidence that a
model completed the work safely. The release receipt and independent state
checks remain the proof.

The release worker independently refreshes and verifies the PR head, current
base, effective diff, required checks, review conversations, approvals,
dependencies, and overlap. It may perform only a normal non-admin merge: no
bypass, admin override, force, or weakened branch protection. If the reviewed
head or diff changed, proof is stale, approval is missing, checks are not green,
or the PR cannot merge normally, it does not merge.

`handoff-release` refreshes the PR body and acceptance receipt after tester
closure, even when the immutable head, base, and diff are unchanged. The fresh
release prompt must not embed the pre-test PR contract or stale pending fields.
The same refresh applies when a definitely uncreated tester reservation is
cancelled and recreated on the unchanged source candidate.

Before that review begins, the release worker proves its recorded thread and
host identity, archives the exact builder task, verifies `archived=true`, and
runs `accept-release-handoff` with both exact identities. The transition is
idempotent [safe to retry] for the same receipt and fails closed for adjacent
tasks or incomplete archival. The builder therefore leaves the active Codex
task list at accepted handoff, not after merge.

Behavior-bearing repair belongs to the builder. When a concrete release
discrepancy requires source repair, the release worker may unarchive and steer
only the exact builder thread, then waits for a new builder packet and fresh
tester validation for the changed head. It must not create a duplicate builder,
tester, or release owner.

Mechanically, the release worker verifies `archived=false`, records the exact
finding and identities with `return-source`, sends that finding to the same
builder, and pauses. The transition is idempotent for the same finding. A
different finding or identity fails closed instead of silently widening the
repair. `handoff-test --returning-release-contract` is legal only after this
source-return receipt.

For that repair loop, the builder passes the exact active release contract to
`handoff-test --returning-release-contract`. After the repaired head receives a
fresh tester receipt and closure, `handoff-release` emits
`action=resume-thread` for the already-recorded release task; it never emits a
second `create_thread` action. The resumed release owner re-archives the same
builder and records a fresh `accept-release-handoff` receipt before continuing.
If a tester finds another source defect before release resumes, the same builder
may repeat this cycle from `awaiting-retest` with that exact release contract and
a closed tester. Every retired candidate stays in lifecycle history; tester and
release identities are never reused or duplicated.

If main advances again after a tester reservation was definitely cancelled
before owner creation, the same accepted release contract may return source from
`awaiting-retest` and replace that candidate. This exception requires the exact
release and builder identities, the original builder-archive proof, and an
ownerless `cancelled` tester record; any live, owned, or ambiguous tester still
fails closed.

After a successful merge, the release worker records and sends the merge receipt.
The builder was already archived at accepted handoff. The receipt proves the
reviewed head tree equals the landed merge tree and that the merge commit is an
ancestor of the refreshed target branch. It reports merged-source truth
separately from any package, installed runtime, provider/backend, GUI, or
real-user proof.

### 4. Identity and lifecycle failures fail closed

Thread creation, exact identity resolution, approval, handoff, archival, and
unarchival are lifecycle gates. If a gate fails, preserve the one known owner,
archive nothing adjacent, report the exact missing capability or receipt, and
stop at that boundary. Never infer ownership from a title, nearby thread,
parent relay, or stale receipt. Do not create a replacement while an existing
owner may still be live.

This lifecycle does not alter the machine-wide heavy-capacity contract. Tester
identity isolates state; it does not allocate CPU, memory, disk, ports, provider
determinism, packaging, or runtime capacity. All guarded work still follows
`docs/agent-guides/fleet-resource-control.md`.

### 5. Restricted results do not prove host failure

Before reporting a blocker, identify whether the failed check depends on state
that a restricted process may not share with the host: credentials or keyring,
network, signing or trust, TCC, launchd, services, listeners, or similar
machine-owned state. A restricted-only failure is indeterminate. Rerun only the
smallest decisive read-only diagnostic in authorized host context. Do not move
an arbitrary command outside the sandbox merely because it failed there.

For GitHub, `gh auth status` is not decisive because it reads local credential
metadata without proving authenticated API access. Use the secret-silent API
probe:

```bash
scripts/github-auth-preflight.sh --context restricted
```

If it returns `status=indeterminate`, rerun that exact read-only probe with
`--context host` in authorized host context, or confirm an authenticated GitHub
connector. The repository cannot self-elevate and shell scripts cannot invoke a
connector. A host probe failure is a real blocker; do not log out, log in,
modify keyring state, or print tokens as recovery theater.

Choose exactly one mutation transport before any PR change: authorized host
`gh`, or an authenticated GitHub connector that supports expected-head
protection. A connector is not an admin, bypass, or permission-escalation path.
Never use both transports for one mutation. Bind merges and auto-merge requests
to the immutable expected head. If any mutation, send, merge, deploy, restart,
credential change, or destructive action returns ambiguously, inspect state
read-only and stop; never blindly retry it. A new attempt requires a confirmed
unchanged state plus the original approval and idempotency contract.

### Reusable handoff and receipt contract

Use these fields in the PR contract and worker prompts. Values are immutable for
one candidate; a changed head requires a new packet and fresh tester receipt.

```text
PR: <number + URL>
Head: <full SHA>
Base: <branch + full SHA>
Diff: <fingerprint + changed paths>
Owner: <role + exact thread ID + host ID when required>
Claim / acceptance: <fixed observable claim + criteria>
Proof: <commands, checks, review state, evidence links>
Tester: <transport + PASS|FAIL + exact head/diff + receipt + lifecycle closure>
Dependencies / overlap: <none or exact refs + merge order>
Risk / rollback / remaining proof: <explicit source and post-merge boundaries>
Authority: <typed direct-user-task packet; exact allowed actions, scope, and constraints>
```

The release-acceptance receipt adds the exact release identity and builder
`archived=true` proof. The release receipt adds the refreshed base, effective
diff, final checks and reviews, merge method and commit,
reviewed-head-tree/landed-tree equality, target-branch ancestry proof, and any
source-return/re-acceptance receipts.

### “Ship end-to-end” authority

When the owner says `ship this end-to-end`, the builder and release worker keep
the scoped source change moving through this complete lifecycle without handing
routine coordination back to the founder. Routine review, ordinary `main`
drift, a safe rebase, pending CI, or a draft PR are continuation states.

`Ship end-to-end` authorizes the normal source/PR/merge lifecycle. It does not by
itself authorize new scope, destructive cleanup, credentials, irreversible or
external actions, security-owned changes, or protected live actions. Package,
product release, deploy, restart, install, shared-runtime mutation, and live
acceptance require explicit task authority or later approval.

When a direct user task explicitly grants normal merge or deployment authority,
the builder preserves it in the typed release packet with source, exact scope,
allowed actions, and constraints. Routine CI, review, safe rebase, and capacity
continuation do not ask the user to repeat that authority. The packet may carry
only `normal-merge` and an explicitly granted `deploy`; it never invents
credentials, OTP, admin/bypass, irreversible or public-release actions, or new
scope. A later direct hold or narrower instruction still wins.

Worktrees isolate branch and filesystem state; they do not prevent two branches
from changing the same contract incompatibly. Before starting or resuming work
on a high-churn shared surface, refresh `origin/main` and inspect overlapping
open-PR paths plus active same-repo lanes when that inventory exists. Recheck
`main` before every material PR update. If another change landed, rebase and
preserve both intended behaviors instead of blindly choosing one conflict
side, then rerun the focused proof for both affected contracts.

If a safe merge helper reports `BEHIND`, refresh and continue. If it reports a
real conflict, resolve only in-scope conflicts and repeat affected proof. Stop
only when resolution changes intended behavior or ownership, another live
owner overlaps the same source/state, a protected action lacks authority, or a
claimed guarantee cannot be proven mechanically.

## Two-clone default

- Default model:
  - `~/Programming_Projects/openclaw` is the sacred source-control and break-glass runtime anchor for fork `main`
  - `~/Programming_Projects/openclaw-consumer` is legacy/emergency fallback only
- Those sacred home clones replace durable worktrees as the default branch homes.
- Sacred home clones are pull-only runtime anchors:
  - they stay on their base branch
  - `~/Programming_Projects/openclaw` is the approved source checkout for new temp worktrees
  - agents do not do feature work directly in either sacred home clone, even on a feature branch
- Direct commits stay blocked on the protected base branches:
  - `main`
  - `codex/consumer-openclaw-project`
- Checkout-level enforcement is also in place:
  - `git-hooks/pre-commit` and `scripts/committer` reject commits from either sacred home clone regardless of branch name
  - `scripts/new-worktree.sh` only runs from a sacred home clone, and it requires that sacred home clone to be clean and on its base branch
- The only bypass is an explicit break-glass runtime hotfix from the sacred home clone's base branch:
  - `OPENCLAW_ALLOW_SACRED_HOME_HOTFIX=1`
  - use this only when the runtime is broken badly enough that creating a temp worktree first would slow recovery
- Open a draft PR once the first coherent slice exists. Validation can happen after the draft PR is open.
- Mark the PR ready only after validation is complete.
- Merge only when the task and repo policy allow it.

## Daily Jarvis and shared developer runtime rules

- Artem's daily Jarvis must run as `ai.jarvis.gateway` from the package-seeded
  runtime under `~/Library/Application Support/Jarvis/.jarvis`. This managed
  package lane is the founder-dogfood steady state.
- `ai.openclaw.gateway` from `~/Programming_Projects/openclaw` is the shared
  developer/source-checkout lane. The sacred clone remains its canonical owner,
  but this service is not the normal daily Jarvis runtime.
- Feature worktrees must not own or boot the default shared runtime, even temporarily.
- If you need to test unmerged code against Telegram/WhatsApp, use one of these paths:
  - isolated tester bot/runtime with explicit profile or config isolation
  - merge to `main`, fast-forward the sacred home clone, then restart the shared
    developer runtime from there
- Using sacred `main` to hotfix the daily `ai.jarvis.gateway` payload is an
  explicit break-glass action. It must remain visibly distinct from
  `jarvis-managed-bundle` package provenance and be replaced by a package-seeded
  runtime after the incident.
- Do not treat "the gateway happens to be pointing at my worktree right now" as acceptable state. That is runtime ownership drift, not a testing strategy.
- Verify who owns the running gateway before any live test:
  - `pnpm openclaw gateway status`
  - check the `Runtime ID:` line for `branch=...` and `worktree=...`
  - if the shared runtime points at a feature worktree, stop and move it back to the sacred home clone on `main`
- For browser, agent, TUI, and Telegram proof sequencing, use
  `docs/agent-guides/browser-agent-e2e.md`. In short: raw browser CLI proves
  browser control, agent/TUI proves gateway agent behavior, and Telegram proves
  user-visible Telegram product behavior.

## Home clone entry

- Source the helper once in your shell rc:
  - `source /Users/user/Programming_Projects/openclaw/scripts/shell-helpers/home-clone-helpers.sh`
- Then use:
  - `oc-main`
  - `oc-main-task <feature-name>`
  - `oc-consumer` / `oc-consumer-task <feature-name>` only for explicit
    legacy/emergency fallback work
- Those wrappers:
  - enter the correct sacred home clone
  - require the clone to already be on its base branch
  - require a clean worktree so `git pull --ff-only` is honest
  - fast-forward from `origin/<base>` before you start work
  - let the `*-task` wrapper create a temp worktree from the correct sacred home clone automatically
  - refuse handoff unless the new lane proves local readiness inside that worktree
- If a helper refuses entry, fix the clone first instead of forcing around it. The point is to keep base-branch truth boring.

## Daily agent sequence

1. Start normal work with `oc-main-task <feature-name>`.
2. Use `oc-consumer-task` only for explicit emergency fallback/backport work.
3. Let that wrapper fast-forward the correct sacred home clone, create the temp worktree, and drop you into it.
4. Code inside that temp worktree only.
5. Before changing skills, read `docs/agent-guides/skill-updates.md` and patch the owning source instead of mirrored copies.
6. Open or update a draft PR early.
7. Validate in the temp worktree.
8. Mark the PR ready when validation is complete.
9. Keep ownership while the PR is draft, waiting for review, waiting for CI, or
   refreshing after ordinary base drift. Give a next-step handoff only at a
   genuine stop boundary or final closeout.
10. Complete the independent tester gate, then hand the immutable receipt to one
    fresh user-visible release worker. Only that worker may merge under
    [the PR merge policy](/ci); otherwise it stops and reports the blocker.
11. If the merged change needs live runtime behavior, choose the lane explicitly:
    keep daily Jarvis on the managed package/app-support runtime; use sacred
    `main` for the shared developer service or an approved break-glass hotfix
    only. Prove runtime provenance separately from PR merge state.
12. Remove the merged temp worktree with `bash scripts/gc-worktrees.sh --auto --base-branch <base>` or let the scheduled GC clean it up.
13. If the heavy wrapper emitted `HEAVY_LOCAL_DISK_RECEIPT`, include it in the
    handoff. Preserve outputs still needed by an unmerged PR or release; once
    the branch is recoverable and the lane is inactive, reclaim the owning
    temporary worktree through the repository GC instead of leaving another
    dependency/build footprint behind.
14. Keep the sacred home clone on its base branch and fast-forward it again before the next task.

## Next-step handoff

Agents must not end a coding task at "draft PR opened" or "PR updated" without
the operator path. If the task is not fully merged, deployed, and proven in the
intended runtime, the final reply must include:

- Current state: branch, PR number or URL, draft/ready state, validation status,
  and whether CI is already running or still pending.
- Next decision: the smallest useful user action, such as review the PR, approve
  merge, wait for CI, ask for a live tester proof, or say `ship to runtime`.
- Runtime path: if the change affects Jarvis, Telegram, gateway ownership,
  packaged runtime, or shared main behavior, say whether runtime deployment is
  still required after merge and point to the relevant command or guide.
- Blockers and risk: what is stopping the next step, what was not verified, and
  the fastest safe fallback if the change misbehaves.

The point is to make the next move obvious without the user asking "what now?"
again. Plain language beats process theater: state what is ready, what is not
ready, and exactly what should happen next.

## Release preflight operator notes

- Start sendable Jarvis DMG, app-update, package, appcast, and notary work with
  the release-lane launcher:

  ```bash
  bash scripts/jarvis-release-worktree.sh
  ```

- That lane is the persistent prewarmed Jarvis release worktree at
  `.worktrees/jarvis-release-current`. Use it for macOS release/update/package,
  appcast, and notarization work instead of creating ad-hoc cold worktrees.
- Public Jarvis package scripts fail unless they run from that blessed release
  worktree path and its `codex/jarvis-release-current` branch. A warmed random
  temp worktree is still the wrong release surface.
- Normal app-building release phases also require macOS prewarm proof. A
  missing or stale lane should be refreshed through the launcher:

  ```bash
  cd /Users/user/Programming_Projects/openclaw
  bash scripts/jarvis-release-worktree.sh
  ```

- `ALLOW_COLD_RELEASE_LANE=1` is an emergency override for the prewarm proof
  only. It does not allow public Jarvis packaging from any other worktree.
- Use `bash scripts/preflight-consumer-mac-release.sh` for the read-only
  consumer macOS release credential check before a notarized Jarvis lane.
- The default notarization path is App Store Connect API-key auth:
  `NOTARYTOOL_KEY`, `NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER` from
  `~/Library/Application Support/OpenClaw/release.env` or
  `OPENCLAW_RELEASE_ENV_FILE`.
- `NOTARYTOOL_PROFILE` is fallback-only. The preflight now distinguishes
  missing ASC API-key vars from a present and working Keychain profile, so do
  not treat fallback profile success as default-lane readiness.
- The same preflight reports whether Sparkle `generate_appcast` is available.
  If it is missing, build the Sparkle tools before appcast generation.
- If the preflight says `generate_appcast` is ready but ASC auth is missing,
  do not keep rediscovering Sparkle. First confirm App Store Connect actually
  allows API-key management at `/access/integrations/api`; on 2026-05-16 the
  page was reachable after login but showed "Permission is required to access
  the App Store Connect API. You can request access on behalf of your
  organization." with a Request Access button instead of API keys. Artem
  approved and submitted that access request the same day; the page then showed
  "Your request to access the App Store Connect API was approved", `Active (0)`,
  and `Generate API Key`. Artem then approved key generation; the `Jarvis
Notary` team key was created with Developer access, the `.p8` was moved under
  `~/Library/Application Support/OpenClaw/release-keys/`, and
  `NOTARYTOOL_KEY`, `NOTARYTOOL_KEY_ID`, and `NOTARYTOOL_ISSUER` were wired in
  the machine release env. A follow-up preflight reported `ASC API key lane
ready`.
- The script must not print secret values. It should report only presence,
  readability, tool availability, and the exact next operator action.

## Packaged Jarvis smoke loops

- For local app-shell/package smoke iteration after one normal fast package has
  produced `dist/<Jarvis instance>.app`, use
  `bash scripts/package-consumer-mac-app-fast.sh --instance <id> --reuse-runtime`.
- `--reuse-runtime` is smoke-only. It preserves the previous app bundle's
  signed `Contents/Resources/OpenClawRuntime`, then rebuilds the macOS shell and
  reruns the verifier without redeploying runtime `node_modules` or recopied
  Node/uv payloads.
- Do not use `--reuse-runtime` after changing runtime JS, extension, skill,
  template, package, Node, uv, or bundled dependency inputs. Rerun the fast
  package without the flag once, then resume reuse for app-shell-only changes.

## Temporary worktrees

- Temporary worktrees are the default implementation surface now.
- They are no longer optional parallel-only lanes.
- Every non-hotfix task should start in a temp worktree created from the correct sacred home clone.
- Keep repo-owned temporary worktrees under `.worktrees/` when practical so they do not scatter across multiple ad-hoc locations.
- Before creating a temporary worktree, fast-forward the chosen base branch locally so it exactly matches `origin/<base>`. `scripts/new-worktree.sh` fails if the named base branch is ahead of or behind its remote tracking branch.
- `scripts/new-worktree.sh` only runs from a sacred home clone. The shell helper wrappers are the default task-spawn path because they refresh the right sacred home clone first, then call `scripts/new-worktree.sh` with the correct base.
- `scripts/new-worktree.sh` bootstraps fresh lanes by default with a per-worktree dependency install/build. It must not symlink `node_modules` or `ui/node_modules` from another checkout because that leaks cross-worktree package state into clean-room validation.
- A ready lane is not "directory exists". The blessed spawn path must prove local tool resolution from inside the new worktree before handoff. Today that proof is `pnpm exec vitest --version`.
- If runtime bootstrap or the ready-lane proof fails, `scripts/new-worktree.sh` exits non-zero and the shell helper wrappers must refuse to drop the caller into that lane.
- `scripts/new-worktree.sh` supports explicit lane modes:
  - `--mode clean` is the default and keeps the current clean-room behavior for consumer E2E, runtime-sensitive work, or anything that must prove isolation honestly.
  - `--mode warm` creates the worktree and dev launch env, installs JS dependencies in-place, and skips the slower build step so coding/debugging lanes come up faster.
- Warm mode is intentionally conservative:
  - it may copy local-only Telegram compatibility configuration, but it never
    copies the Telegram-as-user SQLite session database
  - every worktree resolves the same machine-local canonical operator-session
    reference and shared lock; legacy databases are adopted only by reference,
    and explicit overrides are reserved for hermetic tests or a deliberately
    separate account
  - it does not auto-claim tester bot/runtime/browser state
  - it does not symlink or copy `node_modules`
  - it does not share Swift `.build` artifacts
  - it still must pass the ready-lane proof for local JS tooling before handoff
  - if you need the heavier macOS/Swift warm-up, use `bash scripts/prewarm-worktree.sh --root <worktree> --macos` after creation instead of leaking state between lanes
- Worktree/bootstrap/consumer runtime scripts pin to the repo-validated Node version from `.node-version` / `.nvmrc` instead of trusting the shell-default `node`. If that exact version is missing, install it first or point `OPENCLAW_NODE_BIN` at a binary with the same version.
- Legacy durable worktrees may still exist during migration. Do not retire them in-place during this change. Cleanup belongs to a later explicit pass.
- After merge, clean the finished temp worktree:
  - manual pass: `bash scripts/gc-worktrees.sh --auto --base-branch main`
  - legacy consumer fallback pass: `bash scripts/gc-worktrees.sh --auto --base-branch codex/consumer-openclaw-project`
  - background cleanup: `bash scripts/install-worktree-gc.sh install`
- The background job runs the pressure-aware retention coordinator:
  - `pnpm cleanup:retention:report` is always report-only
  - `pnpm cleanup:retention:auto` applies age-gated rebuildable artifact cleanup
    below 50 GiB free and safely retires eligible completed worktrees
  - warnings begin below 80 GiB; remaining pressure below 30 GiB is urgent and
    must stop new heavy builds
  - runtime instances, Codex sessions/history/browser state, and ambiguous
    authenticated state are excluded from scheduled deletion
- Prove the background job is real with
  `bash scripts/install-worktree-gc.sh status`. A plist on disk is not enough;
  status fails unless launchd reports the job loaded and enabled.
- For recovery and vanished-worktree triage, use `docs/debug/worktree-branch-survival.md`.

## Migration path

1. Keep the existing durable worktrees for now. Do not delete them as part of this rollout.
2. Ensure the main home clone exists at `~/Programming_Projects/openclaw`.
3. Keep `~/Programming_Projects/openclaw-consumer` only as legacy/emergency fallback until retirement is complete.
4. Source `scripts/shell-helpers/home-clone-helpers.sh` and start new work through `oc-main` / `oc-main-task`.
5. Stop treating durable worktrees as the default branch homes.
6. For new work, create temp worktrees from the main sacred home clone instead of branching directly inside the home clone.
7. Treat the sacred home clone as pull-only runtime state, not as a coding surface.
8. After the team has migrated, do a separate cleanup pass for old durable worktrees.

## GitHub footguns

- For PR CI and merge automation, read `docs/ci.md` first. It documents the
  required gates, non-blocking helper workflows, and preferred repo helpers.
- For issue comments, PR comments, and review bodies, use literal multiline strings or a single-quoted heredoc. Do not embed `\n`.
- Do not use `gh issue/pr comment -b "..."` when the body contains shell characters or backticks. Use `-F - <<'EOF'`.
- Do not wrap issue or PR refs like `#24643` in backticks when you want auto-linking.
- When searching issues or PRs broadly, keep paginating until you reach the end. Do not assume the first page or first 500 results is enough.

## Commits and PRs

- Use `scripts/committer "<message>" <file...>` for commits so staging stays scoped.
- Use Conventional Commits and include a bullet body for what, why, and risk.
- Group related changes. Do not bundle unrelated refactors.
- Do not leave non-trivial implementation work only in the working tree. Create a checkpoint commit once the first meaningful slice of the change exists, even if end-to-end validation is still pending.
- Open or update the draft PR as soon as the first coherent slice exists so review context and CI history do not live only in local state.
- When stopping after opening or updating a PR, include the next-step handoff
  from this guide. A PR link alone is incomplete if review, merge, CI, runtime
  deploy, or live proof still needs to happen.
- Validation gates PR readiness and merge, not whether you are allowed to commit. If a task would be painful to re-create, it should already be committed.
- For long or risky tasks, prefer this sequence:
  - checkpoint commit after the first coherent implementation slice
  - draft PR opened or updated with the current state
  - more commits as the work evolves
  - end-to-end validation
  - mark PR ready and update it with validation notes
- If validation is still pending, say so explicitly in the commit body or follow-up notes. Do not pretend a checkpoint commit means the change is fully verified.
- If the task is a bug-fix PR, require proof:
  - Symptom evidence
  - Root cause in code with file and line
  - Fix touching that code path
  - Regression proof or explicit manual validation notes
- For risky fork PRs, use the bounded Codex sidecar rule in
  `FORK_CONTRIBUTING.md`; run it once, never retry a timeout automatically, and
  keep trivial docs/chore/typo PRs fast by reviewer judgment.
- Before `/landpr`, run `/reviewpr`.

## tmux and Codex panes

- When driving interactive Codex panes through tmux skills or manual pane control, do not paste a prompt and send Enter in one blind action.
- Paste the prompt first.
- Capture or inspect the pane so you know the full prompt landed correctly.
- Send Enter as a separate action.
- This avoids half-pasted prompts, accidental sends, and fake state recovery.

## Multi-agent safety

- Do not use `git stash` unless the user explicitly asks.
- Do not switch branches or modify worktrees unless the user explicitly asks.
- Leave unrelated edits alone. Focus on your own diff.
- If formatting-only churn appears around your changes, fold it in without turning it into a separate drama.
