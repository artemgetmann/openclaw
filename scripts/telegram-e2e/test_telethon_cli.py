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


class FakeReadClient:
  def __init__(self, messages: list[SimpleNamespace]) -> None:
    self.disconnected = False
    self.get_messages_calls: list[dict[str, object]] = []
    self.messages = messages

  async def disconnect(self) -> None:
    self.disconnected = True

  async def get_messages(self, chat, *, limit: int):
    self.get_messages_calls.append({"chat": chat, "limit": limit})
    return self.messages[:limit]


class FakeDownloadClient:
  def __init__(self, message: SimpleNamespace | None) -> None:
    self.disconnected = False
    self.download_media_calls: list[dict[str, object]] = []
    self.get_messages_calls: list[dict[str, object]] = []
    self.message = message

  async def disconnect(self) -> None:
    self.disconnected = True

  async def get_messages(self, chat, *, ids: int):
    self.get_messages_calls.append({"chat": chat, "ids": ids})
    return self.message

  async def download_media(self, message, *, file: str):
    self.download_media_calls.append({"file": file, "message": message})
    Path(file).parent.mkdir(parents = True, exist_ok = True)
    Path(file).write_bytes(b"voice")
    return file


class FakeSentMessage:
  def __init__(
    self,
    *,
    chat_id: int,
    message_id: int,
    media_kind: str | None = None,
    text: str = "",
  ) -> None:
    self.chat_id = chat_id
    self.date = None
    self.direct_messages_topic = None
    self.id = message_id
    self.message = text
    self.out = True
    self.reply_to = None
    self.sender_id = 99
    self.audio = SimpleNamespace() if media_kind == "audio" else None
    self.document = SimpleNamespace() if media_kind == "document" else None
    self.photo = SimpleNamespace() if media_kind == "photo" else None
    self.video = SimpleNamespace() if media_kind == "video" else None
    self.voice = SimpleNamespace() if media_kind == "voice" else None

  async def get_chat(self):
    return SimpleNamespace(id = self.chat_id, title = "Jarvis Lab", username = None)


def build_fake_media_message(*, media_kind: str = "voice", message_id: int = 52830) -> SimpleNamespace:
  return SimpleNamespace(
    audio = SimpleNamespace() if media_kind == "audio" else None,
    chat = SimpleNamespace(id = 10, title = None, username = "jarvis_tester_1_bot"),
    chat_id = 10,
    date = None,
    direct_messages_topic = None,
    document = SimpleNamespace() if media_kind in {"audio", "document", "voice"} else None,
    file = SimpleNamespace(ext = ".oga" if media_kind == "voice" else ".bin", mime_type = "audio/ogg"),
    id = message_id,
    media = SimpleNamespace(),
    message = "",
    out = False,
    photo = SimpleNamespace() if media_kind == "photo" else None,
    reply_to = None,
    sender_id = 101,
    video = SimpleNamespace() if media_kind == "video" else None,
    voice = SimpleNamespace() if media_kind == "voice" else None,
  )


class FakeSendClient:
  def __init__(self) -> None:
    self.disconnected = False
    self.send_file_calls: list[dict[str, object]] = []
    self.send_message_calls: list[dict[str, object]] = []

  async def disconnect(self) -> None:
    self.disconnected = True

  async def send_file(self, **kwargs):
    self.send_file_calls.append(kwargs)
    return FakeSentMessage(
      chat_id = -1003783709877,
      media_kind = "voice" if kwargs.get("voice_note") else "document",
      message_id = 501,
      text = str(kwargs.get("caption") or ""),
    )

  async def send_message(self, **kwargs):
    self.send_message_calls.append(kwargs)
    return FakeSentMessage(
      chat_id = -1003783709877,
      message_id = 502,
      text = str(kwargs.get("message") or ""),
    )


class FakeTopicClient:
  def __init__(self) -> None:
    self.disconnected = False
    self.requests: list[object] = []

  async def __call__(self, request):
    self.requests.append(request)
    action = type("MessageActionTopicCreate", (), {})()
    message = SimpleNamespace(
      action = action,
      chat_id = -1003783709877,
      date = None,
      direct_messages_topic = None,
      id = 777,
      message = "",
      out = True,
      reply_to = None,
      sender_id = 99,
    )
    return SimpleNamespace(updates = [SimpleNamespace(message = message)])

  async def disconnect(self) -> None:
    self.disconnected = True


class FakeCreateForumTopicRequest:
  def __init__(self, *, peer, title: str) -> None:
    self.peer = peer
    self.title = title


class FakeTelethonFunctions:
  messages = SimpleNamespace(CreateForumTopicRequest = FakeCreateForumTopicRequest)


def build_fake_dialog(
  *,
  chat_id: int,
  is_user: bool,
  message_text: str | None = None,
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
  message = None
  if message_text is not None:
    message = SimpleNamespace(
      chat_id = chat_id,
      chat = entity,
      date = None,
      direct_messages_topic = None,
      id = chat_id * 10,
      message = message_text,
      out = False,
      reply_to = None,
      sender_id = chat_id,
    )
  return SimpleNamespace(
    archived = False,
    dialog = SimpleNamespace(notify_settings = SimpleNamespace(mute_until = None)),
    entity = entity,
    folder_id = None,
    is_channel = False,
    is_group = not is_user,
    is_user = is_user,
    message = message,
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
            contains = "",
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

  async def test_run_inbox_filters_by_contains_before_emitting_json(self) -> None:
    fake_client = FakeInboxClient([
      build_fake_dialog(
        chat_id = 101,
        is_user = True,
        message_text = "noise only",
        username = "wrong_chat",
      ),
      build_fake_dialog(
        chat_id = 202,
        is_user = True,
        message_text = "Launch proof landed",
        username = "jarvis_tester_1_bot",
      ),
    ])
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
            contains = "proof",
            dm_only = False,
            limit = 1,
            session = str(session_path),
            unread = False,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(fake_client.iter_dialogs_calls, [{"ignore_pinned": False, "limit": 1000}])
    self.assertEqual(len(emitted["dialogs"]), 1)
    self.assertEqual(emitted["dialogs"][0]["chat_username"], "jarvis_tester_1_bot")

  async def test_run_read_filters_by_contains_and_scans_deeper_than_result_limit(self) -> None:
    fake_client = FakeReadClient([
      SimpleNamespace(
        chat = SimpleNamespace(id = 10, title = None, username = "jarvis_tester_1_bot"),
        chat_id = 10,
        date = None,
        direct_messages_topic = None,
        id = 1,
        message = "noise",
        out = False,
        reply_to = None,
        sender_id = 101,
      ),
      SimpleNamespace(
        chat = SimpleNamespace(id = 10, title = None, username = "jarvis_tester_1_bot"),
        chat_id = 10,
        date = None,
        direct_messages_topic = None,
        id = 2,
        message = "proof matched",
        out = False,
        reply_to = None,
        sender_id = 102,
      ),
    ])
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
        exit_code = await telethon_cli.run_read(
          argparse.Namespace(
            after_id = 0,
            before_id = 0,
            chat = "@jarvis_tester_1_bot",
            contains = "proof",
            limit = 1,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(fake_client.get_messages_calls, [{"chat": "@jarvis_tester_1_bot", "limit": 200}])
    self.assertEqual(len(emitted["messages"]), 1)
    self.assertEqual(emitted["messages"][0]["text"], "proof matched")

  async def test_run_download_saves_message_media_to_deterministic_output_path(self) -> None:
    message = build_fake_media_message(media_kind = "voice", message_id = 52830)
    fake_client = FakeDownloadClient(message)
    emitted: dict[str, object] = {}

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      output_dir = Path(temp_dir) / "downloads"

      with (
        patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_download(
          argparse.Namespace(
            chat = "@jarvis_tester_1_bot",
            message_id = 52830,
            output = str(output_dir),
            session = str(session_path),
          )
        )

    expected_path = output_dir / "telegram-jarvis_tester_1_bot-52830.oga"
    self.assertEqual(exit_code, 0)
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(fake_client.get_messages_calls, [{"chat": "@jarvis_tester_1_bot", "ids": 52830}])
    self.assertEqual(fake_client.download_media_calls[0]["file"], str(expected_path))
    self.assertEqual(emitted["path"], str(expected_path))
    self.assertEqual(emitted["media_kind"], "voice")
    self.assertEqual(emitted["size_bytes"], 5)

  async def test_run_download_rejects_messages_without_media(self) -> None:
    message = build_fake_media_message(media_kind = "voice", message_id = 52831)
    message.media = None
    fake_client = FakeDownloadClient(message)

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()

      with patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())):
        exit_code = await telethon_cli.run_download(
          argparse.Namespace(
            chat = "@jarvis_tester_1_bot",
            message_id = 52831,
            output = str(Path(temp_dir) / "downloads"),
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertTrue(fake_client.disconnected)

  async def test_run_send_uploads_media_as_voice_with_caption_and_reply_target(self) -> None:
    fake_client = FakeSendClient()
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
        exit_code = await telethon_cli.run_send(
          argparse.Namespace(
            caption = "voice proof",
            chat = "-1003783709877",
            media = "/tmp/proof.ogg",
            message = None,
            reply_to = 15248,
            session = str(session_path),
            voice = True,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(fake_client.send_message_calls, [])
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(fake_client.send_file_calls[0]["caption"], "voice proof")
    self.assertEqual(fake_client.send_file_calls[0]["file"], "/tmp/proof.ogg")
    self.assertEqual(fake_client.send_file_calls[0]["reply_to"], 15248)
    self.assertTrue(fake_client.send_file_calls[0]["voice_note"])
    self.assertEqual(emitted["message"]["media_kind"], "voice")
    self.assertEqual(emitted["message"]["message_id"], 501)

  async def test_run_send_preserves_text_send_when_media_is_absent(self) -> None:
    fake_client = FakeSendClient()
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
        exit_code = await telethon_cli.run_send(
          argparse.Namespace(
            caption = None,
            chat = "-1003783709877",
            media = None,
            message = "text proof",
            reply_to = 0,
            session = str(session_path),
            voice = False,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(fake_client.send_file_calls, [])
    self.assertEqual(fake_client.send_message_calls[0]["message"], "text proof")
    self.assertIsNone(fake_client.send_message_calls[0]["reply_to"])
    self.assertEqual(emitted["message"]["media_kind"], None)

  async def test_run_topic_create_returns_stable_topic_anchor_payload(self) -> None:
    fake_client = FakeTopicClient()
    emitted: dict[str, object] = {}

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()

      with (
        patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())),
        patch.object(telethon_cli, "functions", FakeTelethonFunctions),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_topic_create(
          argparse.Namespace(
            chat = "-1003783709877",
            session = str(session_path),
            title = "voice proof",
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(emitted["chat_id"], -1003783709877)
    self.assertEqual(emitted["message_id"], 777)
    self.assertEqual(emitted["topic_anchor"], 777)
    self.assertEqual(emitted["topic_title"], "voice proof")


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

  def test_build_parser_accepts_topic_create_and_media_send_flags(self) -> None:
    parser = telethon_cli.build_parser()

    topic_args = parser.parse_args([
      "topic-create",
      "--chat",
      "-1003783709877",
      "--title",
      "voice proof",
    ])
    self.assertEqual(topic_args.command, "topic-create")
    self.assertEqual(topic_args.title, "voice proof")

    send_args = parser.parse_args([
      "send",
      "--chat",
      "-1003783709877",
      "--media",
      "/tmp/proof.ogg",
      "--caption",
      "voice proof",
      "--voice",
    ])
    self.assertEqual(send_args.command, "send")
    self.assertEqual(send_args.media, "/tmp/proof.ogg")
    self.assertEqual(send_args.caption, "voice proof")
    self.assertTrue(send_args.voice)

    download_args = parser.parse_args([
      "download",
      "--chat",
      "@jarvis_tester_1_bot",
      "--message-id",
      "52830",
      "--output",
      "/tmp/downloads",
    ])
    self.assertEqual(download_args.command, "download")
    self.assertEqual(download_args.message_id, 52830)
    self.assertEqual(download_args.output, "/tmp/downloads")

  def test_compute_inbox_scan_cap_keeps_filtered_queries_bounded_but_deeper(self) -> None:
    self.assertEqual(
      telethon_cli.compute_inbox_scan_cap(limit = 20, dm_only = False, unread_only = False),
      20,
    )
    self.assertEqual(
      telethon_cli.compute_inbox_scan_cap(
        contains = "proof",
        limit = 1,
        dm_only = False,
        unread_only = False,
      ),
      1_000,
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
