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
- Normal scoped implementation defaults to a merged PR. Follow the autonomous
  merge policy in [docs/ci](/ci): the agent owns investigation, implementation,
  actionable review handling, required CI, and merge. Deployment, restart, and
  release still require explicit permission.

## “Ship end-to-end” ownership contract

Apply the Work Scope Contract in `CONSUMER.md` before entering this lifecycle.
Source merge is not runtime or product-release proof.

When the owner says `ship this end-to-end`, the feature-owning agent keeps
responsibility for one scoped change from source through merge. It does not
hand routine coordination back to the founder and it does not create a second
Control Tower or permanent merge agent.

The feature owner must continue through:

1. implementation in its isolated worktree;
2. the smallest focused local proof that establishes the changed behavior;
3. an early draft PR, followed by exact-head review and actionable finding
   fixes;
4. ready state only after the owned proof and relevant CI are green;
5. refresh or rebase when `main` advances, with affected proof repeated;
6. merge when the exact reviewed head is current and required CI is green; and
7. proportionate post-merge repository verification, with merged-code truth
   reported separately from any package, installed-runtime, provider, GUI, or
   end-user proof.

Routine review, ordinary `main` drift, a safe rebase, pending CI, or a PR being
draft are continuation states—not reasons to return the task to the founder.
The feature owner waits, diagnoses, updates, and continues. Independent review
may be delegated as a bounded read-only check, but ownership and the merge
decision stay with the feature agent.

`Ship end-to-end` authorizes the normal source/PR/merge lifecycle above. It does
not by itself authorize genuinely new scope, destructive cleanup, credentials,
irreversible or external actions, security-owned changes, or task-specific
protected live actions. Package, release, deploy, restart, install, shared
runtime mutation, and live acceptance require explicit authority in the task
or a later approval. There is no blanket rule requiring user approval for every
normal merge.

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

## Provisional tester-first PR pilot

This is written pilot policy, not yet a mandatory default or an automation
specification. For PRs explicitly enrolled in the pilot, ownership flows:

`builder -> independent tester when risk-triggered -> release owner -> authorized deployment and minimal smoke`

The builder may open a draft PR early, but owns implementation and exact-head
proof. Require a fresh independent tester when observable behavior is live,
user-facing, stateful, destructive, timing-sensitive, or crosses an integration
boundary. Examples include Telegram callbacks, retries, offsets, streaming,
voice, auth, polling, and runtime state. Low-risk docs, mechanical refactors,
and changes fully covered by deterministic tests may record why independent
live testing was skipped.

The release owner or standard dispatcher assigns the tester from the PR's fixed
observable claim and acceptance criteria. The tester tries the intended path
and the smallest relevant edge path on the exact PR head, changes no
implementation code, and reports the receipt or defect to both builder and
release owner. The tester isolates bot identity, conversation/topic, config,
state, and risky interaction state. That isolation does not prove or allocate
the machine-wide heavy slot, CPU/disk/build capacity, ports, provider
determinism, package identity, installed/main-runtime behavior, macOS behavior,
or real-user acceptance.

Only the builder takes the PR out of draft, and only when the same exact head
has complete scope, builder proof, all risk-triggered tester receipts, relevant
green CI, tester/runtime cleanup, a complete PR contract, and no uncommitted or
unpushed fix. A behavior-bearing source change makes the tester receipt stale.
If the release owner makes such a change, return ownership to the builder for
repeated proof and tester recheck. Mechanical rebases, merges, metadata, and
administrative changes may remain with release, with fresh exact-head CI.

The PR contract must state the observable claim and acceptance criteria, exact
head and completed builder proof, tester receipt or skip reason, cleanup,
dependencies/overlap/merge order, rollback, known risks, and proof still
required after merge. Keep source, tester-live, merged, packaged, deployed,
healthy-runtime, GUI, and real-user proof as separate claims.

The release owner owns normal queueing. Use a temporary coordinator only for
cross-PR merge order, contention for a shared heavy/runtime resource, or a user
decision spanning lanes. Do not add a permanent per-PR coordinator, dispatcher,
wrapper, queue service, automated ready gate, multi-slot scheduler, or runtime
automation during this pilot.

Do not promote or automate this policy until evidence includes:

1. one net-new risky Telegram PR completing the full pre-merge lifecycle;
2. one low-risk PR where the rubric correctly skips independent live testing;
3. at least one risky defect return or behavior-changed-head tester recheck.

The current voice-ordering acceptance debt and PR #1316 are historical or
partial evidence, not clean pilots.

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
10. Merge if the task and [the autonomous PR merge policy](/ci) allow it;
    otherwise stop and report the blocker.
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
