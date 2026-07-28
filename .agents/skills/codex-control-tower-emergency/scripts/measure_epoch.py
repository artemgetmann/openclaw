#!/usr/bin/env python3
"""Measure deterministic Codex control-tower rotation thresholds."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-file", required=True, type=Path)
    parser.add_argument("--started-at", required=True, help="ISO-8601 epoch start")
    parser.add_argument("--terminal-lanes", required=True, type=int)
    parser.add_argument("--max-compactions", type=int, default=10)
    parser.add_argument("--max-terminal-lanes", type=int, default=10)
    parser.add_argument("--max-hours", type=float, default=24.0)
    parser.add_argument("--max-bytes", type=int, default=8 * 1024 * 1024)
    args = parser.parse_args()

    started_at = parse_utc(args.started_at)
    compactions = 0

    # Count only first-class compaction events after this epoch began. Text
    # mentions inside tool outputs are deliberately ignored.
    with args.session_file.open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            if record.get("type") != "event_msg":
                continue
            payload = record.get("payload") or {}
            if payload.get("type") != "context_compacted":
                continue
            timestamp = record.get("timestamp")
            if timestamp and parse_utc(timestamp) >= started_at:
                compactions += 1

    transcript_bytes = args.session_file.stat().st_size
    elapsed_hours = (
        dt.datetime.now(dt.timezone.utc) - started_at
    ).total_seconds() / 3600

    reasons: list[str] = []
    if compactions >= args.max_compactions:
        reasons.append("context_compactions")
    if args.terminal_lanes >= args.max_terminal_lanes:
        reasons.append("terminal_lane_transitions")
    if elapsed_hours >= args.max_hours:
        reasons.append("elapsed_hours")
    if transcript_bytes >= args.max_bytes:
        reasons.append("transcript_bytes")

    result = {
        "context_compactions": compactions,
        "terminal_lane_transitions": args.terminal_lanes,
        "elapsed_hours": round(elapsed_hours, 3),
        "transcript_bytes": transcript_bytes,
        "rotation_due": bool(reasons),
        "rotation_reasons": reasons,
    }
    print(json.dumps(result, sort_keys=True))
    return 10 if reasons else 0


if __name__ == "__main__":
    raise SystemExit(main())
