#!/usr/bin/env python3
"""Offline coverage for the Himalaya send wrapper safety and proof behavior."""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import send_template


class SendTemplateTests(unittest.TestCase):
    def write_config(self, body: str) -> Path:
        # The wrapper reads real TOML config to decide whether an account is
        # iCloud. Keep fixtures minimal so tests cover config parsing without
        # live credentials, live mailbox state, or network access.
        handle = tempfile.NamedTemporaryFile(
            mode="w",
            prefix="openclaw-himalaya-test-",
            suffix=".toml",
            delete=False,
        )
        with handle:
            handle.write(body)
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return Path(handle.name)

    def test_classifies_icloud_sent_copy_timeout_as_post_send_failure(self) -> None:
        config = self.write_config(
            """
[accounts.icloud]
email = "founder@icloud.com"
backend.host = "imap.mail.me.com"
"""
        )

        self.assertTrue(
            send_template.should_retry(
                "icloud",
                [config],
                "cannot add IMAP message: request timed out",
            )
        )

    def test_classifies_icloud_sent_copy_quota_as_post_send_failure(self) -> None:
        config = self.write_config(
            """
[accounts.icloud]
email = "founder@icloud.com"
backend.host = "imap.mail.me.com"
"""
        )

        self.assertTrue(
            send_template.should_retry(
                "icloud",
                [config],
                "cannot add IMAP message: Quota Exceeded",
            )
        )

    def test_classifies_icloud_chained_quota_append_error_as_post_send_failure(self) -> None:
        config = self.write_config(
            """
[accounts.icloud]
email = "founder@icloud.com"
backend.host = "imap.mail.me.com"
"""
        )

        self.assertTrue(
            send_template.should_retry(
                "icloud",
                [config],
                """
Error:
   0: cannot add IMAP message
   1: cannot resolve IMAP task
   2: unexpected NO response: Quota Exceeded
""",
            )
        )

    def test_does_not_reclassify_non_icloud_quota_errors(self) -> None:
        config = self.write_config(
            """
[accounts.work]
email = "founder@example.com"
backend.host = "imap.example.com"
"""
        )

        self.assertFalse(
            send_template.should_retry(
                "work",
                [config],
                "cannot add IMAP message: Quota Exceeded",
            )
        )

    def test_prepare_template_preserves_existing_message_id(self) -> None:
        template, message_id = send_template.prepare_template(
            b"From: founder@example.com\nMessage-ID: <existing@example.com>\n\nhello",
            [],
        )

        self.assertEqual(message_id, "<existing@example.com>")
        self.assertEqual(template.count(b"Message-ID:"), 1)

    def test_prepare_template_adds_message_id_and_explicit_audit_bcc(self) -> None:
        template, message_id = send_template.prepare_template(
            b"From: founder@example.com\nTo: user@example.net\nSubject: Test\n\nhello",
            ["audit@example.com"],
        )

        self.assertIn(b"\nMessage-ID: <", template)
        self.assertIn(b"\nBcc: audit@example.com", template)
        self.assertTrue(message_id.startswith("<"))
        self.assertTrue(message_id.endswith("@example.com>"))

    def test_write_proof_archive_uses_message_id_and_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openclaw-himalaya-proof-test-") as temp_dir:
            archive_path = send_template.write_proof_archive(
                Path(temp_dir),
                "icloud",
                "<proof@example.com>",
                b"From: founder@example.com\n\nbody",
            )

            self.assertTrue(archive_path.name.endswith("-proof@example.com.eml"))
            self.assertEqual(archive_path.read_bytes(), b"From: founder@example.com\n\nbody")

    def test_build_mark_read_command_scopes_account_folder_and_exact_ids(self) -> None:
        command = send_template.build_mark_read_command(
            "himalaya",
            [Path("base.toml"), Path("private.toml")],
            "personal",
            "INBOX",
            ["42", "43"],
        )

        self.assertEqual(
            command,
            [
                "himalaya",
                "-c",
                "base.toml",
                "-c",
                "private.toml",
                "flag",
                "add",
                "-a",
                "personal",
                "-f",
                "INBOX",
                "42",
                "43",
                "seen",
            ],
        )

    def test_mark_read_runs_after_clean_send_with_expected_args(self) -> None:
        completed = send_template.subprocess.CompletedProcess
        events: list[str] = []

        def fake_run(command: list[str], **_kwargs: object) -> object:
            events.append("flag")
            self.assertIn("flag", command)
            self.assertEqual(command[-3:], ["42", "43", "seen"])
            return completed(command, 0, b"", b"")

        with patch.object(send_template.subprocess, "run", side_effect=fake_run):
            events.append("send")
            result = send_template.mark_source_envelopes_read(
                "himalaya", [], "personal", "INBOX", ["42", "43"]
            )

        self.assertEqual(events, ["send", "flag"])
        self.assertEqual(result.returncode, 0)

    def test_mark_read_failure_is_reported_without_send_retry(self) -> None:
        completed = send_template.subprocess.CompletedProcess
        calls: list[list[str]] = []

        def fake_run(command: list[str], **_kwargs: object) -> object:
            calls.append(command)
            return completed(command, 75, b"", b"IMAP update failed")

        with patch.object(send_template.subprocess, "run", side_effect=fake_run):
            result = send_template.mark_source_envelopes_read(
                "himalaya", [], "personal", "INBOX", ["42"]
            )

        self.assertEqual(result.returncode, 75)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2:4], ["add", "-a"])

    def test_main_marks_sources_only_after_a_successful_send(self) -> None:
        completed = send_template.subprocess.CompletedProcess
        events: list[str] = []
        args = SimpleNamespace(
            account="personal",
            audit_bcc=[],
            config_paths=[],
            himalaya_bin="himalaya",
            no_proof_archive=True,
            proof_dir="unused",
            source_envelope_id=["42", "43"],
            source_folder="INBOX",
        )

        def fake_send(*_args: object) -> object:
            events.append("send")
            return completed([], 0, b"sent", b"")

        def fake_mark(*_args: object) -> object:
            events.append("mark")
            return completed([], 0, b"", b"")

        with (
            patch.object(send_template, "parse_args", return_value=args),
            patch.object(send_template, "run_send", side_effect=fake_send),
            patch.object(send_template, "mark_source_envelopes_read", side_effect=fake_mark),
            patch.object(send_template, "write_stream"),
            patch.object(send_template.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"To: x@example.com\n\nhi"))),
        ):
            self.assertEqual(send_template.main(), 0)

        self.assertEqual(events, ["send", "mark"])

    def test_main_does_not_mark_sources_after_ambiguous_send_failure(self) -> None:
        completed = send_template.subprocess.CompletedProcess
        args = SimpleNamespace(
            account="icloud",
            audit_bcc=[],
            config_paths=[],
            himalaya_bin="himalaya",
            no_proof_archive=True,
            proof_dir="unused",
            source_envelope_id=["42"],
            source_folder="INBOX",
        )

        with (
            patch.object(send_template, "parse_args", return_value=args),
            patch.object(
                send_template,
                "run_send",
                return_value=completed([], 1, b"", b"cannot add IMAP message: request timed out"),
            ),
            patch.object(send_template, "mark_source_envelopes_read") as mark_read,
            patch.object(send_template, "write_stream"),
            patch.object(send_template.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"To: x@example.com\n\nhi"))),
        ):
            self.assertEqual(send_template.main(), 1)

        mark_read.assert_not_called()

    def test_main_reports_failed_read_postcondition_without_resending(self) -> None:
        completed = send_template.subprocess.CompletedProcess
        events: list[str] = []
        args = SimpleNamespace(
            account="personal",
            audit_bcc=[],
            config_paths=[],
            himalaya_bin="himalaya",
            no_proof_archive=True,
            proof_dir="unused",
            source_envelope_id=["42"],
            source_folder="INBOX",
        )

        def fake_send(*_args: object) -> object:
            events.append("send")
            return completed([], 0, b"sent", b"")

        def fake_mark(*_args: object) -> object:
            events.append("mark")
            return completed([], 75, b"", b"IMAP update failed")

        with (
            patch.object(send_template, "parse_args", return_value=args),
            patch.object(send_template, "run_send", side_effect=fake_send),
            patch.object(send_template, "mark_source_envelopes_read", side_effect=fake_mark),
            patch.object(send_template, "write_stream"),
            patch.object(send_template.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"To: x@example.com\n\nhi"))),
        ):
            self.assertEqual(send_template.main(), 75)

        self.assertEqual(events, ["send", "mark"])


if __name__ == "__main__":
    unittest.main()
