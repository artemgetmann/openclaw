from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
  sys.path.insert(0, str(SCRIPT_DIR))

import telethon_cli


class FakeAuthorizedClient:
  def __init__(self) -> None:
    self.disconnected = False

  async def connect(self) -> None:
    return None

  async def disconnect(self) -> None:
    self.disconnected = True

  async def get_me(self):
    return SimpleNamespace(first_name = "Tester", id = 99, username = "artem")

  async def is_user_authorized(self) -> bool:
    return True


class FakePasswordLoginClient:
  def __init__(self) -> None:
    self.authorized = False
    self.sign_in_calls: list[dict[str, object]] = []

  async def connect(self) -> None:
    return None

  async def disconnect(self) -> None:
    return None

  async def get_me(self):
    return SimpleNamespace(first_name = "Tester", id = 99, username = "artem")

  async def is_user_authorized(self) -> bool:
    return self.authorized

  async def sign_in(self, **kwargs):
    self.sign_in_calls.append(kwargs)
    self.authorized = True
    return None


class FakeExpiredCodeClient:
  def __init__(self) -> None:
    self.send_code_request_calls: list[str] = []

  async def connect(self) -> None:
    return None

  async def disconnect(self) -> None:
    return None

  async def is_user_authorized(self) -> bool:
    return False

  async def send_code_request(self, phone: str):
    self.send_code_request_calls.append(phone)
    return SimpleNamespace(phone_code_hash = "fresh-hash")

  async def sign_in(self, **kwargs):
    error_cls = type("PhoneCodeExpiredError", (Exception,), {})
    raise error_cls("expired")


class TelethonCliTests(unittest.IsolatedAsyncioTestCase):
  async def test_run_status_prefers_authorized_session_over_stale_pending_state(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      telethon_cli.write_pending_auth_state(
        session_path,
        phone = "+15551234567",
        phone_code_hash = "stale-hash",
        state = "awaiting_code",
      )
      fake_client = FakeAuthorizedClient()
      emitted: dict[str, object] = {}

      with (
        patch.object(telethon_cli, "create_telegram_client", return_value = fake_client),
        patch.object(telethon_cli, "resolve_api_credentials", return_value = (123, "hash")),
        patch.object(
          telethon_cli,
          "emit_auth_status",
          side_effect = lambda **payload: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_status(
          argparse.Namespace(chat = None, session = str(session_path))
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(emitted["state"], "ready")
      self.assertIsNone(emitted["pending_auth"])
      self.assertFalse(telethon_cli.resolve_pending_auth_path(session_path).exists())
      self.assertTrue(fake_client.disconnected)

  async def test_run_login_reads_password_from_env_instead_of_args(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      telethon_cli.write_pending_auth_state(
        session_path,
        phone = "+15551234567",
        phone_code_hash = "hash-1",
        state = "awaiting_password",
      )
      fake_client = FakePasswordLoginClient()
      emitted: dict[str, object] = {}

      with (
        patch.dict(os.environ, {telethon_cli.LOGIN_PASSWORD_ENV: "super-secret"}, clear = False),
        patch.object(telethon_cli, "create_telegram_client", return_value = fake_client),
        patch.object(telethon_cli, "resolve_api_credentials", return_value = (123, "hash")),
        patch.object(
          telethon_cli,
          "emit_auth_status",
          side_effect = lambda **payload: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_login(
          argparse.Namespace(code = None, phone = "+15551234567", session = str(session_path))
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(fake_client.sign_in_calls, [{"password": "super-secret"}])
      self.assertEqual(emitted["state"], "ready")
      self.assertFalse(telethon_cli.resolve_pending_auth_path(session_path).exists())

  async def test_run_login_refreshes_pending_state_after_expired_code(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      telethon_cli.write_pending_auth_state(
        session_path,
        phone = "+15551234567",
        phone_code_hash = "old-hash",
        state = "awaiting_code",
      )
      fake_client = FakeExpiredCodeClient()
      emitted: dict[str, object] = {}

      with (
        patch.object(telethon_cli, "create_telegram_client", return_value = fake_client),
        patch.object(telethon_cli, "resolve_api_credentials", return_value = (123, "hash")),
        patch.object(
          telethon_cli,
          "emit_auth_status",
          side_effect = lambda **payload: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_login(
          argparse.Namespace(
            code = "12345",
            phone = "+15551234567",
            session = str(session_path),
          )
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(fake_client.send_code_request_calls, ["+15551234567"])
      self.assertEqual(emitted["state"], "awaiting_code")
      refreshed = telethon_cli.read_pending_auth_state(session_path)
      self.assertIsNotNone(refreshed)
      assert refreshed is not None
      self.assertEqual(refreshed["phone_code_hash"], "fresh-hash")


class TelethonCliSyncTests(unittest.TestCase):
  def test_clear_session_artifacts_refuses_directory_session_path(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "session-dir"
      session_path.mkdir()

      with self.assertRaisesRegex(ValueError, "session path is a directory"):
        telethon_cli.clear_session_artifacts(session_path)

  def test_clear_session_artifacts_refuses_directory_sidecars(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      Path(f"{session_path}-wal").mkdir()

      with self.assertRaisesRegex(ValueError, "unexpected directory artifact"):
        telethon_cli.clear_session_artifacts(session_path)

  def test_build_parser_rejects_password_flag(self) -> None:
    parser = telethon_cli.build_parser()
    with self.assertRaises(SystemExit):
      parser.parse_args(["login", "--phone", "+15551234567", "--password", "secret"])


if __name__ == "__main__":
  raise SystemExit(unittest.main())
