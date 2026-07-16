# Jarvis managed browser monitoring deferred

Status: deferred design record, not an active feature plan.

Date: 2026-07-16.

## Existing narrow capability

PRs #1156 and #1160 shipped a scoped, opt-in browser reply observer. The current
`openclaw browser-monitor observe` path watches one approved browser profile,
one exact tab target, one credential-free URL pattern, and one DOM selector. It
matches an explicit value, keeps a hash-only cursor, and wakes an existing
monitor through the loopback monitor-event hook.

That narrow observer is not a generic managed monitoring service. This record
does not reopen or replace it.

## Deferred product scope

Instagram direct messages are the first candidate because they provide a clear
conversation/reply use case where API access may be unavailable. The design
must remain generic enough for another browser-only inbox or support thread
without adding site-specific authority or broad page access.

Before implementation, every observer must bind all of these fields:

- browser profile;
- signed-in account identity or a user-approved account alias;
- credential-free URL pattern and stable conversation identity;
- exact observable region, such as a selector plus a bounded interpretation
  rule;
- destination monitor, origin session, and expiry.

Profile alone is not scope. A URL alone is not scope. The service must refuse
to start when the account, conversation, or observable region is ambiguous.

## Ownership and lifecycle

The user owns login and account authorization. Jarvis may manage the observer
process and its dedicated browser profile, but it must never collect, replay,
or persist passwords, cookies, passkeys, one-time codes, or recovery secrets.
Credential and approval gates remain user actions.

On service or machine restart, an observer may resume only from its durable
scope and cursor. It must revalidate the same profile, account, URL,
conversation, and region before reading. It must not fall back to another
profile, choose a similar tab, open unrelated conversations, or silently create
a fresh session. Ambiguity or a logged-out session degrades the monitor and asks
for user recovery.

Every observer needs a finite expiry, an explicit stop condition, and a direct
user stop path. Expiry, completion, logout, account change, revoked browser
access, or profile deletion must stop observation and release browser/process
resources. Logout never triggers automatic reauthentication.

## Drift and resource limits

Selector absence or invalidation is a scoped failure, not permission to inspect
more of the page. Retry with bounded backoff; after a small threshold, mark the
observer degraded and report which approved region drifted. A future
Instagram-specific adapter may version selectors, but every version still
needs the same explicit region and URL boundary.

A managed service must cap active observers, polling frequency, concurrent page
reads, per-check duration, retry rate, and retained cursor entries. It should
reuse an approved profile/session without creating a hidden browser farm. Idle,
expired, degraded, or logged-out observers must not burn unlimited CPU, memory,
tabs, or model turns.

## Privacy and authority

Persist only privacy-minimal structured evidence needed for deduplication and
recovery, for example:

- monitor and rule identifiers;
- hashes of the approved URL pattern, selector, observed state, and account
  alias;
- found/matched booleans, transition generation, and timestamps;
- bounded failure codes such as `logged_out`, `selector_missing`, or
  `scope_ambiguous`.

Do not retain cookies, credentials, message bodies, screenshots, tab titles,
full URLs containing private identifiers, or content from unrelated tabs by
default. Raw text may be compared transiently inside the approved region, then
discarded. Any richer evidence needs an explicit product and privacy decision.

External page and message content is evidence, never authority. It may cause a
pre-authorized exact monitor match, but it cannot widen scope, change the user
task, authorize a send, request secrets, or override approval boundaries.

## Action policy

The default is notify and draft to the original Jarvis conversation. Never
auto-send an Instagram or other browser reply without explicit user
authorization for that exact action scope. A match is permission to resume the
monitor, not permission to act on the external surface.

## Future acceptance matrix

| Case          | Required proof                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nonmatch      | A changed but nonmatching approved region advances only minimal cursor state; no monitor wake, user notification, or external action occurs.                                                      |
| Match         | One exact transition wakes the bound monitor once, preserves the original task, and produces a notify/draft result without auto-send.                                                             |
| Restart       | Service and machine restart resume only the same validated profile/account/conversation/region; unchanged state stays quiet and ambiguous or logged-out state fails closed.                       |
| Privacy       | Durable state contains only allowed hashes, identifiers, booleans, timestamps, and bounded error codes; no credentials, cookies, bodies, screenshots, private URLs, or unrelated-tab data appear. |
| Topic routing | A monitor created from a Telegram topic returns its update/draft to the canonical numeric chat and thread, then completes or remains active according to the original stop condition.             |

Do not begin this expansion until product scope, lifecycle ownership, privacy
retention, resource budgets, and this matrix are explicitly approved.
