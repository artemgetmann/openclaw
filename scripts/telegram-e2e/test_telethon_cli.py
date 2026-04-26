from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
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
  unittest.main()
