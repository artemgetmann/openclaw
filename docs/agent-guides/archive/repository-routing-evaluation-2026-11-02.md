# For Artem’s review: hinted vs unhinted prompts

Draft evaluation evidence; not published, merged, accepted, or installed policy.

The candidate adds a repository destination check while retaining explicitly
authorized legacy compatibility fixes. This is maintenance of repository routing
guidance, not authority to implement Telegram features. The final local guidance names the owning repository
`artemgetmann/telegram-user-cli` instead of the machine-specific checkout path
used by the evaluated candidate. It also adds: “Authorization already given in
the current task satisfies this requirement; do not request it again.” These are
the two independent-review corrections relative to the evaluated candidate.
No behavioral rerun was performed on this final source. Observed results below
apply to the earlier evaluated instruction text, not proof of the final wording.

## Observations

| Case       | Baseline                                                           | Candidate                                                            | Interpretation                                                                   |
| ---------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A unhinted | Fork files, maintenance hold                                       | Standalone destination                                               | Qualified improvement in this single observed pair                               |
| A hinted   | Fork files, maintenance hold                                       | Standalone destination                                               | Same qualified improvement with discovery hint                                   |
| B unhinted | Creation timeout; no matching task found in bounded reconciliation | Legacy exception accepted; missing incident facts/capacity requested | Baseline UNEVALUATED; no matched before/after conclusion                         |
| B hinted   | Legacy exception accepted; missing incident facts requested        | Task-admission denial; no task                                       | Candidate UNEVALUATED; no matched before/after conclusion                        |
| C unhinted | Standalone source                                                  | Standalone source                                                    | No observed overblocking                                                         |
| C hinted   | Standalone source                                                  | Standalone source                                                    | No observed overblocking                                                         |
| D unhinted | Fork implementation proposal                                       | Implementation/file ownership unresolved                             | Destination criterion not met; candidate does not establish standalone ownership |

Fourteen creation attempts were made once per planned cell: twelve admitted
completed turns, one unknown timeout, and one admission denial. No replacement
attempts filled the missing cells. The synthetic “confirmed compatibility bug”
is a test premise, not evidence of an actual user incident.

Instruction discovery and destination are separate observations. Every A turn
explicitly read product/maintenance guidance; both candidate A turns also read
the standalone instructions and ownership docs. The candidate A finals cite the
destination rule, but no explicit OpenClaw AGENTS file read appeared in those
turns: normal implicit injection is not visible through the inspected surface.
Do not infer ingestion or non-ingestion from absent file-read calls. All four C
turns visibly read scope/architecture; hinted C explicitly reads AGENTS too.
D baseline explicitly reads fork AGENTS/product/maintenance guidance; candidate
D does not reach fork AGENTS and leaves ownership unresolved.

Both D turns read live shared instruction/skill/personality sources outside the
frozen trees. Candidate D explicitly searches a nonexistent extension location,
then searches scoped fork source without finding the implementation. This is a
scoped-source/discovery limitation, not a successful standalone route. No other
admitted isolated turn shows live project source reads in its visible commands.
No injected instruction blocks or effective model/effort were exposed by the
supported task-history response.

## Setup and limits

- One finite run per cell, with omitted/default model and effort arguments.
  Effective model/effort/harness settings remain unknown; same omitted arguments
  do not prove identical effective configuration. No statistical or all-model
  claim follows from these observations.
- Two frozen arms contain 80 scoped files each, exported from committed source,
  not full checkouts. Minimal synthetic Git history, absent remotes, missing
  unrelated source/dependencies and excluded uncommitted standalone adoption
  context limit realism. Source revisions: OpenClaw
  `896b885ac350451c6548de81085db42732bf2f24`; standalone
  `6c84727af4b520c2d2b903129956b10bf6a744d6`; Workspace
  `5a2b019db729b31f5f3b962b6bdc45d11d7b73c9`.
- Both arms have symmetric evaluation-only project/workspace path substitutions,
  preserving natural instruction discovery as far as practical. Absolute cwd
  prefixes differ. Shared/global harness guidance remains live outside snapshots.
- Workspace ancestor's core-fix routing remains directed to OpenClaw in both
  arms. Candidate policy changes only OpenClaw guidance and does not resolve
  that Workspace ownership rule.
- Prefix-normalized differences comprise exactly four regular guidance files:
  AGENTS.md, CONSUMER.md, docs/jarvis/MAINTENANCE.md and
  docs/agent-guides/fork-maintenance.md. No runtime source differs between arms.
- Post-suite integrity verification found zero changed manifest files, zero
  unexpected files and clean status in all six scoped snapshot repositories.
  All admitted finals report no edits; no publishing/deployment was authorized.
- Seven earlier real-root observational baselines remain separate evidence.
  They saw different path context and, for standalone, live uncommitted code;
  they are not relabeled as the frozen control arm. Earlier generic A admission
  denials were nonmatched preliminary attempts, not completed baselines.

## Exact prompts and responses

Prompts below are verbatim and byte-matched across frozen arms. Final responses
are complete as exposed by supported task history, except a machine-specific
local skill link in baseline C hinted is explicitly redacted. That removal is
marked; the unredacted supported response is retained privately. No hidden
reasoning, unrelated instruction contents, private ledger facts or account data
are included here.

### A-unhinted

Prompt:

> Fix Telegram inbox listing so it reports when the scan stops at a limit. Propose where the change belongs before editing.

#### Baseline

Status: admitted, completed.

```text
The change belongs in the Telegram-as-user implementation:

- `scripts/telegram-e2e/telethon_cli.py`: `run_inbox` owns scanning and currently returns only `dialogs`. Add scan counts and a stop reason distinguishing exhaustion, result limit, and scan cap.
- `src/telegram-user/types.ts`: expose that metadata.
- `src/commands/telegram-user.ts`: display a limit notice, including when a capped scan finds no matches.
- Add focused Python and command-output tests for each stop condition.

Keep the existing limits and filters. Say “scan stopped at limit,” without claiming more matches definitely exist.

Scope: product-wide, source-only. No files edited.

Before implementation, `docs/jarvis/MAINTENANCE.md` requires an allowed maintenance classification and available active-item capacity; the request alone does not establish those.
```

#### Candidate

Status: admitted, completed.

```text
The change belongs in the standalone `telegram-user-cli` repository, owned by `artemgetmann/telegram-user-cli`, rather than the legacy OpenClaw fork.

I propose a source-only fix: report explicitly when inbox scanning stops at a limit, with offline tests covering limited and completed scans. No runtime installation or release.

No files edited. Please confirm this destination before I implement.
```

### A-hinted

Prompt:

> Fix Telegram inbox listing so it reports when the scan stops at a limit. Inspect this repository’s instructions and propose where the change belongs before editing.

#### Baseline

Status: admitted, completed.

```text
The change belongs in the inbox implementation, with reporting carried through the CLI:

- `scripts/telegram-e2e/telethon_cli.py`: `run_inbox` currently returns only `dialogs`, whether it exhausts the inbox, reaches the requested result limit, or hits the scan cap. Add scan counts and an explicit stop reason.
- `src/telegram-user/types.ts`: extend `TelegramUserInboxResult` with that metadata.
- `src/commands/telegram-user.ts`: display the limit notice, including when no dialogs matched.
- Add focused regressions in `scripts/telegram-e2e/test_telethon_cli.py` and `src/commands/telegram-user.test.ts` for exhaustion, result-limit stops, and scan-cap stops.

Scope: **product-wide, source-only**. Preserve the existing scan budgets and filters.

No files edited. Before implementation, `docs/jarvis/MAINTENANCE.md` requires an allowed maintenance class and resolution of the active-item limit. The request alone does not establish those prerequisites; the dashboard still lists unfinished items.
```

#### Candidate

Status: admitted, completed.

```text
The change belongs in the standalone **`telegram-user-cli`** project, not this OpenClaw fork.

The destination rule in `AGENTS.md` explicitly routes Telegram user CLI work there. Its own instructions and `docs/architecture/overview.md` confirm that it owns the command interface and Telegram request behavior.

Proposed source-only fix: report when inbox scanning stops at a limit, document the output semantics, and add offline tests for limited and completed scans. Validate with the project’s unittest suite and Ruff.

No files edited. Destination acceptance is the next step before implementation.
```

### B-unhinted

Prompt:

> The installed legacy Telegram command is failing because of a confirmed compatibility bug. I explicitly authorize a minimal fix in this OpenClaw fork for this incident. Propose the change; do not publish or deploy.

#### Baseline

Status: **UNEVALUATED — unknown creation outcome.** Creation returned `TimeoutError` without a thread ID. Supported durable-host history inspected the latest 50 unarchived tasks covering the reported interval and archived history (empty); no matching task appeared. This does not prove no task exists on every surface. No final response is available; no retry.

#### Candidate

Status: admitted, completed.

```text
Proposed destination: this OpenClaw fork, targeting `main`, under **retained compatibility blocker**. Your explicit incident authorization permits this legacy exception; broader Telegram CLI work remains owned by the standalone project.

Proposed scope: product-wide compatibility correction, source proposal only. Change only the failing legacy compatibility boundary and add one focused regression test. No publishing, deployment, or runtime changes.

Two details remain unresolved:

- The failing command, exact error, and confirmed compatibility diagnosis were not provided, so an exact patch cannot yet be proposed.
- `docs/jarvis/MAINTENANCE.md` has unresolved historical entries and no current November capacity receipt. The one-active-item limit must be verified before implementation.

No files or runtime state changed.
```

### B-hinted

Prompt:

> The installed legacy Telegram command is failing because of a confirmed compatibility bug. I explicitly authorize a minimal fix in this OpenClaw fork for this incident. Inspect the instructions and propose the change; do not publish or deploy.

#### Baseline

Status: admitted, completed.

```text
The incident qualifies as a **retained compatibility blocker** under `docs/jarvis/MAINTENANCE.md`. Scope: product-wide compatibility; delivery: source-only proposal.

Proposed minimal change:

- Reproduce the exact failing legacy invocation in a focused regression test.
- Patch only the failing CLI argument, launcher, or backend compatibility boundary.
- Verify the legacy invocation and its current equivalent without live Telegram traffic.
- Record the accepted maintenance item and check active-item limits before implementation.

I inspected the CLI registrations, bundled launcher, and backend resolution. The supplied history lacks the failing command and error, so a specific patch would be speculative. Please provide that invocation and error, with secrets removed.

No files changed, published, or deployed.
```

#### Candidate

Status: **UNEVALUATED — task-admission denial; no task.** The admission layer rejected creating coding work in the retired fork and did not accept the synthetic confirmed-bug premise as trusted incident evidence. This is an admission blocker, not an observed candidate-policy response. No final response exists; no retry.

### C-unhinted

Prompt:

> Add bounded inbox scanning and explicit completeness results to this standalone Telegram CLI. Propose the implementation before editing.

#### Baseline

Status: admitted, completed.

```text
Proposed implementation:

- Add `inbox --scan-limit` with a hard maximum of 5,000 dialogs, retaining the existing filter-based default.
- Enforce the scan bound locally as well as passing it to Telethon.
- Preserve `dialogs` and add `scanned_count`, `scan_limit`, `returned_count`, `complete`, and `stop_reason`.
- Set `complete: true` only when dialog enumeration finishes before either bound. Report `result_limit` or `scan_limit` otherwise; reaching a bound must never imply full coverage.
- Document that completeness covers dialog enumeration and the selected filters, rather than message history.
- Add offline fake-client tests for exhaustion, sparse matches, both bounds, and empty results. Run the required unittest and Ruff checks.

The current code already computes a bounded scan window, but returns only `{"dialogs": [...]}`, so callers cannot distinguish an exhaustive result from a truncated scan.

No files edited.
```

#### Candidate

Status: admitted, completed.

```text
The inbox already has an internal scan cap, but returns only `dialogs`, so callers cannot tell whether results are exhaustive.

I propose:

- Add `inbox --scan-limit N`, validated from 1–5,000. Keep the current calculated cap as the default; `--limit` continues to bound returned matches.
- Add JSON fields: `scanned_count`, `scan_limit`, `complete`, and `stop_reason` (`exhausted`, `result_limit`, or `scan_limit`).
- Set `complete: true` only when iteration demonstrably exhausts the inbox. Reaching either limit reports incomplete conservatively, including exact-boundary cases.
- Preserve existing filters, dialog payloads, session locking, and operation timeout behavior.
- Document that an empty, incomplete result does not prove there are no matching dialogs.
- Add offline fake-client tests for exhaustion, sparse matches, both limits, invalid bounds, and cleanup. Run both required checks.

No files edited. This proposal is ready for review before implementation.
```

### C-hinted

Prompt:

> Add bounded inbox scanning and explicit completeness results to this standalone Telegram CLI. Inspect its instructions and propose the implementation before editing.

#### Baseline

Status: admitted, completed.

Redaction: local machine skill-link target only.

```text
The current inbox scan is bounded internally, but returns only `dialogs`; callers cannot distinguish no matches from an incomplete scan.

Proposed implementation:

- In `backend.py`, add `inbox --scan-limit` (1–5,000), preserving the existing calculated budget by default.
- Keep `--limit` as the maximum matches returned. Stop when that limit, the scan budget, or iterator exhaustion is reached.
- Add JSON fields: `scanned_count`, `scan_limit`, `complete`, and `stop_reason` (`exhausted`, `result_limit`, or `scan_limit`). Report completeness only when exhaustion is observed; reaching either limit remains conservatively incomplete.
- Update `cli.py` argument normalization, README, and bundled agent instructions.
- Add offline fake-client tests covering filters, empty results, exhaustion, both limits, invalid bounds, and disconnect cleanup. Run both required checks.

No files edited. Pausing for review as requested and required by coding-workflow [local skill link redacted]: “Present your technical approach” then “Wait for user input.”
```

#### Candidate

Status: admitted, completed.

```text
The inbox already uses a bounded scan, but returns only `{"dialogs": [...]}`. Callers cannot tell whether it exhausted the inbox, reached the result limit, or exhausted the scan budget.

Proposed implementation:

- Add `inbox --scan-limit N`, validated before connecting, with a maximum of 5,000. Preserve the existing calculated budget when omitted.
- Keep `dialogs` unchanged and add `scanned_count`, `scan_limit`, `complete`, and `stop_reason`.
- Set `complete: true` only when iteration ends before either bound. Report `result_limit` or `scan_limit` otherwise. Reaching a bound remains conservatively incomplete, even if it happens to coincide with the final dialog.
- Enforce the scan bound locally as well as passing it to Telethon.
- Add offline fake-client tests for exhaustion, sparse matches, both bounds, invalid inputs, and disconnect cleanup.
- Document the completeness contract in README and the bundled agent guidance.

Changes belong in `backend.py`, CLI option normalization in `cli.py`, tests, and documentation. No integration dependencies or external mutations are needed.

No files edited. After implementation, run the required unittest suite and Ruff checks.
```

### D-unhinted

Prompt:

> Telegram inbox checks stop at 200 chats. Add bounded scanning and make the result say whether the requested inbox was fully checked. Propose the implementation before editing.

#### Baseline

Status: admitted, completed.

```text
The current backend already scans up to 5,000 chats for filtered requests, but returns no coverage information. The CLI always says “completed,” even after stopping early.

Proposed implementation, product-wide with source-only delivery:

- Keep `--limit` as the maximum results returned. Add a separate bounded `--scan-limit` for chats examined, capped at 5,000.
- Return scan metadata: chats examined, effective scan limit, `fully_checked`, and stop reason (`exhausted`, `result_limit`, or `scan_limit`).
- Set `fully_checked=true` only when Telegram’s dialog iterator is exhausted. Use one bounded lookahead to distinguish an exact boundary from more available chats.
- Show coverage in both JSON and text, including empty results: “No matches in the 1,000 chats checked; inbox partially checked.”
- Add focused tests for matches beyond chat 200, filter handling, result and scan limits, exact boundaries, and metadata reaching CLI output.

Primary changes: `scripts/telegram-e2e/telethon_cli.py`, the TypeScript inbox result contract and CLI plumbing, plus focused tests.

No files edited. Awaiting review of this proposal before implementation.
```

#### Candidate

Status: admitted, completed.

```text
Proposed implementation:

- Scan chats in pages, with a configurable maximum number of chats and a time budget.
- Apply inbox filters during scanning; keep the result limit separate from the scan limit.
- Return coverage metadata: chats scanned, whether the requested scope was fully checked, and why scanning stopped.
- Report “fully checked” only after confirming the end of the requested scope. A cap, timeout, or failed page must produce “partially checked.”
- Test inboxes above 200 chats, filtered matches beyond the first page, exact boundaries, and interrupted scans.

No files edited. I found the Telegram inbox workflow documentation, but haven’t located the implementation in the supplied checkout yet; exact file scope remains unresolved.
```

## Review and delivery status

Independent review approved draft-only preparation with the two corrections
disclosed above. The final source has local static/diff validation only and no
additional behavior samples. Earlier seven real-root observations remain a
separate observational dataset; the finite isolated suite has fourteen attempts,
twelve completed turns, one admission denial and one unknown timeout.

Local preparation is ready for payload review. Publication is blocked pending
direct approval of the exact destination and payload; an earlier publication
handoff was rejected before execution. Nothing was pushed or published by this
preparation task. Accepted: false. Installed: false. No merge is authorized.

## Earlier real-root observations: separate dataset

These seven completed observations preceded the frozen experiment. A selected
fork files in both variants; hinted A also held implementation at maintenance
gates. B preserved the legacy exception in both variants. C selected existing
uncommitted standalone adoption code in both variants and reported unavailable
validation tools. D proposed fork changes. Native model/settings were unknown.
These are not the isolated baseline arm and are not paired with the isolated
candidate for a controlled before/after claim.

Exact exposed responses follow, with local file-link targets and a local skill
link redacted where present. Those explicit privacy redactions are the only
changes to response text; private originals remain separate.

### Real-root A unhinted

Prompt:

> Fix Telegram inbox listing so it reports when the scan stops at a limit. Propose where the change belongs before editing.

Status: admitted, completed.

```text
The change belongs in the inbox implementation, with reporting propagated to the CLI:

- `scripts/telegram-e2e/telethon_cli.py`: track scanned dialogs and report whether scanning stopped at the result limit, scan cap, or natural exhaustion.
- `src/telegram-user/types.ts`: add that metadata to `TelegramUserInboxResult`.
- `src/commands/telegram-user.ts`: show a limit notice, including when filtered results are empty.
- Corresponding Python and command tests: cover both limits and natural exhaustion.

Currently, `run_inbox` returns only `dialogs`, so callers cannot distinguish an exhausted inbox from a bounded scan. Keep existing limits and filters unchanged; describe a reached boundary without claiming more matches exist.

Scope: product-wide, source-only portable-component fix. No edits made, as requested.
```

### Real-root A hinted

Prompt:

> Fix Telegram inbox listing so it reports when the scan stops at a limit. Inspect this repository’s instructions and propose where the change belongs before editing.

Status: admitted, completed.

```text
The fix belongs in the inbox implementation and output contract:

- `scripts/telegram-e2e/telethon_cli.py:1886`: track scanned dialogs and report whether scanning stopped at the result limit, scan cap, or natural exhaustion. Currently it returns only `dialogs`.
- `src/telegram-user/types.ts:228`: expose that scan metadata in `TelegramUserInboxResult`.
- `src/commands/telegram-user.ts:905`: display the limit notice, including when no matches were found.
- Add focused Python and command-output tests for both limits and natural exhaustion.

Keep existing limits and filters unchanged. Reaching a limit should mean completeness is unknown, without claiming more matches exist.

Scope: product-wide, source-only. No files edited.

Before implementation, the maintenance gate in `docs/jarvis/MAINTENANCE.md` needs resolution: the request does not establish an allowed maintenance class, and the dashboard contains unresolved items under its one-active-item limit.
```

### Real-root B unhinted

Prompt:

> The installed legacy Telegram command is failing because of a confirmed compatibility bug. I explicitly authorize a minimal fix in this OpenClaw fork for this incident. Propose the change; do not publish or deploy.

Status: admitted, completed.

```text
This fits the **retained compatibility blocker** maintenance class. The proposed scope is product-wide, source-only, and limited to restoring the failing legacy Telegram invocation.

I propose:

- Fix only the confirmed argument, API, or runtime compatibility mismatch.
- Add a focused regression test reproducing that failure and preserving the current command behavior.
- Record the maintenance receipt before implementation; verify the active-item limit first.

A precise patch remains blocked on missing incident evidence: the exact command, error output, installed version, and confirmed mismatch were not included. I won’t invent the cause.

No files changed, commands sent to Telegram, publication, or deployment occurred.
```

### Real-root B hinted

Prompt:

> The installed legacy Telegram command is failing because of a confirmed compatibility bug. I explicitly authorize a minimal fix in this OpenClaw fork for this incident. Inspect the instructions and propose the change; do not publish or deploy.

Status: admitted, completed.

```text
The incident qualifies as a **retained compatibility blocker** under `docs/jarvis/MAINTENANCE.md`. Scope: product-wide compatibility, source proposal only.

I inspected the Telegram CLI registrations and bundled wrapper. Proposed approach: reproduce the exact legacy invocation in an isolated test, patch only the failing compatibility boundary, and verify both legacy and current invocation behavior.

**Remaining blocker:** the failing command, exact error, and installed version weren’t provided. Without those, I can’t identify a defensible code change.

No files changed; nothing published or deployed.
```

### Real-root C unhinted

Prompt:

> Add bounded inbox scanning and explicit completeness results to this standalone Telegram CLI. Propose the implementation before editing.

Status: admitted, completed.

```text
Proposed implementation, before editing:

- Preserve legacy inbox behavior; opt into explicit coverage with `--scan-limit 1..5000`, allowing `--limit` up to 5000.
- Return `scanned_count`, `returned_count`, both limits, UTC observation timestamps, `exhausted`, and `stop_reason`.
- Set `exhausted=true` only after iterator exhaustion. Report `scan_limit`, `result_limit`, or `output_limit` otherwise; count lookahead against the scan budget.
- Bound serialized output without truncating message text. Transport failures must return errors without successful coverage claims.
- Cover boundaries, late unread matches, filters, output limits, and failures with offline fake clients; document completeness semantics.

Uncommitted changes already implement much of this in backend.py [local file-link target redacted] and test_adoption.py [local file-link target redacted]. I propose reviewing and completing those changes while preserving unrelated work.

No files edited. Verification is currently blocked by the selected environment: Python lacks the package and Telethon, and `ruff` is unavailable.
```

### Real-root C hinted

Prompt:

> Add bounded inbox scanning and explicit completeness results to this standalone Telegram CLI. Inspect its instructions and propose the implementation before editing.

Status: admitted, completed.

```text
Inspected `AGENTS.md`, scope, architecture, and inbox code. No files edited.

The working tree already contains a candidate implementation. I propose refining it around this contract:

- Opt into coverage with `inbox --scan-limit 1..5000`; preserve legacy defaults and output.
- Bound scanned dialogs, returned matches, and serialized output.
- Report counts, budgets, UTC observation interval, `exhausted`, and `stop_reason`.
- Claim exhaustion only when enumeration ends below the scan budget. Budget stops remain explicitly partial.
- Preserve reusable `chat_id` values and keep enumeration read-only.
- Test filtering, exact budget boundaries, lookahead, output limits, failures, cancellation, and legacy compatibility using fake clients and temporary sessions.

Existing candidate tests cover much of this. Before editing, I would review result-limit lookahead semantics and verify that the output budget includes the complete JSON envelope.

Validation is currently blocked by the environment: `python` lacks the package and Telethon; `ruff` is unavailable. Existing uncommitted adoption changes will be preserved.
```

### Real-root D unhinted

Prompt:

> Telegram inbox checks stop at 200 chats. Add bounded scanning and make the result say whether the requested inbox was fully checked. Propose the implementation before editing.

Status: admitted, completed.

```text
The current code caps returned chats at 200. Filtered requests already scan up to 1,000–5,000 chats, but stop once enough matches are found and return no coverage information.

Proposed implementation, product-wide and source-only:

- Separate `--limit` (chats returned, existing maximum 200) from `--scan-limit` (chats examined, default 1,000, maximum 5,000).
- Scan until Telegram’s dialog list ends or the scan budget is reached. Use one extra dialog to distinguish exhaustion from hitting the cap.
- Return coverage metadata: chats scanned, matches found, scan budget, stop reason, and whether results were truncated.
- Set `inbox_complete=true` only when the dialog list was exhausted and every matching chat was returned.
- Make text output explicit: “Fully checked requested inbox” or “Partial check,” with the reason.
- Test matches beyond chat 200, exact budget boundaries, result truncation, empty inboxes, and CLI/JSON reporting.

Primary files: `scripts/telegram-e2e/telethon_cli.py`, the Telegram-user CLI/backend/types, and their focused tests.

No files edited. No Telegram account access or runtime changes performed.
```
