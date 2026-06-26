# GUI Control Purchase, Update, and Approval Plan

Status: implementation slice plus follow-up plan
Last updated: 2026-06-26

## Current Implementation Truth

- `read_only_web_context` remains read-only.
- `safe_local_settings_navigation` remains narrow. It allows safe local
  settings row navigation, but not operator controls, app quit, account changes,
  destructive actions, or update installation.
- `non_committal_web_dry_run` remains a browser search/navigation dry run. It
  still blocks passenger/traveler, checkout, payment, booking, purchase, login,
  and confirmation surfaces.
- `commerce_flow_until_final_confirmation` allows reversible commerce and travel
  progress until payment or final confirmation.
- `software_update_flow` allows update discovery such as `Check for Updates`.
  Download, install, replacement, restart, and relaunch controls remain blocked.
- `software_update_install_approved` is a narrow current-approval profile for
  visible Sparkle-style install controls such as `Install and Relaunch` and
  `Install on Quit`. It still requires explicit mutation approval and does not
  unblock replacement, move-to-Applications, or broad updater flows.

## First-Principles Boundary

The goal is task-agnostic GUI control, not hardcoded Jarvis, Google Flights, or
Amazon scripts.

Task-agnostic does not mean one global policy can click every visible button.
It means each policy grants a reusable risk class:

- read a screen
- type into a verified target
- click a verified non-destructive control
- proceed through a reversible workflow
- stop before money movement, credential entry, executable replacement, or
  irreversible state change
- continue past that stop only after a higher-trust approval flow

Profiles are capability envelopes, not task scripts.

## Commerce Boundary

Allowed under `commerce_flow_until_final_confirmation`:

- passenger count controls
- fare selection
- cart and add-to-cart flows
- checkout navigation before payment
- shipping/address selection when already present
- passenger, traveler, contact, or address detail entry when explicitly
  supplied by the user

Blocked under `commerce_flow_until_final_confirmation`:

- payment method entry or changes
- credit/debit/payment card entry
- final charge buttons such as `Pay`, `Pay now`, `Place order`, `Confirm
booking`, `Buy now`, `Purchase`, or equivalent
- OTP, passkey, password, login, or sign-in
- account/security settings changes
- cancellation, deletion, refund, or other destructive actions

Important limitation: the current policy can check that the audit reason says a
detail was explicitly supplied by the user. It cannot cryptographically prove
that the typed value matches a user-provided source. That requires an approval
or task-context object passed into GUI-control.

## Software Update Boundary

Allowed under `software_update_flow`:

- navigating update surfaces
- clicking `Check for Updates`
- reading available version/source/release metadata

Blocked under `software_update_flow`:

- downloading an update
- installing an update
- replacing an app bundle
- restarting or relaunching into a new binary
- moving an app into Applications

Why: app updates replace executable code. That is a different risk class from
opening a settings row or checking availability.

Allowed under `software_update_install_approved` after explicit current user
approval:

- `Install and Relaunch`
- `Install on Quit`
- `Install Update`
- `Install Now`

Still blocked under `software_update_install_approved`:

- `Download and Install`
- `Update Now`
- `Relaunch to Update`
- replacing an app bundle
- moving an app into Applications

This is intentionally not a generic app-update bypass. It exists so a live
operator can approve and prove one visible Sparkle install control without
turning the safe discovery profile into an installer.

## Approval UX Follow-Up

Existing exec approval infrastructure already supports Telegram approval
forwarding and explicit Telegram buttons:

- docs: `docs/channels/telegram.md`, `docs/tools/exec-approvals.md`
- forwarding: `src/infra/exec-approval-forwarder.ts`
- reply payload metadata: `src/infra/exec-approval-reply.ts`
- command approval runtime: `src/agents/bash-tools.exec-runtime.ts`
- Telegram button delivery: `src/infra/outbound/deliver.test.ts`

Do not bolt GUI final-action approval onto `--approve-policy-risk` directly.
That flag only says the current mutation is intentional; it is not enough for
money movement or app installation.

Recommended next slice:

1. Add a GUI approval request type that records app, window, element ref,
   element label, task policy, action type, value summary, reason, expiry, and a
   nonce.
2. Add an approval lifecycle helper parallel to exec approvals, or extend exec
   approvals with a non-command request kind only if the storage/API shape stays
   clear.
3. Render Telegram approval cards with `Approve` and `Cancel` inline buttons
   when Telegram inline buttons are enabled.
4. Restrict approval callbacks to configured approvers.
5. Fall back to exact nonce text such as `Approve JX7K`; never accept bare
   `yes` for payment, booking, or update installation.
6. Resume only the exact blocked action after approval. If the element label,
   app, window, amount/version/source, or final-control text changes, require a
   new approval.

Approval card facts should include:

- app/site/merchant
- action class
- item/version/route
- total price or update version/source when known
- payment/shipping/passenger identity summary when relevant
- exact final button/control text
- expiry

## Live Smoke Plan

Travel smoke:

- use Google Flights or a real travel flow
- allow passenger count and search/fare exploration
- optionally enter supplied passenger/contact details
- stop at payment or final charge confirmation
- report route, fare/baggage, total price if visible, and exact blocked final
  control

Commerce smoke:

- search/select a low-risk item
- add to cart or proceed through checkout setup
- stop before final purchase/payment confirmation
- report merchant, item, quantity, price, shipping/payment summary if visible,
  and exact blocked final control

Software update smoke:

- navigate to the app About/update surface
- click `Check for Updates`
- read available update state
- normally stop before install, download, replace, restart, or relaunch
- for an explicitly approved dogfood update, switch to
  `software_update_install_approved`, click the visible install control, and
  report the exact app/version/source/control text

Current live note, 2026-06-26:

- normal `software_update_flow` blocked `Install and Relaunch` for Jarvis
  2026.6.24 with `actionCount=0`
- `software_update_install_approved` clicked the visible `Install and
Relaunch` control after explicit user approval
- Jarvis relaunched from pid `20105` to pid `5849`
- post-update About screen showed `Version 2026.6.24`
- the approved click command exited nonzero because immediate post-state
  observation raced the app relaunch; the follow-up observe provided the final
  version proof

Travel proof update, 2026-06-26:

- Google Flights under `commerce_flow_until_final_confirmation` proved:
  - passenger menu open
  - `Add adult`
  - `Done`
  - Denpasar to Singapore route suggestion activation
  - results page with `2 passengers`
  - `16 results returned`
  - `Prices include required taxes + fees for 2 adults.`
  - first KLM round-trip fare visible as `4976964 Indonesian rupiahs`
- The live flow did not reach the return-flight or payment boundary because the
  visible first KLM `Select flight` link did not activate through the current
  OCU click path:
  - ref click and exact-label click were allowed by policy but did not advance
  - row-container click opened the safe climate/emissions dialog
  - `return` activation was blocked as `submit_message_to_target` with
    `actionCount=0`
- Follow-up should fix semantic activation for Google Flights result links or
  add a narrowly-scoped safe activation model for focused links/buttons. Do not
  loosen the commerce profile broadly, and do not treat generic `return` as safe
  when a final charge, login, or destructive control might be focused.

Use isolated tester Jarvis/Telegram proof first when approval UX is added. Real
main Jarvis dogfood proof should happen only after tester proof passes.
