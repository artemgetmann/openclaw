---
title: "HEARTBEAT.md Template"
summary: "Workspace template for HEARTBEAT.md"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md

# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Heartbeat is for broad periodic sweeps and ambient awareness. Do not use it as the default

# home for reminders or explicit inbox/thread/person monitors.

# Prefer cron for reminders, exact scheduled checks, or "watch this until X happens".

#

# Safe example to try:

# - Once each morning, do one broad sweep of my world and only alert me if something looks important.

# - Prefer net-new action-needed items. If you already surfaced the same unresolved blocker recently,

# do not resend the full alert unless something materially changed; use a shorter nudge if needed.

#

# - If something is blocked on my approval/decision/input, say that explicitly and keep the ask short.

#

# - If a deeper recurring monitor would help, suggest one cron job with a cadence, stop condition, and expiry first. Otherwise reply HEARTBEAT_OK.
