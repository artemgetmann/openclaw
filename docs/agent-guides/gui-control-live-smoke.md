# GUI Control Live Smoke

Last updated: 2026-06-25
Status: dev-only live-smoke checklist

Use this checklist to prove the safe GUI-control policy profiles against real
apps through the OpenClaw/Jarvis CLI. The goal is to prove useful,
non-destructive app and browser actions without smuggling in broad write access
or coordinate fallbacks.

## Ground Rules

- Use `pnpm jarvis gui-control ...` for acceptance proof.
- Use the pinned OpenComputerUse runtime from
  `/tmp/jarvis-ocu-stability-bin-path.txt`.
- Do not use Codex Computer Use, Browser/Chrome plugins, AppleScript/JXA, raw
  coordinates, clipboard fallback, or direct app modification as acceptance
  proof.
- Stop before login, sign-in, passenger/traveler details, checkout, payment,
  purchase, booking, confirmation, account changes, operator controls, app
  quit, or update installation.
- If OpenComputerUse reports Apple event error `-10005` or `cgWindowNotFound`,
  assume the Mac may be locked. Stop the smoke and ask for unlock; when the
  lane owner has provided a Jarvis/Telegram wake-up route, use that route
  before waiting.

## Jarvis Settings Navigation

This proves `safe_local_settings_navigation`: a local settings row can be
selected while dangerous controls in the same window remain blocked by policy.

Observe Jarvis:

```bash
pnpm jarvis gui-control observe \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Jarvis \
  --json \
  --max-elements 120
```

Expected precondition:

- window title is `Jarvis Settings`
- safe rows are visible, for example `General`, `Channels`, `Browser`,
  `AI access`, `Permissions`, and `About`
- dangerous controls may also be visible, for example `Stop AI Operator` and
  `Quit App Only`

Resolve or click a safe row through the policy profile:

```bash
pnpm jarvis gui-control click \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Jarvis \
  --intent any \
  --label-includes About \
  --task-policy safe_local_settings_navigation \
  --approve-policy-risk \
  --allow-observed-click \
  --reason "Navigate to the safe About settings row." \
  --json
```

Accepted proof:

- policy allows the safe row
- post-state verifies the intended row or the intended row content is visible
- `verifiedAction.stats.falseSuccesses` is `0`

Required blocked checks:

- `Stop AI Operator` stays blocked under `safe_local_settings_navigation`
- `Quit App Only` stays blocked under `safe_local_settings_navigation`
- any destructive, account-change, or update-installation surface stays blocked

Current live note, 2026-06-25:

- policy allowed the `About` row under `safe_local_settings_navigation`
- OpenComputerUse generic selectable row activation selected `About`
- OpenClaw verified the action with `verifiedAction.stats.falseSuccesses=0`
- `Stop AI Operator` and `Quit App Only` remained blocked under the same
  profile before action

## Google Flights Dry Run

This proves `non_committal_web_dry_run`: browser search and suggestion
interactions can mutate visible form state without crossing into booking or
account surfaces.

Prepare Safari manually or through a prior safe navigation so Google Flights is
visible. Then observe:

```bash
pnpm jarvis gui-control observe \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Safari \
  --json \
  --max-elements 160
```

Expected precondition:

- the page is Google Flights
- origin and destination fields are visible
- visible suggestion or destination-selector controls are present
- no login, passenger, checkout, payment, purchase, booking, or confirmation
  step is active

Set a destination field. Prefer a unique semantic target; if the destination
label is ambiguous, use the concrete `@ref` from the fresh observe result.

```bash
pnpm jarvis gui-control set-value \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Safari \
  --ref @DESTINATION_REF \
  --value Singapore \
  --task-policy non_committal_web_dry_run \
  --approve-policy-risk \
  --reason "Set the Google Flights destination field to Singapore for a non-committal dry run." \
  --json
```

Click a visible non-committal suggestion or destination selector:

```bash
pnpm jarvis gui-control click \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Safari \
  --intent button \
  --label-includes Destination \
  --task-policy non_committal_web_dry_run \
  --approve-policy-risk \
  --allow-observed-click \
  --reason "Click a visible Google Flights destination selector for a dry-run search." \
  --json
```

Accepted proof:

- destination text changes to the intended value
- visible non-committal suggestions or destination choices appear
- no login, passenger, checkout, payment, purchase, booking, or confirmation
  surface is clicked
- `verifiedAction.stats.falseSuccesses` is `0`

Important nuance:

- Google Flights page chrome may include `Book Your Ticket` in the title.
  `non_committal_web_dry_run` may allow that title only when the selected
  element and reason do not ask to book. A selected button or reason containing
  `book`, `purchase`, `checkout`, `payment`, `passenger`, `traveler`, or
  `confirm` must stay blocked.
