# Consumer PR Restack Plan

This note exists so the replacement PR does not inherit the bloated history from `#424`.

## Why the current PR is bloated

- Current head: `4eb370b742`
- Current consumer base: `origin/codex/consumer-openclaw-project` at `cda81e96d4`
- Merge-base between them: `2774f98544225f78d65494354876990eaf30e776`
- Result: GitHub compares a stale ancestry stack, not the small consumer fix slice.

The branch carries a large amount of unrelated history from older consumer and runtime work. The replacement PR should be restacked from the current consumer base and cherry-picked only with the commits below.

## Minimal commit stack to keep

These commits are the actual consumer first-run / packaging fix chain:

1. `0c18d4f5cb` `fix(macos): self-heal consumer first-run setup`
1. `4b3da0883a` `fix(macos): seed consumer runtime before state load`
1. `a53e317983` `fix(macos): use stable consumer app name for tcc packaging`
1. `55f2209884` `fix(macos): preflight consumer cli setup before gateway start`
1. `45c4cc9ee6` `docs(consumer): pin consumer bootstrap to fork-controlled source`
1. `3c7422b6cd` `fix(macos): require explicit consumer installer source`
1. `46d4ea905f` `docs(consumer): add mac packaging contract`
1. `ccda25dd47` `build(consumer): enforce mac packaging contract across worktrees`
1. `f8836afaee` `fix(macos): bundle consumer runtime payload`
1. `fed6c8fd91` `fix(build): hydrate matrix crypto mac binaries`

## Commit to split out

- `4eb370b742` `fix(macos): stage clean-user app before smoke`

This commit is validation-only. Keep it out of the replacement product PR unless the smoke harness itself is being reviewed.

## Replacement PR strategy

1. Create a fresh branch from `origin/codex/consumer-openclaw-project`.
1. Cherry-pick only the commit stack above.
1. Keep `4eb370b742` separate if the smoke harness needs to stay tracked.
1. Open a replacement PR against `codex/consumer-openclaw-project`.
1. Leave `#424` draft or close it once the replacement PR exists.

## Residual risks

- Fresh-user smoke still needs to pass on the clean macOS account using the staged app.
- The app is still Apple Development signed, so Gatekeeper broad distribution still requires Developer ID + notarization.
