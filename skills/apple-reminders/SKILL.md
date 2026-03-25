---
name: apple-reminders
description: Manage Apple Reminders via remindctl CLI (list, add, edit, complete, delete). Supports lists, date filters, and JSON/plain output.
homepage: https://github.com/steipete/remindctl
metadata:
  {
    "openclaw":
      {
        "emoji": "⏰",
        "os": ["darwin"],
        "requires": { "bins": ["remindctl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/remindctl",
              "bins": ["remindctl"],
              "label": "Install remindctl via Homebrew",
            },
          ],
      },
  }
---

# Apple Reminders CLI (remindctl)

Use `remindctl` to manage Apple Reminders directly from the terminal.

## When to Use

✅ **USE this skill when:**

- User explicitly mentions "reminder" or "Reminders app"
- Creating personal to-dos with due dates that sync to iOS
- Managing Apple Reminders lists
- User wants tasks to appear in their iPhone/iPad Reminders app

## When NOT to Use

❌ **DON'T use this skill when:**

- Scheduling OpenClaw tasks or alerts → use `cron` tool with systemEvent instead
- Calendar events or appointments → use Apple Calendar
- Project/work task management → use Notion, GitHub Issues, or task queue
- One-time notifications → use `cron` tool for timed alerts
- User says "remind me" but means an OpenClaw alert → clarify first

## Automation Rule

- On a local macOS machine, use the local host directly. Do not route reminder
  creation through `nodes run` / `system.run` when the host already has
  `remindctl`.
- Use `remindctl ... --json` when you need machine-checkable verification or
  cleanup.
- After delete, re-check after a short delay because Reminders can take a
  moment to converge.

## Setup Routing

- If `remindctl` is missing or Reminders access is not authorized yet, use the
  shared `consumer-setup` skill.
- Once setup is complete, verify with `remindctl status` or a read-only list
  call before creating reminders.

## Common Commands

### View Reminders

```bash
remindctl                    # Today's reminders
remindctl today              # Today
remindctl tomorrow           # Tomorrow
remindctl week               # This week
remindctl overdue            # Past due
remindctl all                # Everything
remindctl 2026-01-04         # Specific date
```

### Manage Lists

```bash
remindctl list               # List all lists
remindctl list Work          # Show specific list
remindctl list Projects --create    # Create list
remindctl list Work --delete        # Delete list
```

### Create Reminders

```bash
remindctl add "Buy milk"
remindctl add --title "Call mom" --list Personal --due tomorrow
remindctl add --title "Meeting prep" --due "2026-02-15 09:00"
remindctl add --title "Test reminder" --list Reminders --due "2026-02-15 09:00" --json
```

### Complete/Delete

```bash
remindctl complete 1 2 3     # Complete by ID
remindctl delete 4A83 --force  # Delete by ID
remindctl delete 4A83 --force --json
```

### Output Formats

```bash
remindctl today --json       # JSON for scripting
remindctl today --plain      # TSV format
remindctl today --quiet      # Counts only
```

## Date Formats

Accepted by `--due` and date filters:

- `today`, `tomorrow`, `yesterday`
- `YYYY-MM-DD`
- `YYYY-MM-DD HH:mm`
- ISO 8601 (`2026-01-04T12:34:56Z`)

## Example: Clarifying User Intent

User: "Remind me to check on the deploy in 2 hours"

**Ask:** "Do you want this in Apple Reminders (syncs to your phone) or as an OpenClaw alert (I'll message you here)?"

- Apple Reminders → use this skill
- OpenClaw alert → use `cron` tool with systemEvent

## Verification Pattern

For a clean create/verify/delete cycle:

```bash
remindctl add --title "OpenClaw test" --list Reminders --due "2026-02-15 09:00" --json
remindctl 2026-02-15 --json
remindctl delete <id> --force --json
sleep 3
remindctl 2026-02-15 --json
```
