#!/usr/bin/env python3
"""Unit coverage for the Himalaya iCloud send wrapper safety classifier."""

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
        # iCloud. Keep the fixture minimal so tests cover config parsing without
        # needing live credentials or network access.
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


if __name__ == "__main__":
    unittest.main()
