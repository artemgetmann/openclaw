#!/usr/bin/env python3
"""Validate Control Tower Dashboard v2 syntax and lifecycle invariants."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import yaml


PARKED_PHASES = {"waiting-approval", "waiting-dependency"}
OPEN_PHASES = {"active", "queued", *PARKED_PHASES}
WAKE_MODES = {"thread-automation", "finite-goal", "manual-pull"}
WAKE_DRIVER_STATUSES = {"verified", "active", "unavailable", "failed", "complete"}
GOAL_STATES = {"absent", "active", "complete", "blocked"}


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    """Return a mapping while recording one useful structural error."""
    if isinstance(value, dict):
        return value
    errors.append(f"{label} must be a mapping")
    return {}


def require_int(mapping: dict[str, Any], key: str, label: str, errors: list[str]) -> int:
    """Read a non-boolean integer because YAML booleans are Python integers."""
    value = mapping.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    errors.append(f"{label}.{key} must be an integer")
    return 0


def require_number(
    mapping: dict[str, Any], key: str, label: str, errors: list[str]
) -> float:
    """Read a real number while rejecting YAML booleans."""
    value = mapping.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    errors.append(f"{label}.{key} must be a number")
    return 0.0


def validate_dashboard(document: Any) -> list[str]:
    """Return every deterministic dashboard violation in one pass."""
    errors: list[str] = []
    root = require_mapping(document, "dashboard", errors)
    epoch = require_mapping(root.get("epoch"), "epoch", errors)
    campaign = require_mapping(root.get("campaign"), "campaign", errors)
    heavy = require_mapping(root.get("heavy"), "heavy", errors)
    lanes_value = root.get("lanes")
    if not isinstance(lanes_value, list):
        errors.append("lanes must be a list")
        lanes: list[dict[str, Any]] = []
    else:
        lanes = []
        for index, lane_value in enumerate(lanes_value):
            lanes.append(require_mapping(lane_value, f"lanes[{index}]", errors))

    # Dashboard counters must describe the lane records, not an optimistic
    # narrative. This is the core defense against "nine lanes" meaning zero
    # workers.
    phase_counts: dict[str, int] = {}
    for index, lane in enumerate(lanes):
        phase = lane.get("phase")
        if not isinstance(phase, str):
            errors.append(f"lanes[{index}].phase must be a string")
            continue
        phase_counts[phase] = phase_counts.get(phase, 0) + 1

    active_count = require_int(campaign, "active_worker_count", "campaign", errors)
    parked_count = require_int(campaign, "parked_lane_count", "campaign", errors)
    open_count = require_int(campaign, "open_lane_count", "campaign", errors)
    target_count = require_int(campaign, "target_active_workers", "campaign", errors)
    parallelism_gap = require_int(campaign, "parallelism_gap", "campaign", errors)
    max_active = require_int(campaign, "max_active_workers", "campaign", errors)
    max_open = require_int(campaign, "max_open_lanes", "campaign", errors)

    actual_active = phase_counts.get("active", 0)
    actual_parked = sum(phase_counts.get(phase, 0) for phase in PARKED_PHASES)
    actual_open = sum(phase_counts.get(phase, 0) for phase in OPEN_PHASES)
    expected_gap = max(0, target_count - active_count)

    if active_count != actual_active:
        errors.append(
            f"campaign.active_worker_count={active_count}, but active lanes={actual_active}"
        )
    if parked_count != actual_parked:
        errors.append(
            f"campaign.parked_lane_count={parked_count}, but parked lanes={actual_parked}"
        )
    if open_count != actual_open:
        errors.append(f"campaign.open_lane_count={open_count}, but open lanes={actual_open}")
    if parallelism_gap != expected_gap:
        errors.append(
            f"campaign.parallelism_gap={parallelism_gap}, expected {expected_gap}"
        )
    if not 0 <= active_count <= max_active:
        errors.append("campaign.active_worker_count exceeds its configured bounds")
    if not 0 <= open_count <= max_open:
        errors.append("campaign.open_lane_count exceeds its configured bounds")

    lifecycle = epoch.get("lifecycle_state")
    wake_mode = epoch.get("wake_mode")
    wake_driver_status = epoch.get("wake_driver_status")
    wake_driver_verified_at = epoch.get("wake_driver_verified_at")
    automation_id = epoch.get("automation_id")
    automation_canary_event_id = epoch.get("automation_canary_event_id")
    goal_state = epoch.get("goal_state")
    reconciliation_due = epoch.get("reconciliation_due")
    next_reconcile_by = epoch.get("next_reconcile_by")
    alert_required = epoch.get("alert_required")
    queued_count = phase_counts.get("queued", 0)
    capacity_retry_count = require_int(
        epoch, "capacity_retry_count", "epoch", errors
    )
    capacity_retry_limit = require_int(
        epoch, "capacity_retry_limit", "epoch", errors
    )

    if wake_mode not in WAKE_MODES:
        errors.append(
            "epoch.wake_mode must be thread-automation, finite-goal, or manual-pull"
        )
    if wake_driver_status not in WAKE_DRIVER_STATUSES:
        errors.append("epoch.wake_driver_status has an unsupported value")
    if goal_state not in GOAL_STATES:
        errors.append("epoch.goal_state has an unsupported value")
    if capacity_retry_limit <= 0:
        errors.append("epoch.capacity_retry_limit must be positive")
    if not 0 <= capacity_retry_count <= capacity_retry_limit:
        errors.append(
            "epoch.capacity_retry_count must be between zero and its configured limit"
        )

    # A native heartbeat is trustworthy only after the exact scheduled thread
    # proves it can reconcile through native thread tools.
    if wake_mode == "thread-automation":
        if wake_driver_status not in {"verified", "active"}:
            errors.append(
                "thread-automation requires a verified or active wake driver"
            )
        if wake_driver_verified_at is None:
            errors.append("thread-automation requires epoch.wake_driver_verified_at")
        if automation_id is None:
            errors.append("thread-automation requires epoch.automation_id")
        if automation_canary_event_id is None:
            errors.append(
                "thread-automation requires epoch.automation_canary_event_id"
            )
        if next_reconcile_by is None:
            errors.append("thread-automation requires epoch.next_reconcile_by")

    # The finite goal is the active fallback, not a decorative dashboard label.
    # It may be complete only after executable work has reached a parked or
    # terminal boundary.
    if wake_mode == "finite-goal":
        executable_count = active_count + queued_count
        if executable_count > 0:
            if wake_driver_status != "active":
                errors.append(
                    "finite-goal with executable work requires "
                    "epoch.wake_driver_status=active"
                )
            if goal_state != "active":
                errors.append(
                    "finite-goal with executable work requires epoch.goal_state=active"
                )
            if lifecycle not in {"active", "awaiting-pull"}:
                errors.append(
                    "finite-goal with executable work must be active or awaiting-pull"
                )
        elif wake_driver_status not in {"active", "complete"}:
            errors.append(
                "finite-goal without executable work requires an active or complete driver"
            )
        if goal_state == "blocked":
            errors.append(
                "finite-goal cannot use blocked for expected coordination waiting"
            )

    # Manual pull has no autonomous future event. If executable work is queued
    # and no worker is active, calling the tower healthy hides a stalled fleet.
    manual_stall = (
        wake_mode == "manual-pull"
        and active_count == 0
        and queued_count > 0
        and next_reconcile_by is None
    )
    if manual_stall:
        if lifecycle != "degraded-idle":
            errors.append(
                "manual-pull with queued work, zero workers, and no reconcile deadline "
                "must be degraded-idle"
            )
        if reconciliation_due is not True:
            errors.append("manual-pull stalled work must set epoch.reconciliation_due=true")
        if alert_required is not True:
            errors.append("manual-pull stalled work must set epoch.alert_required=true")

    if lifecycle == "healthy-idle":
        if active_count != 0:
            errors.append("healthy-idle cannot have active workers")
        if queued_count != 0:
            errors.append("healthy-idle cannot have executable queued lanes")
        if reconciliation_due is not False:
            errors.append("healthy-idle must set epoch.reconciliation_due=false")
    if lifecycle == "degraded-idle" and alert_required is not True:
        errors.append("degraded-idle must set epoch.alert_required=true")
    if wake_mode == "manual-pull":
        if wake_driver_status not in {"unavailable", "failed", "complete"}:
            errors.append(
                "manual-pull requires an unavailable, failed, or complete wake driver"
            )
        if goal_state == "active":
            errors.append("manual-pull cannot declare an active goal")
    if wake_mode == "manual-pull" and active_count > 0 and reconciliation_due is not True:
        errors.append("manual-pull with active workers must set epoch.reconciliation_due=true")

    owner = heavy.get("owner_lane_id")
    heavy_state = heavy.get("state")
    lane_ids = {lane.get("id") for lane in lanes if isinstance(lane.get("id"), str)}
    if owner is not None and owner not in lane_ids:
        errors.append("heavy.owner_lane_id must reference a tracked lane")
    if owner is None and heavy_state != "free":
        errors.append("heavy.state must be free when no heavy owner is designated")

    # Rotation is deterministic: once any measured threshold is reached, the
    # dashboard must drain rather than rely on the coordinator remembering.
    rotate_at = require_mapping(epoch.get("rotate_at"), "epoch.rotate_at", errors)
    integer_thresholds = (
        "context_compactions",
        "terminal_lane_transitions",
        "transcript_bytes",
    )
    computed_reasons: list[str] = []
    for key in integer_thresholds:
        measured = require_int(epoch, key, "epoch", errors)
        threshold = require_int(rotate_at, key, "epoch.rotate_at", errors)
        if threshold > 0 and measured >= threshold:
            computed_reasons.append(key)

    elapsed_hours = require_number(epoch, "elapsed_hours", "epoch", errors)
    max_elapsed_hours = require_number(
        rotate_at, "elapsed_hours", "epoch.rotate_at", errors
    )
    if max_elapsed_hours > 0 and elapsed_hours >= max_elapsed_hours:
        computed_reasons.append("elapsed_hours")

    rotation_due_value = epoch.get("rotation_due")
    if not isinstance(rotation_due_value, bool):
        errors.append("epoch.rotation_due must be a boolean")
    elif rotation_due_value != bool(computed_reasons):
        errors.append("epoch.rotation_due must match the measured rotation thresholds")

    rotation_reasons = epoch.get("rotation_reasons")
    if not isinstance(rotation_reasons, list) or not all(
        isinstance(reason, str) for reason in rotation_reasons
    ):
        errors.append("epoch.rotation_reasons must be a list of strings")
    elif set(rotation_reasons) != set(computed_reasons):
        errors.append("epoch.rotation_reasons must match the measured thresholds")

    if computed_reasons:
        if epoch.get("rotation_status") != "draining":
            errors.append("reached rotation threshold requires epoch.rotation_status=draining")
        if lifecycle != "draining":
            errors.append("reached rotation threshold requires epoch.lifecycle_state=draining")
        if campaign.get("intake_state") != "frozen":
            errors.append("reached rotation threshold requires campaign.intake_state=frozen")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dashboard", type=Path)
    args = parser.parse_args()

    try:
        document = yaml.safe_load(args.dashboard.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 2

    errors = validate_dashboard(document)
    if errors:
        for error in errors:
            print(f"INVALID: {error}", file=sys.stderr)
        return 1

    print("Dashboard v2 is valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
