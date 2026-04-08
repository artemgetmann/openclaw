#!/usr/bin/env python3
"""Send Himalaya templates with a narrow iCloud save-copy workaround.

This wrapper exists for one very specific failure mode we reproduced locally:
Himalaya v1.1.0 can time out while appending a sent copy to iCloud IMAP when
the message payload includes a larger attachment. The SMTP send still succeeds,
but the CLI exits with `cannot add IMAP message: request timed out`.

Do not retry that failure by re-sending the message. The timeout happens after
SMTP delivery, so a retry can duplicate delivery. Instead, this wrapper detects
larger iCloud attachment payloads up front and sends them once with
`message.send.save-copy = false`. That keeps the send inside Himalaya while
avoiding the duplicate-send trap. The tradeoff is explicit: the message goes
out, but the Sent-folder copy is skipped for those larger payloads.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover - Python 3.11+ on macOS
    raise SystemExit("Python 3.11+ is required for tomllib support") from exc


ICLOUD_IMAP_HOST = "imap.mail.me.com"
ICLOUD_SMTP_HOST = "smtp.mail.me.com"
SAVE_COPY_TIMEOUT_MARKER = "cannot add IMAP message: request timed out"
# The bug reproduced consistently with a ~465 KiB PDF and did not reproduce with
# a tiny PDF. Use a conservative threshold so iCloud large-attachment sends take
# the reliable path before Himalaya reaches the post-send append timeout.
ICLOUD_SAVE_COPY_ATTACHMENT_THRESHOLD_BYTES = 256 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read a Himalaya MML template from stdin, send it once normally, "
            "and retry iCloud append timeouts with save-copy disabled."
        )
    )
    parser.add_argument(
        "--account",
        required=True,
        help="Himalaya account name to use for template send.",
    )
    parser.add_argument(
        "--config",
        action="append",
        dest="config_paths",
        help=(
            "Himalaya config path. Repeat to mirror multiple `-c` flags. "
            "Defaults to $HIMALAYA_CONFIG or ~/.config/himalaya/config.toml."
        ),
    )
    parser.add_argument(
        "--himalaya-bin",
        default=os.environ.get("HIMALAYA_BIN", "himalaya"),
        help="Path to the Himalaya binary. Defaults to `himalaya`.",
    )
    return parser.parse_args()


def determine_config_paths(explicit_paths: list[str] | None) -> list[Path]:
    # Keep config resolution boring and predictable. Himalaya itself accepts a
    # single env path, while merged configs are passed as repeated `-c` flags.
    if explicit_paths:
        return [Path(path).expanduser() for path in explicit_paths]

    env_path = os.environ.get("HIMALAYA_CONFIG")
    if env_path:
        return [Path(env_path).expanduser()]

    return [Path("~/.config/himalaya/config.toml").expanduser()]


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_merged_config(config_paths: list[Path]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for path in config_paths:
        if not path.exists():
            continue
        with path.open("rb") as handle:
            data = tomllib.load(handle)
        merged = deep_merge(merged, data)
    return merged


def is_icloud_account(account: str, config_paths: list[Path]) -> bool:
    config = load_merged_config(config_paths)
    account_cfg = config.get("accounts", {}).get(account, {})
    backend_host = account_cfg.get("backend", {}).get("host")
    send_backend_host = (
        account_cfg.get("message", {})
        .get("send", {})
        .get("backend", {})
        .get("host")
    )
    email_addr = account_cfg.get("email", "")
    return (
        backend_host == ICLOUD_IMAP_HOST
        or send_backend_host == ICLOUD_SMTP_HOST
        or str(email_addr).endswith("@icloud.com")
    )


def build_command(
    himalaya_bin: str,
    config_paths: list[Path],
    account: str,
) -> list[str]:
    command = [himalaya_bin]
    for config_path in config_paths:
        command.extend(["-c", str(config_path)])
    command.extend(["template", "send", "-a", account])
    return command


def run_send(
    himalaya_bin: str,
    config_paths: list[Path],
    account: str,
    template_bytes: bytes,
) -> subprocess.CompletedProcess[bytes]:
    command = build_command(himalaya_bin, config_paths, account)
    return subprocess.run(
        command,
        input=template_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def write_stream(stream: Any, data: bytes) -> None:
    if data:
        stream.buffer.write(data)
        stream.flush()


def should_retry(account: str, config_paths: list[Path], output_text: str) -> bool:
    return is_icloud_account(account, config_paths) and SAVE_COPY_TIMEOUT_MARKER in output_text


def make_overlay(account: str) -> Path:
    # Quote the account name so unusual names still produce valid TOML.
    escaped_account = account.replace("\\", "\\\\").replace('"', '\\"')
    overlay_body = (
        f'[accounts."{escaped_account}"]\n'
        "message.send.save-copy = false\n"
    )
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        prefix="openclaw-himalaya-savecopy-off-",
        suffix=".toml",
        delete=False,
    )
    with handle:
        handle.write(overlay_body)
    return Path(handle.name)


def extract_attachment_paths(template_bytes: bytes) -> list[Path]:
    text = template_bytes.decode("utf-8", errors="replace")
    # MML attachments are declared as `<#part filename=/path/to/file><#/part>`
    # or `filename="/path with spaces/file.pdf"`. We only need enough parsing
    # to identify the local files used by the wrapper's documented send flow.
    pattern = re.compile(r"filename=(?:\"([^\"]+)\"|'([^']+)'|([^>\s]+))")
    paths: list[Path] = []
    for match in pattern.finditer(text):
        raw_path = match.group(1) or match.group(2) or match.group(3)
        if raw_path:
            paths.append(Path(raw_path).expanduser())
    return paths


def attachment_bytes(template_bytes: bytes) -> int:
    total = 0
    for path in extract_attachment_paths(template_bytes):
        if path.exists() and path.is_file():
            total += path.stat().st_size
    return total


def main() -> int:
    args = parse_args()
    config_paths = determine_config_paths(args.config_paths)
    template_bytes = sys.stdin.buffer.read()
    if not template_bytes.strip():
        print("No template content received on stdin.", file=sys.stderr)
        return 2

    config_is_icloud = is_icloud_account(args.account, config_paths)
    total_attachment_bytes = attachment_bytes(template_bytes)
    send_without_save_copy = (
        config_is_icloud
        and total_attachment_bytes >= ICLOUD_SAVE_COPY_ATTACHMENT_THRESHOLD_BYTES
    )

    effective_config_paths = config_paths
    overlay_path: Path | None = None
    if send_without_save_copy:
        print(
            "Detected a larger iCloud attachment payload. Sending once with "
            "`message.send.save-copy = false` to avoid Himalaya's post-send "
            "Sent-copy timeout.",
            file=sys.stderr,
        )
        overlay_path = make_overlay(args.account)
        effective_config_paths = [*config_paths, overlay_path]

    try:
        result = run_send(args.himalaya_bin, effective_config_paths, args.account, template_bytes)
    finally:
        if overlay_path is not None:
            overlay_path.unlink(missing_ok=True)

    combined_output = (result.stderr + result.stdout).decode("utf-8", errors="replace")
    write_stream(sys.stdout, result.stdout)
    write_stream(sys.stderr, result.stderr)

    if result.returncode == 0 and send_without_save_copy:
        print(
            "Message sent. Himalaya skipped the Sent-folder copy for this "
            "larger iCloud attachment payload.",
            file=sys.stderr,
        )
        return 0

    if result.returncode != 0 and should_retry(args.account, config_paths, combined_output):
        print(
            "Himalaya likely reached SMTP delivery before the iCloud Sent-copy "
            "append timed out. Not retrying automatically because that can "
            "duplicate delivery.",
            file=sys.stderr,
        )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
