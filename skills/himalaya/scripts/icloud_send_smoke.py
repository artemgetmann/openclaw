#!/usr/bin/env python3
"""Run a narrow Himalaya iCloud send smoke test.

This harness is intentionally small. It validates the exact surface that broke:
template sends with attachments on iCloud. The large attachment case is
optional, because many environments will not have a representative file handy.
When provided, the wrapper is expected to deliver the message and explicitly
report that Sent-copy append was skipped on retry.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover - Python 3.11+ on macOS
    raise SystemExit("Python 3.11+ is required for tomllib support") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run no-attachment, small-attachment, and optional large-attachment Himalaya smoke sends."
    )
    parser.add_argument("--account", required=True, help="Himalaya account name to use.")
    parser.add_argument(
        "--to",
        required=True,
        help="Recipient address used for the smoke sends. Sending to self is recommended.",
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
        "--large-attachment",
        help="Optional path to a representative larger attachment that used to trigger the timeout.",
    )
    parser.add_argument(
        "--wrapper",
        default=str(Path(__file__).with_name("send_template.py")),
        help="Path to the Himalaya wrapper script.",
    )
    return parser.parse_args()


def determine_config_paths(explicit_paths: list[str] | None) -> list[Path]:
    if explicit_paths:
        return [Path(path).expanduser() for path in explicit_paths]
    env_path = Path(
        (Path.home() / ".config" / "himalaya" / "config.toml")
        if "HIMALAYA_CONFIG" not in os.environ
        else os.environ["HIMALAYA_CONFIG"]
    )
    return [env_path.expanduser()]


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def resolve_account_email(account: str, config_paths: list[Path]) -> str:
    merged: dict[str, Any] = {}
    for path in config_paths:
        if not path.exists():
            continue
        with path.open("rb") as handle:
            merged = deep_merge(merged, tomllib.load(handle))
    email_addr = merged.get("accounts", {}).get(account, {}).get("email")
    if not email_addr:
        raise SystemExit(f"Could not resolve email for account `{account}` from Himalaya config.")
    return str(email_addr)


def create_tiny_pdf(path: Path) -> None:
    # Keep the fixture embedded so the smoke test has no external dependency.
    pdf_bytes = (
        b"%PDF-1.4\n"
        b"1 0 obj<<>>endobj\n"
        b"2 0 obj<<>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n"
        b"4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 120 Td (OpenClaw smoke) Tj ET\nendstream\nendobj\n"
        b"5 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n"
        b"6 0 obj<</Type/Catalog/Pages 5 0 R>>endobj\n"
        b"xref\n0 7\n0000000000 65535 f \n0000000009 00000 n \n0000000030 00000 n \n"
        b"0000000051 00000 n \n0000000127 00000 n \n0000000221 00000 n \n0000000278 00000 n \n"
        b"trailer<</Size 7/Root 6 0 R>>\nstartxref\n327\n%%EOF\n"
    )
    path.write_bytes(pdf_bytes)


def make_template(from_addr: str, subject: str, to_addr: str, attachment: Path | None) -> bytes:
    lines = [
        f"From: OpenClaw Himalaya Smoke <{from_addr}>",
        f"To: {to_addr}",
        f"Subject: {subject}",
        "",
    ]
    if attachment is None:
        lines.append("Smoke test without attachment.")
    else:
        lines.extend(
            [
                "<#multipart type=mixed>",
                "<#part type=text/plain>",
                f"Smoke test with attachment: {attachment.name}",
                "<#/part>",
                f"<#part filename={attachment}><#/part>",
                "<#/multipart>",
            ]
        )
    return "\n".join(lines).encode("utf-8")


def run_case(
    wrapper: str,
    account: str,
    from_addr: str,
    subject: str,
    to_addr: str,
    attachment: Path | None,
    config_paths: list[Path],
) -> int:
    command = [sys.executable, wrapper, "--account", account]
    for config_path in config_paths:
        command.extend(["--config", str(config_path)])
    result = subprocess.run(
        command,
        input=make_template(from_addr, subject, to_addr, attachment),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    return result.returncode


def main() -> int:
    args = parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    config_paths = determine_config_paths(args.config_paths)
    from_addr = resolve_account_email(args.account, config_paths)

    with tempfile.TemporaryDirectory(prefix="openclaw-himalaya-smoke-") as temp_dir:
        temp_path = Path(temp_dir)
        tiny_pdf = temp_path / "openclaw-smoke.pdf"
        create_tiny_pdf(tiny_pdf)

        cases = [
            ("no attachment", None),
            ("small attachment", tiny_pdf),
        ]

        if args.large_attachment:
            cases.append(("large attachment", Path(args.large_attachment).expanduser()))

        for label, attachment in cases:
            subject = f"OpenClaw Himalaya Smoke {label} {stamp}"
            print(f"[smoke] sending {label}: {subject}", file=sys.stderr)
            code = run_case(
                args.wrapper,
                args.account,
                from_addr,
                subject,
                args.to,
                attachment,
                config_paths,
            )
            if code != 0:
                print(f"[smoke] failed during {label}", file=sys.stderr)
                return code

    print("[smoke] all requested sends completed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
