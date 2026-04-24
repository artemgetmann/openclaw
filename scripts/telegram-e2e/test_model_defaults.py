from __future__ import annotations

import json
import pathlib
import tempfile
import unittest

from model_defaults import DEFAULT_FALLBACK_MODEL, resolve_default_model


class ResolveDefaultModelTests(unittest.TestCase):
    def test_prefers_object_primary_from_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = pathlib.Path(tmpdir) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agents": {
                            "defaults": {
                                "model": {
                                    "primary": "openai-codex/gpt-5.4",
                                },
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(resolve_default_model(config_path=config_path), "openai-codex/gpt-5.4")

    def test_prefers_string_model_from_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = pathlib.Path(tmpdir) / "openclaw.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agents": {
                            "defaults": {
                                "model": "anthropic/claude-sonnet-4-6",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(resolve_default_model(config_path=config_path), "anthropic/claude-sonnet-4-6")

    def test_falls_back_when_config_is_missing_or_invalid(self) -> None:
        self.assertEqual(
            resolve_default_model(config_path="/tmp/does-not-exist.json"),
            DEFAULT_FALLBACK_MODEL,
        )


if __name__ == "__main__":
    unittest.main()
