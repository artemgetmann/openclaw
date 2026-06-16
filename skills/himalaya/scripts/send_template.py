#!/usr/bin/env python3
"""Send Himalaya templates with local proof and a narrow iCloud workaround.

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

The wrapper also archives the exact outgoing template plus command-result
metadata before/after the send. That local proof is not delivery confirmation
[proof the recipient received it], because Himalaya v1 does not expose SMTP
RCPT acceptance details. It does give Jarvis a durable Message-ID and command
receipt without trusting iCloud Sent as the only evidence.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from email.utils import getaddresses, make_msgid
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover - Python 3.11+ on macOS
    raise SystemExit("Python 3.11+ is required for tomllib support") from exc


ICLOUD_IMAP_HOST = "imap.mail.me.com"
ICLOUD_SMTP_HOST = "smtp.mail.me.com"
# Himalaya v1 couples SMTP delivery and the IMAP Sent-copy append into one
# command. These markers mean the failure happened in the post-send archive
# step, so retrying the whole command can duplicate the real email delivery.
SAVE_COPY_APPEND_FAILURE_MARKERS = (
    "cannot add imap message: request timed out",
    "cannot add imap message: quota exceeded",
)
# The bug reproduced consistently with a ~465 KiB PDF and did not reproduce with
# a tiny PDF. Use a conservative threshold so iCloud large-attachment sends take
# the reliable path before Himalaya reaches the post-send append timeout.
ICLOUD_SAVE_COPY_ATTACHMENT_THRESHOLD_BYTES = 256 * 1024
DEFAULT_PROOF_DIR = Path("~/.local/state/openclaw/email-send-proof").expanduser()
MAX_CAPTURED_OUTPUT_CHARS = 12_000


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
    parser.add_argument(
        "--proof-dir",
        default=os.environ.get("OPENCLAW_EMAIL_PROOF_DIR", str(DEFAULT_PROOF_DIR)),
        help=(
            "Directory for local .eml and JSON send proof. Defaults to "
            "$OPENCLAW_EMAIL_PROOF_DIR or ~/.local/state/openclaw/email-send-proof."
        ),
    )
    parser.add_argument(
        "--no-proof-archive",
        action="store_true",
        help=(
            "Disable local proof artifacts. Use only for an explicitly approved "
            "one-off send where local archival is not desired."
        ),
    )
    parser.add_argument(
        "--audit-bcc",
        action="append",
        default=[],
        help=(
            "Explicit audit Bcc recipient to add before sending. Repeat for "
            "multiple recipients; never added implicitly."
        ),
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


def is_save_copy_append_failure(output_text: str) -> bool:
    normalized_output = output_text.lower()
    if any(marker in normalized_output for marker in SAVE_COPY_APPEND_FAILURE_MARKERS):
        return True
    # Himalaya can render error chains with the operation and provider reason on
    # separate lines, e.g. `cannot add IMAP message` followed by
    # `unexpected NO response: Quota Exceeded`. That is still the same
    # post-SMTP IMAP Sent-copy append class and must not trigger a resend.
    return "cannot add imap message" in normalized_output and "quota exceeded" in normalized_output


def should_retry(account: str, config_paths: list[Path], output_text: str) -> bool:
    return is_icloud_account(account, config_paths) and is_save_copy_append_failure(output_text)


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


def split_template(template_bytes: bytes) -> tuple[str, str]:
    text = template_bytes.decode("utf-8", errors="replace")
    if "\r\n\r\n" in text:
        headers, body = text.split("\r\n\r\n", 1)
        return headers.replace("\r\n", "\n"), body
    if "\n\n" in text:
        headers, body = text.split("\n\n", 1)
        return headers, body
    return text, ""


def parse_header_values(headers: str) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {}
    current_name: str | None = None
    current_value_parts: list[str] = []

    def flush_current() -> None:
        nonlocal current_name, current_value_parts
        if current_name is not None:
            values.setdefault(current_name.lower(), []).append(" ".join(current_value_parts).strip())
        current_name = None
        current_value_parts = []

    for line in headers.splitlines():
        if line.startswith((" ", "\t")) and current_name is not None:
            current_value_parts.append(line.strip())
            continue
        flush_current()
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        current_name = name.strip()
        current_value_parts = [value.strip()]

    flush_current()
    return values


def infer_message_id_domain(headers: dict[str, list[str]]) -> str:
    from_values = headers.get("from", [])
    addresses = getaddresses(from_values)
    for _display_name, address in addresses:
        if "@" in address:
            domain = address.rsplit("@", 1)[1].strip().strip(">")
            if domain:
                return domain
    return "openclaw.local"


def sanitize_filename_fragment(value: str) -> str:
    stripped = value.strip().strip("<>")
    return re.sub(r"[^A-Za-z0-9_.@-]+", "_", stripped)[:120] or "message"


def prepare_template(template_bytes: bytes, audit_bcc: list[str]) -> tuple[bytes, str]:
    headers_text, body = split_template(template_bytes)
    headers = parse_header_values(headers_text)
    message_ids = headers.get("message-id", [])
    message_id = message_ids[0] if message_ids else make_msgid(domain=infer_message_id_domain(headers))
    additions: list[str] = []

    if not message_ids:
        additions.append(f"Message-ID: {message_id}")
    for recipient in audit_bcc:
        clean_recipient = recipient.strip()
        if clean_recipient:
            additions.append(f"Bcc: {clean_recipient}")

    if additions:
        headers_text = "\n".join([headers_text, *additions]) if headers_text else "\n".join(additions)

    prepared_text = f"{headers_text}\n\n{body}"
    return prepared_text.encode("utf-8"), message_id


def write_proof_archive(
    proof_dir: Path,
    account: str,
    message_id: str,
    template_bytes: bytes,
) -> Path:
    proof_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{timestamp}-{sanitize_filename_fragment(account)}-{sanitize_filename_fragment(message_id)}.eml"
    archive_path = proof_dir / filename
    # Write before sending. If this fails, the wrapper should not perform a live
    # send because it would recreate the "Sent is the only proof" failure mode.
    archive_path.write_bytes(template_bytes)
    return archive_path


def output_excerpt(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    if len(text) <= MAX_CAPTURED_OUTPUT_CHARS:
        return text
    return text[-MAX_CAPTURED_OUTPUT_CHARS:]


def write_result_proof(params: dict[str, Any]) -> Path:
    archive_path = Path(params["archivePath"])
    result_path = archive_path.with_suffix(".result.json")
    result_path.write_text(json.dumps(params, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result_path


def main() -> int:
    args = parse_args()
    config_paths = determine_config_paths(args.config_paths)
    template_bytes = sys.stdin.buffer.read()
    if not template_bytes.strip():
        print("No template content received on stdin.", file=sys.stderr)
        return 2
    template_bytes, message_id = prepare_template(template_bytes, args.audit_bcc)

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

    archive_path: Path | None = None
    if not args.no_proof_archive:
        try:
            archive_path = write_proof_archive(
                Path(args.proof_dir).expanduser(),
                args.account,
                message_id,
                template_bytes,
            )
            print(
                f"Email proof archive written before send: {archive_path}",
                file=sys.stderr,
            )
        except OSError as exc:
            print(
                f"Refusing to send because local email proof archive failed: {exc}",
                file=sys.stderr,
            )
            return 2

    try:
        result = run_send(args.himalaya_bin, effective_config_paths, args.account, template_bytes)
    finally:
        if overlay_path is not None:
            overlay_path.unlink(missing_ok=True)

    combined_output = (result.stderr + result.stdout).decode("utf-8", errors="replace")
    write_stream(sys.stdout, result.stdout)
    write_stream(sys.stderr, result.stderr)
    append_failure = should_retry(args.account, config_paths, combined_output)

    if archive_path is not None:
        try:
            result_path = write_result_proof(
                {
                    "account": args.account,
                    "appendFailureClassified": append_failure,
                    "archivePath": str(archive_path),
                    "auditBccAdded": [recipient for recipient in args.audit_bcc if recipient.strip()],
                    "command": build_command(args.himalaya_bin, effective_config_paths, args.account),
                    "createdAt": datetime.now(UTC).isoformat(),
                    "format": 1,
                    "himalayaBin": args.himalaya_bin,
                    "icloudAccount": config_is_icloud,
                    "messageId": message_id,
                    "returnCode": result.returncode,
                    "saveCopyDisabled": send_without_save_copy,
                    "stderrTail": output_excerpt(result.stderr),
                    "stdoutTail": output_excerpt(result.stdout),
                }
            )
            print(
                f"Email command proof written: {result_path} Message-ID: {message_id}",
                file=sys.stderr,
            )
        except OSError as exc:
            print(
                f"WARNING: email result proof write failed after send attempt: {exc}",
                file=sys.stderr,
            )

    if result.returncode == 0 and send_without_save_copy:
        print(
            "Message sent. Himalaya skipped the Sent-folder copy for this "
            "larger iCloud attachment payload.",
            file=sys.stderr,
        )
        return 0

    if result.returncode != 0 and append_failure:
        print(
            "Himalaya likely reached SMTP delivery before the iCloud Sent-copy "
            "append failed. Not retrying automatically because that can "
            "duplicate delivery.",
            file=sys.stderr,
        )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
