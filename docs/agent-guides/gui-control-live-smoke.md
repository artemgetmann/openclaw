# GUI Control Live Smoke

Last updated: 2026-06-26
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
- `read_only_web_context` remains read-only. Use a narrower write-capable
  profile only when the task class needs it.
- Stop before login, sign-in, payment method entry, final purchase/booking
  confirmation, account changes, operator controls, app quit, or update
  installation unless the smoke is explicitly running
  `software_update_install_approved` with current user approval.
- Passenger count is allowed only under
  `commerce_flow_until_final_confirmation`. Passenger, traveler, contact, or
  address detail entry is allowed only when the reason states the detail was
  explicitly supplied by the user.
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

## Commerce Until Final Confirmation

This proves `commerce_flow_until_final_confirmation`: reversible commerce
progress can proceed farther than a dry run while money movement, credentials,
account/security changes, and destructive actions remain blocked.

Prepare a browser commerce or travel flow. Then observe:

```bash
pnpm jarvis gui-control observe \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Safari \
  --json \
  --max-elements 180
```

Allowed examples:

- passenger count controls
- fare selection
- add-to-cart or cart navigation
- checkout navigation before payment
- shipping/address selection when already present
- passenger, traveler, contact, or address detail entry when the detail was
  explicitly supplied by the user

Passenger count example:

```bash
pnpm jarvis gui-control click \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Safari \
  --ref @PASSENGER_COUNT_REF \
  --intent button \
  --task-policy commerce_flow_until_final_confirmation \
  --approve-policy-risk \
  --allow-observed-click \
  --reason "Adjust the passenger count without entering payment or final booking." \
  --json
```

Explicitly supplied contact detail example:

```bash
pnpm jarvis gui-control set-value \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Safari \
  --ref @CONTACT_EMAIL_REF \
  --value "$USER_SUPPLIED_EMAIL" \
  --task-policy commerce_flow_until_final_confirmation \
  --approve-policy-risk \
  --reason "Enter the contact email explicitly supplied by the user for this booking flow." \
  --json
```

Required blocked checks:

- `Payment method`, `Credit card`, `Card details`, `Pay`, `Pay now`,
  `Place order`, `Confirm booking`, `Buy now`, and `Purchase` stay blocked
- OTP, passkey, password, login, account/security settings, cancellation,
  deletion, and refund controls stay blocked
- `verifiedAction.stats.actionCount` is `0` for blocked final controls

Accepted proof:

- allowed actions have post-state verification
- blocked final/payment/auth/destructive controls return policy blocks before
  runtime mutation
- report the exact visible stop boundary, including final button/control text

Current live note, 2026-06-26:

- Google Flights, Safari, OCU runtime:
  - `commerce_flow_until_final_confirmation` opened the passenger menu, clicked
    `Add adult`, and applied `Done`.
  - the route suggestion opened `Denpasar to Singapore | Google Flights`.
  - the search-results page initially loaded with `1 passenger`, so the proof
    repeated the passenger adjustment on the actual results page.
  - post-state showed `2 passengers`, `16 results returned`, `Prices include
required taxes + fees for 2 adults.`, and the first KLM round-trip fare
    updated to `4976964 Indonesian rupiahs`.
- The first KLM `Select flight` link remained the live blocker:
  - direct ref click and exact-label click were allowed by policy but did not
    advance to return-flight selection.
  - a generic `return` activation was blocked by policy as
    `submit_message_to_target` with `actionCount=0`.
  - a row-container click opened the safe emissions dialog instead of selecting
    the flight.
- Treat this as an OCU/GUI-control activation precision follow-up, not as a
  commerce-policy denial. Do not claim payment/final-booking boundary proof
  unless the live flow reaches a visible payment, booking, or final charge
  control.

## Software Update Flow

This proves `software_update_flow`: update discovery is allowed, but replacing
or relaunching executable code remains a higher-trust action.

Observe the app update surface:

```bash
pnpm jarvis gui-control observe \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Jarvis \
  --json \
  --max-elements 140
```

Click `Check for Updates`:

```bash
pnpm jarvis gui-control click \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Jarvis \
  --intent button \
  --label-includes "Check for Updates" \
  --task-policy software_update_flow \
  --approve-policy-risk \
  --allow-observed-click \
  --reason "Check whether a software update is available without installing it." \
  --json
```

Required blocked checks:

- `Install Update`, `Install on Quit`, `Install and Relaunch`,
  `Download and Install`, `Update Now`, `Relaunch to Update`, `Restart to
Update`, `Quit and Install`, and `Replace App` stay blocked without a
  higher-trust approval flow
- `safe_local_settings_navigation` still blocks update installation and
  operator/app-quit controls

Accepted proof:

- update availability, visible app name, visible version, and visible source are
  reported when available
- no install, download, replacement, restart, or relaunch action is performed

## Approved Software Update Install

This proves `software_update_install_approved`: after current user approval,
GUI-control can click a visible Sparkle-style install control without weakening
the normal update-discovery profile.

Hard preconditions:

- the user explicitly approved installing the visible app update in the current
  session
- a fresh observe result shows the app, update window, and exact final control
- the command uses `software_update_install_approved` and
  `--approve-policy-risk`
- the selected control text is a proven install control such as
  `Install and Relaunch`, `Install on Quit`, `Install Update`, or `Install Now`

Example:

```bash
pnpm jarvis gui-control click \
  --runtime open-computer-use \
  --runtime-command "$(cat /tmp/jarvis-ocu-stability-bin-path.txt)" \
  --app Jarvis \
  --ref @INSTALL_REF \
  --intent button \
  --task-policy software_update_install_approved \
  --approve-policy-risk \
  --allow-observed-click \
  --reason "Click the visible Jarvis software update install control after explicit current user approval." \
  --json
```

Required blocked checks under `software_update_install_approved`:

- `Download and Install`
- `Update Now`
- `Relaunch to Update`
- `Replace App`
- `Move to Applications`

Current live note, 2026-06-26:

- normal `software_update_flow` blocked Jarvis `Install and Relaunch` with
  `actionCount=0`
- `software_update_install_approved` clicked the visible Jarvis 2026.6.24
  `Install and Relaunch` control after explicit user approval
- Jarvis relaunched from pid `20105` to pid `5849`
- follow-up GUI-control observe on About showed `Version 2026.6.24`
- the approved click command returned nonzero because immediate post-state
  observation raced the relaunch; the follow-up observe is the version proof
