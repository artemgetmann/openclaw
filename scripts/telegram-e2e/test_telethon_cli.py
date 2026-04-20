from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
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


class FakeInboxClient:
  def __init__(self, dialogs: list[SimpleNamespace]) -> None:
    self.dialogs = dialogs
    self.disconnected = False
    self.iter_dialogs_calls: list[dict[str, object]] = []

  async def disconnect(self) -> None:
    self.disconnected = True

  async def iter_dialogs(self, *, limit: int | None = None, ignore_pinned: bool = False):
    self.iter_dialogs_calls.append({
      "ignore_pinned": ignore_pinned,
      "limit": limit,
    })
    emitted = 0
    for dialog in self.dialogs:
      if limit is not None and emitted >= limit:
        break
      emitted += 1
      yield dialog


def build_fake_dialog(
  *,
  chat_id: int,
  is_user: bool,
  unread_count: int = 0,
  unread_mentions_count: int = 0,
  unread_reactions_count: int = 0,
  title: str | None = None,
  username: str | None = None,
) -> SimpleNamespace:
  label = title or username or f"chat-{chat_id}"
  entity = SimpleNamespace(
    bot = False,
    id = chat_id,
    title = title,
    username = username,
  )
  return SimpleNamespace(
    archived = False,
    dialog = SimpleNamespace(notify_settings = SimpleNamespace(mute_until = None)),
    entity = entity,
    folder_id = None,
    is_channel = False,
    is_group = not is_user,
    is_user = is_user,
    message = None,
    name = label,
    pinned = False,
    unread_count = unread_count,
    unread_mentions_count = unread_mentions_count,
    unread_reactions_count = unread_reactions_count,
  )


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

  async def test_run_inbox_scans_past_initial_noise_for_unread_dm_filters(self) -> None:
    noisy_dialogs = [
      build_fake_dialog(chat_id = index, is_user = False, title = f"group-{index}")
      for index in range(1, 452)
    ]
    matching_dialog = build_fake_dialog(
      chat_id = 9_999,
      is_user = True,
      unread_count = 2,
      username = "jarvis_tester_1_bot",
    )
    fake_client = FakeInboxClient(noisy_dialogs + [matching_dialog])
    emitted: dict[str, object] = {}

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()

      with (
        patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_inbox(
          argparse.Namespace(
            dm_only = True,
            limit = 1,
            session = str(session_path),
            unread = True,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(fake_client.iter_dialogs_calls, [{"ignore_pinned": False, "limit": 1000}])
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(len(emitted["dialogs"]), 1)
    self.assertEqual(emitted["dialogs"][0]["chat_username"], "jarvis_tester_1_bot")


class TelethonCliSyncTests(unittest.TestCase):
  def test_build_dialog_payload_accepts_datetime_mute_until(self) -> None:
    future_mute_until = datetime.now(timezone.utc) + timedelta(hours = 1)
    dialog = build_fake_dialog(chat_id = 101, is_user = True, unread_count = 1)
    dialog.dialog.notify_settings.mute_until = future_mute_until

    payload = telethon_cli.build_dialog_payload(dialog)

    self.assertTrue(payload["muted"])
    self.assertEqual(payload["chat_id"], 101)
    self.assertEqual(payload["unread_count"], 1)

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

  def test_compute_inbox_scan_cap_keeps_filtered_queries_bounded_but_deeper(self) -> None:
    self.assertEqual(
      telethon_cli.compute_inbox_scan_cap(limit = 20, dm_only = False, unread_only = False),
      20,
    )
    self.assertEqual(
      telethon_cli.compute_inbox_scan_cap(limit = 1, dm_only = True, unread_only = True),
      1_000,
    )
    self.assertEqual(
      telethon_cli.compute_inbox_scan_cap(limit = 200, dm_only = True, unread_only = True),
      5_000,
    )


if __name__ == "__main__":
  raise SystemExit(unittest.main())
