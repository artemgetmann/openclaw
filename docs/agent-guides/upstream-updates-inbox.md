# Upstream Updates Inbox

Status: Parking lot for future upstream review signals.

Use this doc when a maintainer post, release note, bookmark, or user-observed bug looks potentially relevant but is not worth acting on today.

This is not a porting queue. It is an inbox for preserving signal until there is a real product reason to spend engineering time.

## Operating Rule

The user is the taste filter. Agents do evidence collection.

Do not run broad upstream sweeps by default. Start from user-selected links, claims, or symptoms, then verify them against GitHub PRs, commits, releases, or code diffs.

## Add A Signal

Use this shape for each future item:

```md
### YYYY-MM-DD: Short title

- Source hint:
- User reason this looked interesting:
- GitHub source of truth:
- Local affected path:
- Product value:
- Risk / cost:
- Recommendation: verify / defer / skip / port now
- Next smallest proof:
```

Field guidance:

- `Source hint`: tweet, bookmark, release note, issue, or user symptom.
- `User reason this looked interesting`: the product intuition, not the agent summary.
- `GitHub source of truth`: required before porting. Social posts are hints only.
- `Local affected path`: say "unknown" until checked.
- `Product value`: tie to Mac-first, Telegram-first, Codex/OpenAI truth, runtime reliability, packaging, or a current user workflow.
- `Risk / cost`: include likely blast radius.
- `Next smallest proof`: a read-only diff map, a targeted test, or a live smoke.

## Triage Bar

Port only if the change does at least one of these:

- fixes a current bug we feel
- removes operational drag we repeatedly hit
- protects a core path: Telegram, Codex/OpenAI truth, Mac runtime, packaging
- unlocks a user-facing workflow we are actively shipping

Defer if the change is plausible polish but no current symptom exists.

Skip if it is broad platform/channel expansion without a concrete consumer need.

## Agent Prompt

Use this prompt when the user has already selected candidate links or claims:

```text
I skimmed upstream/OpenClaw bookmarks and these items caught my eye:

[paste links or claims]

Use GitHub PRs/releases/commits as source of truth. For each item:
- verify what actually changed
- say whether this fork has the affected code path
- rank by current product value for Mac-first + Telegram-first + Codex/OpenAI truth + runtime reliability
- recommend: port now / defer / skip
- if port now, suggest the smallest first slice

Do not expand the list unless you find a directly adjacent upstream PR that changes the recommendation. Keep this practical; no broad polish queue.
```

## Parked Signals

### 2026-05-16: Native Codex harness / Codex server architecture

- Source hint: upstream native Codex harness discussion and maintainer/bookmark notes around `extensions/codex/**`, `agentRuntime.id: "codex"`, visible replies, native-first tools, and Codex `/goal`.
- User reason this looked interesting: native Codex may eventually be better for serious long-running coding workflows than running Codex-shaped providers through Pi.
- GitHub source of truth: not verified in this inbox pass. Prior intake notes mention upstream `extensions/codex/**` and `docs/plugins/codex-harness.md`.
- Local affected path: fork is currently Pi-first; prior notes say the local native `extensions/codex/**` harness path is absent.
- Product value: potentially high later for long coding sessions, native resume, Codex compaction, Codex app-server semantics, and `/goal`.
- Risk / cost: high. This is a runtime architecture evaluation, not a provider cleanup.
- Recommendation: defer.
- Next smallest proof: read-only architecture map comparing upstream Codex harness to local Pi/OpenAI-Codex/ACPX paths; no porting until a real Codex workflow is blocked.

### 2026-05-16: Provider, media, voice, and web-search reliability bucket

- Source hint: upstream `v2026.5.2` release prose and maintainer/bookmark notes mentioning OpenAI-compatible TTS/Realtime, Anthropic streaming, LM Studio reasoning metadata, Brave/SearXNG/Firecrawl search, media paths, Telegram audio delivery, and voice-call routing.
- User reason this looked interesting: may touch Telegram media/audio delivery, web-search reliability, and provider failure visibility.
- GitHub source of truth: not verified in this inbox pass.
- Local affected path: unknown.
- Product value: medium if a current symptom appears; lower than Telegram routing, Codex truth, runtime startup, or packaging.
- Risk / cost: medium to high because the release-note bucket is broad and likely spans unrelated provider/media paths.
- Recommendation: defer.
- Next smallest proof: only map GitHub PRs if we observe broken Telegram audio/media, broken search freshness/error handling, provider streaming bugs, or voice/TTS becomes an active shipping surface.

## Prior Closed Batch

The May 2026 intake batch is archived in `docs/agent-guides/archive/upstream-intake-2026-04-27.md`.

Do not reopen that batch unless a parked signal graduates into a concrete verification task.
