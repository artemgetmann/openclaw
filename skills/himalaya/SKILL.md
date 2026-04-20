---
name: himalaya
description: "Use for generic email tasks on connected mail accounts: search, read, summarize, draft, reply, forward, send, and organize email over IMAP/SMTP. This is the better match for normal mailbox work that is not specifically a Gmail or Google Workspace request."
homepage: https://github.com/pimalaya/himalaya
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires": { "bins": ["himalaya"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "himalaya",
              "bins": ["himalaya"],
              "label": "Install Himalaya (brew)",
            },
          ],
      },
  }
---

# Himalaya Email CLI

Himalaya is a CLI email client that lets you manage emails from the terminal using IMAP, SMTP, Notmuch, or Sendmail backends.

## References

- `references/configuration.md` (config file setup + IMAP/SMTP authentication)
- `references/message-composition.md` (MML syntax for composing emails)
- `scripts/send_template.py` (shared Himalaya send wrapper with narrow iCloud retry)
- `scripts/icloud_send_smoke.py` (repeatable iCloud send smoke harness)

## Prerequisites

1. Himalaya CLI installed (`himalaya --version` to verify)
2. A configuration file at `~/.config/himalaya/config.toml`
3. IMAP/SMTP credentials configured (password stored securely)
4. For the stock Homebrew build, prefer password or app-password auth. The local `himalaya v1.1.0` build here does not include OAuth2 support.

## Automation Rule

- Prefer direct safe-bin invocation first: `himalaya account list`,
  `himalaya folder list`, then `himalaya envelope list`.
- In Normal permissions mode, direct `himalaya ...` commands are allowed. The
  default restriction is on shell wrappers (`bash -lc`, `sh -c`), pipes,
  chaining, and redirection.
- If you wrap `himalaya` through `openclaw nodes run`, insert `--` before the
  child argv so Himalaya keeps its own flags.
- Ban dumb shell chaining, pipes, and redirection around `himalaya`.
- Allow node execution when the runtime supports it. Missing
  `system.run.prepare` alone does not make Himalaya execution invalid.

## Configuration Setup

Run the interactive wizard to set up an account:

```bash
himalaya account configure personal
```

Or create `~/.config/himalaya/config.toml` manually:

```toml
[accounts.personal]
email = "you@example.com"
display-name = "Your Name"
default = true

folder.aliases.inbox = "INBOX"
folder.aliases.sent = "Sent"
folder.aliases.drafts = "Drafts"
folder.aliases.trash = "Trash"

backend.type = "imap"
backend.host = "imap.example.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "you@example.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show email/imap"  # or use keyring

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "you@example.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show email/smtp"
```

Use the provider-specific Gmail and iCloud templates in `references/configuration.md` instead of guessing mailbox names.

## Common Operations

### List Folders

```bash
himalaya folder list
```

### List Emails

List emails in INBOX (default):

```bash
himalaya envelope list
```

List emails in a specific folder:

```bash
himalaya envelope list --folder "Sent"
```

List with pagination:

```bash
himalaya envelope list --page 1 --page-size 20
```

### Search Emails

```bash
himalaya envelope list from john@example.com subject meeting
```

### Read an Email

Read email by ID (shows plain text):

```bash
himalaya message read 42
```

Export raw MIME:

```bash
himalaya message export 42 --full
```

### Reply to an Email

Interactive reply (opens $EDITOR):

```bash
himalaya message reply 42
```

Reply-all:

```bash
himalaya message reply 42 --all
```

### Forward an Email

```bash
himalaya message forward 42
```

### Write a New Email

Interactive compose (opens $EDITOR):

```bash
himalaya message write
```

Send directly using template:

```bash
cat << 'EOF' | python3 skills/himalaya/scripts/send_template.py --account personal
From: you@example.com
To: recipient@example.com
Subject: Test Message

Hello from Himalaya!
EOF
```

For agent-run or scripted CLI sends, prefer this wrapper over raw `himalaya
template send`. It behaves like normal Himalaya for no-attachment and
small-attachment sends, so those still save a Sent copy. Only larger iCloud
attachment payloads flip `message.send.save-copy = false` to avoid Himalaya's
post-send IMAP append timeout.

Or with headers flag:

```bash
himalaya message write -H "To:recipient@example.com" -H "Subject:Test" "Message body here"
```

### Move/Copy Emails

Move to folder:

```bash
himalaya message move "Archive" 42
```

Copy to folder:

```bash
himalaya message copy "Important" 42
```

### Delete an Email

```bash
himalaya message delete 42
```

### Manage Flags

Add flag:

```bash
himalaya flag add 42 seen
```

Remove flag:

```bash
himalaya flag remove 42 seen
```

## Multiple Accounts

List accounts:

```bash
himalaya account list
```

Use a specific account:

```bash
himalaya envelope list -a work
```

## Attachments

Save attachments from a message:

```bash
himalaya attachment download 42
```

Save to specific directory:

```bash
himalaya attachment download 42 --dir ~/Downloads
```

## Output Formats

Most commands support `--output` for structured output:

```bash
himalaya envelope list --output json
himalaya envelope list --output plain
```

## Debugging

Enable debug logging:

```bash
RUST_LOG=debug himalaya envelope list
```

Full trace with backtrace:

```bash
RUST_LOG=trace RUST_BACKTRACE=1 himalaya envelope list
```

## Tips

- Use `himalaya --help` or `himalaya <command> --help` for detailed usage.
- In v1.1.x, account selection lives on the subcommand: `himalaya envelope list -a work`, not `himalaya --account work ...`.
- Message IDs are relative to the current folder; re-list after folder changes.
- For composing rich emails with attachments, use MML syntax (see `references/message-composition.md`).
- Store passwords securely using `pass`, system keyring, or a command that outputs the password.
- For automated sends, prefer `python3 skills/himalaya/scripts/send_template.py --account <name>` over raw `himalaya template send`.
- If the wrapper reports that it skipped the Sent copy for a larger iCloud attachment payload, tell the user plainly:
  - the email was sent through Himalaya
  - the Sent-folder copy was intentionally skipped to avoid the iCloud IMAP append timeout
  - not seeing it in Sent does not mean the send failed
- When a user asks for proof after a Sent-copy skip, prefer concrete evidence:
  - send a copy to the user's own address and verify it arrived in Inbox
  - or show that the intended recipient replied / did not bounce
  - do not claim Sent-folder presence when the wrapper explicitly skipped it
