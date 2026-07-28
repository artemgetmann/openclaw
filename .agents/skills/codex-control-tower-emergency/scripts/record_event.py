#!/usr/bin/env python3
"""Append one bounded control-tower telemetry event as JSONL."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path


EVENT_TYPES = {
    "wake_attempt",
    "wake_success",
    "wake_skipped_active",
    "wake_deferred_capacity",
    "wake_failed",
    "callback_missing_reconciled",
    "callback_duplicate",
    "self_callback_blocked",
    "dashboard_stale",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--event", required=True, choices=sorted(EVENT_TYPES))
    parser.add_argument("--epoch", required=True)
    parser.add_argument("--lane")
    parser.add_argument("--detail")
    args = parser.parse_args()

    # Keep the telemetry contract deliberately small. Details are operational
    # labels, never copied worker payloads, secrets, or command output.
    record = {
        "timestamp": dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "epoch": args.epoch,
        "event": args.event,
    }
    if args.lane:
        record["lane"] = args.lane
    if args.detail:
        record["detail"] = args.detail[:240]

    encoded = (
        json.dumps(record, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode()

    # O_APPEND makes each one-write record append at the current end even when
    # a cron wake and a native callback report at nearly the same time.
    args.log.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(args.log, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, encoded)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
