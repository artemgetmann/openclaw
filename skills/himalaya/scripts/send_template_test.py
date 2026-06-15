#!/usr/bin/env python3
"""Offline coverage for the Himalaya send wrapper safety and proof behavior."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
