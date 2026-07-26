# Jarvis Isolated Browser Retirement

Status: active short-lived cleanup tracker

Purpose: finish retiring the isolated `openclaw` browser from Jarvis without
silently deleting browser state that may contain cookies, downloads, or other
user-owned session data. Generic OpenClaw keeps this engine capability.

## Now

- [x] Restrict Jarvis agent routing and profile discovery to `signed-in` and
      `user-live`.
- [x] Migrate app-owned legacy `user` configuration to `signed-in` and remove
      the app-owned isolated profile declaration without deleting disk data.
- [ ] After one stable public Jarvis package has shipped with this policy,
      present the cleanup preview to the owner and request explicit deletion
      approval.

## Cleanup Gate

Do not delete anything until all of these are true:

1. At least one public Jarvis package containing the two-browser policy has been
   installed and used successfully.
2. The active Jarvis config has no default or explicit route to `openclaw`.
3. No running browser process uses the candidate user-data directory.
4. A dry run reports the exact resolved path, total size, and whether the
   directory contains downloads or non-cache profile data.
5. The owner explicitly approves cleanup after seeing that preview.

The normal production candidate is:

```text
~/Library/Application Support/Jarvis/.jarvis/browser/openclaw/user-data
```

Consumer test instances can have separate candidates under their own state
directories. Never glob across app-support roots or delete generic OpenClaw
browser data.

## Confirmed Cleanup Procedure

1. Resolve the active Jarvis state directory from runtime provenance; do not
   assume the production path.
2. Recheck the cleanup gate and show the owner the dry-run inventory.
3. After approval, move only the verified
   `$OPENCLAW_STATE_DIR/browser/openclaw` directory to Trash or a dated
   quarantine location.
4. Keep the quarantine for seven days and prove Jarvis browser tasks still use
   the selected Chrome account.
5. Permanently delete the quarantine only with fresh approval.
6. Move this tracker to `docs/consumer/archive/` and remove its active link
   after cleanup proof is complete.

Rollback before permanent deletion: restore the quarantined directory to its
exact original state path. Restoring data does not re-enable the retired Jarvis
routing policy.
