from __future__ import annotations

import argparse
import asyncio
import io
from datetime import datetime, timedelta, timezone
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
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


class FakeOwnerProbeClient:
  def __init__(self, user_id: int | None) -> None:
    self.disconnected = False
    self.user_id = user_id

  async def connect(self) -> None:
    return None

  async def disconnect(self) -> None:
    self.disconnected = True

  async def get_me(self):
    return SimpleNamespace(id=self.user_id)

  async def is_user_authorized(self) -> bool:
    return self.user_id is not None


class FakeUnreadableOwnerProbeClient:
  async def connect(self) -> None:
    raise OSError("fixture path that must not leak")

  async def disconnect(self) -> None:
    return None


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


class FakeInvalidCodeClient(FakeExpiredCodeClient):
  async def sign_in(self, **kwargs):
    error_cls = type("PhoneCodeInvalidError", (Exception,), {})
    raise error_cls("invalid")


class FakeFloodedCodeRequestClient:
  async def connect(self) -> None:
    return None

  async def disconnect(self) -> None:
    return None

  async def is_user_authorized(self) -> bool:
    return False

  async def send_code_request(self, _phone: str):
    error_cls = type("FloodWaitError", (Exception,), {})
    error = error_cls("wait")
    error.seconds = 37
    raise error


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

  async def get_messages(self, chat, **kwargs):
    limit = int(kwargs.get("limit") or 0)
    self.get_messages_calls.append({"chat": chat, **kwargs})
    return self.messages[:limit]


class FakeTopicReadClient:
  def __init__(
    self,
    *,
    reply_pages: list[list[SimpleNamespace]] | None = None,
    replies: list[SimpleNamespace],
    root: SimpleNamespace | None,
    topic_pages: list[SimpleNamespace] | None = None,
    topics: list[SimpleNamespace],
  ) -> None:
    self.disconnected = False
    self.get_messages_calls: list[dict[str, object]] = []
    self.reply_page_index = 0
    # Default to a complete first page followed by authoritative exhaustion.
    # Tests that exercise Telegram's short-page behavior provide explicit pages.
    self.reply_pages = reply_pages if reply_pages is not None else [replies, []]
    self.requests: list[object] = []
    self.root = root
    self.topic_page_index = 0
    self.topic_pages = topic_pages or []
    self.topics = topics

  async def __call__(self, request):
    self.requests.append(request)
    if isinstance(request, FakeGetForumTopicsByIDRequest):
      return SimpleNamespace(topics = self.topics)
    if isinstance(request, FakeGetRepliesRequest):
      if self.reply_page_index >= len(self.reply_pages):
        raise AssertionError("unexpected extra topic replies page request")
      messages = self.reply_pages[self.reply_page_index]
      self.reply_page_index += 1
      return SimpleNamespace(messages = messages)
    if isinstance(request, FakeGetForumTopicsRequest):
      if not self.topic_pages:
        return SimpleNamespace(count = len(self.topics), messages = [], topics = self.topics)
      if self.topic_page_index >= len(self.topic_pages):
        raise AssertionError("unexpected extra forum-topic page request")
      result = self.topic_pages[self.topic_page_index]
      self.topic_page_index += 1
      return result
    raise AssertionError(f"unexpected request {type(request).__name__}")

  async def disconnect(self) -> None:
    self.disconnected = True

  async def get_messages(self, chat, *, ids: int):
    self.get_messages_calls.append({"chat": chat, "ids": ids})
    return self.root if ids == getattr(self.root, "id", None) else None


class FakeReadStateClient:
  def __init__(self) -> None:
    self.disconnected = False
    self.read_acknowledgements: list[object] = []
    self.requests: list[object] = []

  async def disconnect(self) -> None:
    self.disconnected = True

  async def send_read_acknowledge(self, chat):
    self.read_acknowledgements.append(chat)
    return None

  async def __call__(self, request):
    self.requests.append(request)
    return True


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


class FakeInlineButtonMessage:
  def __init__(self, *, buttons: list[list[SimpleNamespace]], message_id: int) -> None:
    self.buttons = buttons
    self.click_calls: list[dict[str, int]] = []
    self.id = message_id

  async def click(self, *, i: int, j: int):
    self.click_calls.append({"i": i, "j": j})
    url = getattr(self.buttons[i][j], "url", None)
    if url:
      return url
    return SimpleNamespace(alert = False, cache_time = 5, message = "Queued", url = None)


class FakeButtonClickClient:
  def __init__(
    self,
    message: FakeInlineButtonMessage | None,
    *,
    request_error: Exception | None = None,
  ) -> None:
    self.disconnected = False
    self.get_messages_calls: list[dict[str, object]] = []
    self.message = message
    self.request_error = request_error
    self.requests: list[object] = []

  async def __call__(self, request):
    self.requests.append(request)
    if self.request_error is not None:
      raise self.request_error
    return SimpleNamespace(updates = [])

  async def disconnect(self) -> None:
    self.disconnected = True

  async def get_messages(self, chat, *, ids: int):
    self.get_messages_calls.append({"chat": chat, "ids": ids})
    return self.message


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


def build_fake_topic_reply(
  *,
  message_id: int,
  text: str,
  date: datetime | None = None,
  reply_to_message_id: int = 777,
  topic_anchor: int = 777,
) -> SimpleNamespace:
  return SimpleNamespace(
    chat = SimpleNamespace(id = -1003783709877, title = "Jarvis Lab", username = None),
    chat_id = -1003783709877,
    date = date,
    direct_messages_topic = None,
    id = message_id,
    message = text,
    out = False,
    reply_to = SimpleNamespace(
      reply_to_msg_id = reply_to_message_id,
      reply_to_top_id = topic_anchor,
    ),
    sender_id = 101,
  )


async def run_fake_topic_read(
  fake_client: FakeTopicReadClient,
  **overrides: object,
) -> tuple[int, dict[str, object]]:
  read_args: dict[str, object] = {
    "after_id": 0,
    "before_id": 0,
    "chat": "-1003783709877",
    "contains": "",
    "limit": 20,
    "topic_anchor": 777,
  }
  read_args.update(overrides)
  emitted: dict[str, object] = {}
  with tempfile.TemporaryDirectory() as temp_dir:
    session_path = Path(temp_dir) / "userbot.session"
    session_path.touch()
    read_args["session"] = str(session_path)

    with (
      patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())),
      patch.object(telethon_cli, "functions", FakeTelethonFunctions),
      patch.object(
        telethon_cli,
        "emit",
        side_effect = lambda payload, **_: emitted.update(payload) or 0,
      ),
    ):
      exit_code = await telethon_cli.run_read(argparse.Namespace(**read_args))
  return exit_code, emitted


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
    if hasattr(request, "top_msg_id"):
      return SimpleNamespace(offset = 0, pts = 123, pts_count = 1)
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


class FakeDeleteTopicHistoryRequest:
  def __init__(self, *, peer, top_msg_id: int) -> None:
    self.peer = peer
    self.top_msg_id = top_msg_id


class FakeGetForumTopicsByIDRequest:
  def __init__(self, *, peer, topics: list[int]) -> None:
    self.peer = peer
    self.topics = topics


class FakeGetForumTopicsRequest:
  def __init__(
    self,
    *,
    peer,
    offset_date,
    offset_id: int,
    offset_topic: int,
    limit: int,
    q: str,
  ) -> None:
    self.limit = limit
    self.offset_date = offset_date
    self.offset_id = offset_id
    self.offset_topic = offset_topic
    self.peer = peer
    self.q = q


class FakeGetRepliesRequest:
  def __init__(self, **kwargs) -> None:
    for key, value in kwargs.items():
      setattr(self, key, value)


class FakeMarkDialogUnreadRequest:
  def __init__(self, *, peer, unread: bool) -> None:
    self.peer = peer
    self.unread = unread


class FakeJoinChannelRequest:
  def __init__(self, *, channel: str) -> None:
    self.channel = channel


class FakeImportChatInviteRequest:
  def __init__(self, *, hash: str) -> None:
    self.hash = hash


class FakeTelethonFunctions:
  channels = SimpleNamespace(JoinChannelRequest = FakeJoinChannelRequest)
  messages = SimpleNamespace(
    CreateForumTopicRequest = FakeCreateForumTopicRequest,
    DeleteTopicHistoryRequest = FakeDeleteTopicHistoryRequest,
    GetForumTopicsByIDRequest = FakeGetForumTopicsByIDRequest,
    GetForumTopicsRequest = FakeGetForumTopicsRequest,
    GetRepliesRequest = FakeGetRepliesRequest,
    MarkDialogUnreadRequest = FakeMarkDialogUnreadRequest,
    ImportChatInviteRequest = FakeImportChatInviteRequest,
  )


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
  def setUp(self) -> None:
    # Unit tests must never contend with or create the real machine-wide lock.
    # Give every test its own explicit lock while preserving production defaults.
    self.lock_temp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(self.lock_temp_dir.cleanup)
    self.lock_env = patch.dict(
      os.environ,
      {
        telethon_cli.SESSION_LOCK_PATH_ENV: str(
          Path(self.lock_temp_dir.name) / "test-session.lock"
        )
      },
      clear = False,
    )
    self.lock_env.start()
    self.addCleanup(self.lock_env.stop)

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

  async def test_owner_claim_adopts_authorized_jarvis_when_machine_is_unauthorized(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      main = root / "main.session"
      selector = root / "owner" / "canonical-session.path"
      for candidate in (machine, jarvis, main):
        candidate.touch()
      clients = iter(
        [
          FakeOwnerProbeClient(None),
          FakeOwnerProbeClient(99),
          FakeOwnerProbeClient(99),
        ]
      )
      emitted: dict[str, object] = {}

      with (
        patch.object(telethon_cli, "create_telegram_client", side_effect=lambda *args, **kwargs: next(clients)),
        patch.object(telethon_cli, "resolve_api_credentials", return_value=(123, "hash")),
        patch.object(telethon_cli, "emit", side_effect=lambda payload: emitted.update(payload) or 0),
      ):
        exit_code = await telethon_cli.run_owner_claim(
          argparse.Namespace(
            candidate=[
              f"machine={machine}",
              f"jarvis-state-legacy={jarvis}",
              f"main-canonical-legacy={main}",
            ],
            lock=None,
            selector=str(selector),
            source="jarvis-state-legacy",
          )
        )

      self.assertEqual(exit_code, 0)
      self.assertTrue(emitted["claimed"])
      self.assertEqual(emitted["unauthorized_sources"], ["machine"])
      self.assertNotIn("user_id", emitted)
      self.assertEqual(
        selector.read_text(encoding="utf-8"),
        f"{Path(os.path.realpath(jarvis))}\n",
      )

  async def test_owner_claim_fails_closed_for_two_authorized_accounts(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / "canonical-session.path"
      machine.touch()
      jarvis.touch()
      clients = iter([FakeOwnerProbeClient(101), FakeOwnerProbeClient(202)])
      failure: dict[str, object] = {}

      with (
        patch.object(telethon_cli, "create_telegram_client", side_effect=lambda *args, **kwargs: next(clients)),
        patch.object(telethon_cli, "resolve_api_credentials", return_value=(123, "hash")),
        patch.object(
          telethon_cli,
          "fail",
          side_effect=lambda code, message, **kwargs: failure.update(
            {"code": code, "message": message, **kwargs}
          ) or 1,
        ),
      ):
        exit_code = await telethon_cli.run_owner_claim(
          argparse.Namespace(
            candidate=[
              f"machine={machine}",
              f"jarvis-state-legacy={jarvis}",
            ],
            lock=None,
            selector=str(selector),
            source="jarvis-state-legacy",
          )
        )

      self.assertEqual(exit_code, 1)
      self.assertEqual(failure["code"], "E_DIVERGENT_SESSION_ACCOUNTS")
      self.assertFalse(selector.exists())

  async def test_owner_claim_reauth_hint_appears_only_when_none_are_authorized(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / "canonical-session.path"
      machine.touch()
      jarvis.touch()
      clients = iter([FakeOwnerProbeClient(None), FakeOwnerProbeClient(None)])
      failure: dict[str, object] = {}

      with (
        patch.object(telethon_cli, "create_telegram_client", side_effect=lambda *args, **kwargs: next(clients)),
        patch.object(telethon_cli, "resolve_api_credentials", return_value=(123, "hash")),
        patch.object(
          telethon_cli,
          "fail",
          side_effect=lambda code, message, **kwargs: failure.update(
            {"code": code, "message": message, **kwargs}
          ) or 1,
        ),
      ):
        exit_code = await telethon_cli.run_owner_claim(
          argparse.Namespace(
            candidate=[
              f"machine={machine}",
              f"jarvis-state-legacy={jarvis}",
            ],
            lock=None,
            selector=str(selector),
            source="jarvis-state-legacy",
          )
        )

      self.assertEqual(exit_code, 1)
      self.assertEqual(failure["code"], "E_NO_AUTHORIZED_SESSION")
      self.assertIn("Reauthenticate", failure["message"])
      self.assertFalse(selector.exists())

  async def test_owner_claim_fails_closed_when_any_candidate_is_unreadable(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / "canonical-session.path"
      machine.touch()
      jarvis.touch()
      clients = iter([FakeUnreadableOwnerProbeClient(), FakeOwnerProbeClient(99)])
      failure: dict[str, object] = {}

      with (
        patch.object(
          telethon_cli,
          "create_telegram_client",
          side_effect=lambda *args, **kwargs: next(clients),
        ),
        patch.object(telethon_cli, "resolve_api_credentials", return_value=(123, "hash")),
        patch.object(
          telethon_cli,
          "fail",
          side_effect=lambda code, message, **kwargs: failure.update(
            {"code": code, "message": message, **kwargs}
          ) or 1,
        ),
      ):
        exit_code = await telethon_cli.run_owner_claim(
          argparse.Namespace(
            candidate=[
              f"machine={machine}",
              f"jarvis-state-legacy={jarvis}",
            ],
            lock=None,
            selector=str(selector),
            source="jarvis-state-legacy",
          )
        )

      self.assertEqual(exit_code, 1)
      self.assertEqual(failure["code"], "E_SESSION_CANDIDATE_UNREADABLE")
      self.assertEqual(failure["details"], {"sources": ["machine"]})
      self.assertIn("(machine)", failure["message"])
      self.assertNotIn("fixture path", str(failure))
      self.assertFalse(selector.exists())

  async def test_logout_preserves_empty_owner_path_for_intentional_relogin(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      session_path = root / "adopted" / "userbot.session"
      lock_path = root / "machine.lock"
      session_path.parent.mkdir(parents = True)
      session_path.write_bytes(b"credential-fixture")
      emitted: dict[str, object] = {}
      owner_existed_before_replace: list[bool] = []
      original_replace = os.replace

      def observing_replace(source, target) -> None:
        owner_existed_before_replace.append(session_path.exists())
        original_replace(source, target)

      with (
        patch.object(os, "replace", side_effect = observing_replace),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload, **kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_logout(
          argparse.Namespace(session = str(session_path), lock = str(lock_path))
        )

      self.assertEqual(exit_code, 0)
      self.assertTrue(emitted["cleared"])
      self.assertTrue(emitted["owner_path_preserved"])
      self.assertEqual(owner_existed_before_replace, [True])
      self.assertEqual(session_path.read_bytes(), b"")
      self.assertEqual(stat.S_IMODE(session_path.stat().st_mode), 0o600)

  async def test_run_login_reads_password_from_local_stdin(self) -> None:
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
        patch.object(sys, "stdin", io.StringIO("super-secret\n")),
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
            phone = "+15551234567",
            secret_stdin = "password",
            session = str(session_path),
          )
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(fake_client.sign_in_calls, [{"password": "super-secret"}])
      self.assertEqual(emitted["state"], "ready")
      self.assertFalse(telethon_cli.resolve_pending_auth_path(session_path).exists())

  async def test_run_login_without_pending_code_routes_back_to_settings(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      emitted: dict[str, object] = {}

      with (
        patch.object(sys, "stdin", io.StringIO("12345\n")),
        patch.object(
          telethon_cli,
          "create_telegram_client",
          return_value = FakePasswordLoginClient(),
        ),
        patch.object(telethon_cli, "resolve_api_credentials", return_value = (123, "hash")),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload, **kwargs: emitted.update(payload) or 1,
        ),
      ):
        exit_code = await telethon_cli.run_login(
          argparse.Namespace(
            phone = "+15551234567",
            secret_stdin = "code",
            session = str(session_path),
          )
        )

      self.assertEqual(exit_code, 1)
      self.assertEqual(emitted["error"]["code"], "E_LOGIN_CODE_NOT_REQUESTED")
      self.assertIn("Jarvis Settings", emitted["error"]["message"])
      self.assertNotIn("--code", emitted["error"]["message"])

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
        patch.object(sys, "stdin", io.StringIO("12345\n")),
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
            phone = "+15551234567",
            secret_stdin = "code",
            session = str(session_path),
          )
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(fake_client.send_code_request_calls, ["+15551234567"])
      self.assertEqual(emitted["state"], "awaiting_code")
      self.assertEqual(emitted["auth_error"], "code_expired")
      refreshed = telethon_cli.read_pending_auth_state(session_path)
      self.assertIsNotNone(refreshed)
      assert refreshed is not None
      self.assertEqual(refreshed["phone_code_hash"], "fresh-hash")

  async def test_run_login_reports_initial_code_request_cooldown_without_looping(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      fake_client = FakeFloodedCodeRequestClient()
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
            phone = "+15551234567",
            secret_stdin = None,
            session = str(session_path),
          )
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(emitted["auth_error"], "cooldown")
      self.assertEqual(emitted["retry_after_seconds"], 37)
      self.assertEqual(emitted["state"], "awaiting_code")
      self.assertIsNone(emitted["pending_auth"])

  async def test_run_login_preserves_pending_hash_after_invalid_code(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      telethon_cli.write_pending_auth_state(
        session_path,
        phone = "+15551234567",
        phone_code_hash = "same-hash",
        state = "awaiting_code",
      )
      fake_client = FakeInvalidCodeClient()
      emitted: dict[str, object] = {}

      with (
        patch.object(sys, "stdin", io.StringIO("11111\n")),
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
            phone = "+15551234567",
            secret_stdin = "code",
            session = str(session_path),
          )
        )

      self.assertEqual(exit_code, 0)
      self.assertEqual(emitted["auth_error"], "code_invalid")
      self.assertEqual(fake_client.send_code_request_calls, [])
      pending = telethon_cli.read_pending_auth_state(session_path)
      self.assertEqual(pending["phone_code_hash"], "same-hash")

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

  async def test_run_read_pushes_message_id_bounds_into_telethon_query(self) -> None:
    fake_client = FakeReadClient([
      SimpleNamespace(
        chat = SimpleNamespace(id = 10, title = None, username = "jarvis_tester_1_bot"),
        chat_id = 10,
        date = None,
        direct_messages_topic = None,
        id = 150,
        message = "bounded",
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
            after_id = 100,
            before_id = 200,
            chat = "@jarvis_tester_1_bot",
            contains = "",
            limit = 5,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(
      fake_client.get_messages_calls,
      [{"chat": "@jarvis_tester_1_bot", "limit": 5, "min_id": 100, "max_id": 200}],
    )
    self.assertEqual(len(emitted["messages"]), 1)
    self.assertEqual(emitted["messages"][0]["message_id"], 150)

  async def test_run_read_uses_strict_topic_rpc_and_returns_authoritative_metadata(self) -> None:
    topic = SimpleNamespace(
      closed = False,
      hidden = False,
      id = 777,
      title = "Gmail Keychain Auth RCA",
    )
    root = SimpleNamespace(
      chat = SimpleNamespace(id = -1003783709877, title = "Jarvis Lab", username = None),
      chat_id = -1003783709877,
      date = None,
      direct_messages_topic = None,
      id = 777,
      message = "topic created",
      out = False,
      reply_to = None,
      sender_id = 101,
    )
    reply = SimpleNamespace(
      chat = root.chat,
      chat_id = root.chat_id,
      date = None,
      direct_messages_topic = None,
      id = 901,
      message = "final RCA",
      out = False,
      reply_to = SimpleNamespace(reply_to_msg_id = 777, reply_to_top_id = 777),
      sender_id = 102,
    )
    fake_client = FakeTopicReadClient(replies = [reply], root = root, topics = [topic])
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
          side_effect = lambda payload, **_: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_read(
          argparse.Namespace(
            after_id = 700,
            before_id = 1000,
            chat = "-1003783709877",
            contains = "",
            limit = 20,
            session = str(session_path),
            topic_anchor = 777,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(
      [type(request) for request in fake_client.requests],
      [FakeGetForumTopicsByIDRequest, FakeGetRepliesRequest, FakeGetRepliesRequest],
    )
    replies_request = fake_client.requests[1]
    self.assertEqual(replies_request.peer, -1003783709877)
    self.assertEqual(replies_request.msg_id, 777)
    self.assertEqual(replies_request.min_id, 700)
    self.assertEqual(replies_request.max_id, 1000)
    self.assertEqual(fake_client.requests[2].offset_id, 901)
    self.assertEqual(fake_client.get_messages_calls, [{"chat": -1003783709877, "ids": 777}])
    self.assertEqual([message["message_id"] for message in emitted["messages"]], [901, 777])
    self.assertEqual(emitted["topic"]["topic_anchor"], 777)
    self.assertEqual(emitted["topic"]["topic_title"], "Gmail Keychain Auth RCA")

  async def test_run_read_paginates_short_topic_pages_until_contains_match(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = False, id = 777, title = "RCA")
    first_date = datetime(2026, 7, 27, 10, 0, tzinfo = timezone.utc)
    first_reply = build_fake_topic_reply(
      date = first_date,
      message_id = 950,
      text = "unrelated text inside the named topic",
    )
    matching_reply = build_fake_topic_reply(
      date = first_date - timedelta(minutes = 1),
      message_id = 940,
      reply_to_message_id = 950,
      text = "needle result",
    )
    fake_client = FakeTopicReadClient(
      replies = [],
      reply_pages = [[first_reply], [matching_reply], []],
      root = None,
      topics = [topic],
    )
    exit_code, emitted = await run_fake_topic_read(
      fake_client,
      contains = "needle",
      limit = 1,
    )

    self.assertEqual(exit_code, 0)
    reply_requests = [
      request for request in fake_client.requests if isinstance(request, FakeGetRepliesRequest)
    ]
    self.assertEqual(len(reply_requests), 3)
    self.assertEqual([request.limit for request in reply_requests], [200, 199, 198])
    self.assertEqual([request.offset_id for request in reply_requests], [0, 950, 940])
    self.assertEqual(
      [request.offset_date for request in reply_requests],
      [None, first_date, first_date - timedelta(minutes = 1)],
    )
    self.assertTrue(all(request.peer == -1003783709877 for request in reply_requests))
    self.assertTrue(all(request.msg_id == 777 for request in reply_requests))
    self.assertEqual([message["message_id"] for message in emitted["messages"]], [940])

  async def test_run_read_stops_multi_page_topic_scan_at_requested_limit(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = False, id = 777, title = "RCA")
    replies = [
      build_fake_topic_reply(message_id = message_id, text = f"reply {message_id}")
      for message_id in (950, 940)
    ]
    fake_client = FakeTopicReadClient(
      replies = [],
      reply_pages = [[replies[0]], [replies[1]]],
      root = None,
      topics = [topic],
    )
    exit_code, emitted = await run_fake_topic_read(
      fake_client,
      after_id = 900,
      before_id = 1000,
      limit = 2,
    )

    self.assertEqual(exit_code, 0)
    reply_requests = [
      request for request in fake_client.requests if isinstance(request, FakeGetRepliesRequest)
    ]
    self.assertEqual([request.limit for request in reply_requests], [2, 1])
    self.assertEqual([request.offset_id for request in reply_requests], [0, 950])
    self.assertTrue(all(request.min_id == 900 for request in reply_requests))
    self.assertTrue(all(request.max_id == 1000 for request in reply_requests))
    self.assertTrue(all(request.msg_id == 777 for request in reply_requests))
    self.assertEqual([message["message_id"] for message in emitted["messages"]], [950, 940])

  async def test_run_read_rejects_mixed_valid_and_invalid_topic_page(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = False, id = 777, title = "RCA")
    fake_client = FakeTopicReadClient(
      replies = [],
      reply_pages = [[
        build_fake_topic_reply(message_id = 950, text = "valid"),
        build_fake_topic_reply(message_id = 0, text = "unprovable"),
      ]],
      root = None,
      topics = [topic],
    )

    exit_code, emitted = await run_fake_topic_read(fake_client, limit = 2)

    self.assertEqual(exit_code, 1)
    self.assertEqual(emitted["error"]["code"], "E_TOPIC_READ_INCOMPLETE")
    self.assertIn("invalid message id", emitted["error"]["message"])
    self.assertEqual(fake_client.get_messages_calls, [])

  async def test_run_read_rejects_topic_page_entries_outside_requested_bounds(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = False, id = 777, title = "RCA")
    cases = [
      ("lower", 100, 0, 100, "lower bound"),
      ("upper", 0, 200, 200, "upper bound"),
    ]
    for name, after_id, before_id, message_id, expected_error in cases:
      with self.subTest(name = name):
        fake_client = FakeTopicReadClient(
          replies = [],
          reply_pages = [[build_fake_topic_reply(message_id = message_id, text = name)]],
          root = None,
          topics = [topic],
        )

        exit_code, emitted = await run_fake_topic_read(
          fake_client,
          after_id = after_id,
          before_id = before_id,
          limit = 1,
        )

        self.assertEqual(exit_code, 1)
        self.assertEqual(emitted["error"]["code"], "E_TOPIC_READ_INCOMPLETE")
        self.assertIn(expected_error, emitted["error"]["message"])
        self.assertEqual(fake_client.get_messages_calls, [])

  async def test_run_read_rejects_non_advancing_topic_page(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = False, id = 777, title = "RCA")
    reply = build_fake_topic_reply(message_id = 950, text = "duplicate cursor")
    fake_client = FakeTopicReadClient(
      replies = [],
      reply_pages = [[reply], [reply]],
      root = None,
      topics = [topic],
    )

    exit_code, emitted = await run_fake_topic_read(fake_client, limit = 2)

    self.assertEqual(exit_code, 1)
    self.assertEqual(emitted["error"]["code"], "E_TOPIC_READ_INCOMPLETE")
    self.assertIn("did not advance", emitted["error"]["message"])
    self.assertEqual(fake_client.get_messages_calls, [])

  async def test_run_read_caps_an_over_returning_topic_page(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = False, id = 777, title = "RCA")
    fake_client = FakeTopicReadClient(
      replies = [],
      reply_pages = [[
        build_fake_topic_reply(message_id = 950, text = "newest"),
        build_fake_topic_reply(message_id = 940, text = "second"),
        build_fake_topic_reply(message_id = 930, text = "over cap"),
      ]],
      root = None,
      topics = [topic],
    )

    exit_code, emitted = await run_fake_topic_read(fake_client, limit = 2)

    self.assertEqual(exit_code, 0)
    self.assertEqual([message["message_id"] for message in emitted["messages"]], [950, 940])
    reply_requests = [
      request for request in fake_client.requests if isinstance(request, FakeGetRepliesRequest)
    ]
    self.assertEqual([request.limit for request in reply_requests], [2])

  async def test_run_read_supports_general_topic_anchor_one(self) -> None:
    topic = SimpleNamespace(closed = False, hidden = True, id = 1, title = "General")
    fake_client = FakeTopicReadClient(replies = [], root = None, topics = [topic])
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
          side_effect = lambda payload, **_: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_read(
          argparse.Namespace(
            after_id = 0,
            before_id = 0,
            chat = "-1003783709877",
            contains = "",
            limit = 20,
            session = str(session_path),
            topic_anchor = 1,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(emitted["messages"], [])
    self.assertEqual(emitted["topic"]["topic_anchor"], 1)
    self.assertEqual(emitted["topic"]["topic_title"], "General")
    self.assertTrue(emitted["topic"]["hidden"])

  async def test_run_read_fails_when_topic_anchor_is_not_in_target_chat(self) -> None:
    fake_client = FakeTopicReadClient(replies = [], root = None, topics = [])
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
          side_effect = lambda payload, **_: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_read(
          argparse.Namespace(
            after_id = 0,
            before_id = 0,
            chat = "-1003783709877",
            contains = "",
            limit = 20,
            session = str(session_path),
            topic_anchor = 999,
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(emitted["error"]["code"], "E_TOPIC_NOT_FOUND")
    self.assertEqual(emitted["error"]["details"]["topic_anchor"], 999)
    self.assertEqual([type(request) for request in fake_client.requests], [FakeGetForumTopicsByIDRequest])
    self.assertEqual(fake_client.get_messages_calls, [])

  async def test_run_topic_resolve_finds_one_exact_title_across_short_pages(self) -> None:
    first_page_date = datetime(2026, 7, 27, 10, 0, tzinfo = timezone.utc)
    topic_pages = [
      SimpleNamespace(
        count = 2,
        messages = [SimpleNamespace(date = first_page_date, id = 901)],
        topics = [
          SimpleNamespace(
            closed = False,
            hidden = False,
            id = 777,
            title = "Gmail Keychain follow-up",
            top_message = 901,
          )
        ],
      ),
      SimpleNamespace(
        count = 2,
        messages = [SimpleNamespace(date = first_page_date - timedelta(minutes = 1), id = 900)],
        topics = [
          SimpleNamespace(
            closed = False,
            hidden = False,
            id = 778,
            title = "Gmail Keychain Auth RCA",
            top_message = 900,
          )
        ],
      ),
    ]
    fake_client = FakeTopicReadClient(
      replies = [],
      root = None,
      topic_pages = topic_pages,
      topics = [],
    )
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
          side_effect = lambda payload, **_: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_topic_resolve(
          argparse.Namespace(
            chat = "-1003783709877",
            session = str(session_path),
            title = "gmail keychain auth rca",
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(
      [type(request) for request in fake_client.requests],
      [FakeGetForumTopicsRequest, FakeGetForumTopicsRequest],
    )
    self.assertEqual(fake_client.requests[0].q, "gmail keychain auth rca")
    self.assertEqual(fake_client.requests[1].offset_date, first_page_date)
    self.assertEqual(fake_client.requests[1].offset_id, 901)
    self.assertEqual(fake_client.requests[1].offset_topic, 777)
    self.assertEqual(emitted["topic"]["topic_anchor"], 778)
    self.assertEqual(emitted["topic"]["topic_title"], "Gmail Keychain Auth RCA")

  async def test_run_topic_resolve_rejects_duplicate_exact_titles_across_pages(self) -> None:
    first_page_date = datetime(2026, 7, 27, 10, 0, tzinfo = timezone.utc)
    topic_pages = [
      SimpleNamespace(
        count = 2,
        messages = [SimpleNamespace(date = first_page_date, id = 901)],
        topics = [
          SimpleNamespace(
            closed = False,
            hidden = False,
            id = 777,
            title = "Gmail Keychain Auth RCA",
            top_message = 901,
          )
        ],
      ),
      SimpleNamespace(
        count = 2,
        messages = [SimpleNamespace(date = first_page_date - timedelta(minutes = 1), id = 900)],
        topics = [
          SimpleNamespace(
            closed = False,
            hidden = False,
            id = 778,
            title = "Gmail Keychain Auth RCA",
            top_message = 900,
          )
        ],
      ),
    ]
    fake_client = FakeTopicReadClient(
      replies = [],
      root = None,
      topic_pages = topic_pages,
      topics = [],
    )
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
          side_effect = lambda payload, **_: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_topic_resolve(
          argparse.Namespace(
            chat = "-1003783709877",
            session = str(session_path),
            title = "Gmail Keychain Auth RCA",
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(emitted["error"]["code"], "E_TOPIC_AMBIGUOUS")
    self.assertEqual(emitted["error"]["details"]["topic_anchors"], [777, 778])
    self.assertEqual(len(fake_client.requests), 2)

  async def test_run_topic_resolve_reports_missing_title_after_all_pages(self) -> None:
    first_page_date = datetime(2026, 7, 27, 10, 0, tzinfo = timezone.utc)
    topic_pages = [
      SimpleNamespace(
        count = 2,
        messages = [SimpleNamespace(date = first_page_date, id = 901)],
        topics = [
          SimpleNamespace(
            closed = False,
            hidden = False,
            id = 777,
            title = "Gmail Keychain follow-up",
            top_message = 901,
          )
        ],
      ),
      SimpleNamespace(
        count = 2,
        messages = [SimpleNamespace(date = first_page_date - timedelta(minutes = 1), id = 900)],
        topics = [
          SimpleNamespace(
            closed = False,
            hidden = False,
            id = 778,
            title = "Unrelated RCA",
            top_message = 900,
          )
        ],
      ),
    ]
    fake_client = FakeTopicReadClient(
      replies = [],
      root = None,
      topic_pages = topic_pages,
      topics = [],
    )
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
          side_effect = lambda payload, **_: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_topic_resolve(
          argparse.Namespace(
            chat = "-1003783709877",
            session = str(session_path),
            title = "Gmail Keychain Auth RCA",
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(emitted["error"]["code"], "E_TOPIC_NOT_FOUND")
    self.assertEqual(len(fake_client.requests), 2)

  async def test_run_mark_read_acknowledges_current_history(self) -> None:
    fake_client = FakeReadStateClient()
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
        exit_code = await telethon_cli.run_mark_read(
          argparse.Namespace(chat = "@jarvis_tester_1_bot", session = str(session_path))
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(fake_client.read_acknowledgements, ["@jarvis_tester_1_bot"])
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(emitted, {"chat": "@jarvis_tester_1_bot", "marked_read": True})

  async def test_run_mark_unread_sets_dialog_unread_flag(self) -> None:
    fake_client = FakeReadStateClient()
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
        exit_code = await telethon_cli.run_mark_unread(
          argparse.Namespace(chat = "-1003783709877", session = str(session_path))
        )

    self.assertEqual(exit_code, 0)
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(len(fake_client.requests), 1)
    self.assertEqual(fake_client.requests[0].peer, -1003783709877)
    self.assertTrue(fake_client.requests[0].unread)
    self.assertEqual(emitted, {"chat": "-1003783709877", "marked_unread": True})

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

  async def test_run_button_click_requires_one_exact_text_and_callback_match(self) -> None:
    message = FakeInlineButtonMessage(
      buttons = [
        [SimpleNamespace(data = b"queue:other", text = "Queue")],
        [SimpleNamespace(data = b"queue:exact", text = "Queue")],
      ],
      message_id = 52831,
    )
    fake_client = FakeButtonClickClient(message)
    emitted: dict[str, object] = {}

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      with (
        patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Queue",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = "queue:exact",
            message_id = 52831,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(
      fake_client.get_messages_calls,
      [{"chat": "@jarvis_tester_1_bot", "ids": 52831}],
    )
    self.assertEqual(message.click_calls, [{"i": 1, "j": 0}])
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(emitted["message_id"], 52831)
    self.assertEqual(emitted["button"]["callback_data"], "queue:exact")
    self.assertEqual(emitted["click_result"]["message"], "Queued")

  async def test_run_button_click_duplicate_match_lists_buttons_without_clicking(self) -> None:
    message = FakeInlineButtonMessage(
      buttons = [
        [SimpleNamespace(data = b"queue:actual", text = "Queue")],
        [SimpleNamespace(data = b"queue:actual", text = "Queue")],
      ],
      message_id = 52831,
    )
    fake_client = FakeButtonClickClient(message)
    emitted: dict[str, object] = {}

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      with (
        patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())),
        patch.object(
          telethon_cli,
          "emit",
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Queue",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = "queue:actual",
            message_id = 52831,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(message.click_calls, [])
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(emitted["error"]["code"], "E_BUTTON_MISMATCH")
    details = emitted["error"]["details"]
    self.assertEqual(details["match_count"], 2)
    self.assertEqual(details["available_buttons"][0]["callback_data"], "queue:actual")

  async def test_run_button_click_requires_one_exact_text_and_url_match(self) -> None:
    expected_url = "https://t.me/+exact-participant-invite"
    message = FakeInlineButtonMessage(
      buttons = [
        [SimpleNamespace(data = None, text = "Participant chat", url = "https://example.com/wrong")],
        [SimpleNamespace(data = None, text = "Participant chat", url = expected_url)],
      ],
      message_id = 52832,
    )
    fake_client = FakeButtonClickClient(message)
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
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Participant chat",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = None,
            expected_url = expected_url,
            message_id = 52832,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(message.click_calls, [])
    self.assertEqual(len(fake_client.requests), 1)
    self.assertIsInstance(fake_client.requests[0], FakeImportChatInviteRequest)
    self.assertEqual(fake_client.requests[0].hash, "exact-participant-invite")
    self.assertEqual(emitted["button"]["url"], expected_url)
    self.assertEqual(emitted["url_action"]["kind"], "import_chat_invite")
    self.assertEqual(emitted["url_action"]["status"], "joined")

  async def test_run_button_click_joins_exact_public_telegram_chat(self) -> None:
    expected_url = "https://telegram.me/openclaw_updates"
    message = FakeInlineButtonMessage(
      buttons = [[SimpleNamespace(data = None, text = "Updates", url = expected_url)]],
      message_id = 52833,
    )
    fake_client = FakeButtonClickClient(message)
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
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Updates",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = None,
            expected_url = expected_url,
            message_id = 52833,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(message.click_calls, [])
    self.assertEqual(len(fake_client.requests), 1)
    self.assertIsInstance(fake_client.requests[0], FakeJoinChannelRequest)
    self.assertEqual(fake_client.requests[0].channel, "openclaw_updates")
    self.assertEqual(emitted["url_action"]["kind"], "join_public_chat")
    self.assertEqual(emitted["url_action"]["status"], "joined")

  async def test_run_button_click_treats_already_joined_invite_as_idempotent_success(self) -> None:
    expected_url = "https://t.me/joinchat/AlreadyJoinedHash"
    message = FakeInlineButtonMessage(
      buttons = [[SimpleNamespace(data = None, text = "Participant chat", url = expected_url)]],
      message_id = 52834,
    )
    already_joined_error = type("UserAlreadyParticipantError", (Exception,), {})("already joined")
    fake_client = FakeButtonClickClient(message, request_error = already_joined_error)
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
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Participant chat",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = None,
            expected_url = expected_url,
            message_id = 52834,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(emitted["url_action"]["status"], "already_member")

  async def test_run_button_click_treats_invite_request_sent_as_pending_success(self) -> None:
    cases = [
      ("https://t.me/+PendingInviteHash", "import_chat_invite"),
      ("https://telegram.me/openclaw_updates", "join_public_chat"),
    ]
    for expected_url, expected_kind in cases:
      with self.subTest(expected_url = expected_url):
        message = FakeInlineButtonMessage(
          buttons = [[SimpleNamespace(data = None, text = "Participant chat", url = expected_url)]],
          message_id = 52838,
        )
        request_sent_error = type("InviteRequestSentError", (Exception,), {})(
          "request sent for admin approval"
        )
        fake_client = FakeButtonClickClient(message, request_error = request_sent_error)
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
              side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
            ),
          ):
            exit_code = await telethon_cli.run_button_click(
              argparse.Namespace(
                button_text = "Participant chat",
                chat = "@jarvis_tester_1_bot",
                expected_callback_data = None,
                expected_url = expected_url,
                message_id = 52838,
                session = str(session_path),
              )
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(emitted["clicked"])
        self.assertEqual(emitted["url_action"]["kind"], expected_kind)
        self.assertEqual(emitted["url_action"]["status"], "request_sent")
        self.assertEqual(message.click_calls, [])
        self.assertEqual(len(fake_client.requests), 1)

  async def test_run_button_click_refuses_external_url_without_opening_it(self) -> None:
    expected_url = "https://example.com/participant-chat"
    message = FakeInlineButtonMessage(
      buttons = [[SimpleNamespace(data = None, text = "Participant chat", url = expected_url)]],
      message_id = 52835,
    )
    fake_client = FakeButtonClickClient(message)
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
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Participant chat",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = None,
            expected_url = expected_url,
            message_id = 52835,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertEqual(message.click_calls, [])
    self.assertEqual(fake_client.requests, [])
    self.assertFalse(emitted["clicked"])
    self.assertTrue(emitted["url_action_required"])
    self.assertEqual(emitted["url_action"]["kind"], "unsupported")
    self.assertEqual(emitted["url_action"]["status"], "action_required")
    self.assertEqual(emitted["url_action"]["url"], expected_url)

  async def test_run_button_click_rejects_url_mismatch_and_duplicate_label_without_action(self) -> None:
    actual_url = "https://t.me/+ActualInviteHash"
    message = FakeInlineButtonMessage(
      buttons = [
        [SimpleNamespace(data = None, text = "Participant chat", url = actual_url)],
        [SimpleNamespace(data = None, text = "Participant chat", url = actual_url)],
      ],
      message_id = 52836,
    )
    fake_client = FakeButtonClickClient(message)
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
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Participant chat",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = None,
            expected_url = actual_url,
            message_id = 52836,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(message.click_calls, [])
    self.assertEqual(fake_client.requests, [])
    self.assertEqual(emitted["error"]["code"], "E_BUTTON_MISMATCH")
    self.assertEqual(emitted["error"]["details"]["match_count"], 2)

  async def test_run_button_click_rejects_exact_url_mismatch_without_action(self) -> None:
    message = FakeInlineButtonMessage(
      buttons = [[SimpleNamespace(data = None, text = "Participant chat", url = "https://t.me/+ActualInviteHash")]],
      message_id = 52837,
    )
    fake_client = FakeButtonClickClient(message)
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
          side_effect = lambda payload, **_kwargs: emitted.update(payload) or 0,
        ),
      ):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Participant chat",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = None,
            expected_url = "https://t.me/+ExpectedInviteHash",
            message_id = 52837,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(message.click_calls, [])
    self.assertEqual(fake_client.requests, [])
    self.assertEqual(emitted["error"]["code"], "E_BUTTON_MISMATCH")
    self.assertEqual(emitted["error"]["details"]["match_count"], 0)

  def test_parse_telegram_join_url_rejects_noncanonical_paths(self) -> None:
    rejected_urls = [
      "https://t.me/",
      "https://t.me//openclaw_updates",
      "https://t.me/openclaw_updates/",
      "https://t.me/openclaw_updates//",
      "https://t.me/openclaw_updates/123",
      "https://t.me/+PendingInviteHash/",
      "https://t.me//+PendingInviteHash",
      "https://t.me/joinchat//PendingInviteHash",
      "https://t.me/joinchat/PendingInviteHash/",
      "https://t.me/joinchat/PendingInviteHash/123",
      "https://t.me/openclaw_updates?start=payload",
      "https://t.me/+PendingInviteHash?single",
      "https://t.me/openclaw_updates#fragment",
    ]

    for rejected_url in rejected_urls:
      with self.subTest(rejected_url = rejected_url):
        self.assertIsNone(telethon_cli.parse_telegram_join_url(rejected_url))

  async def test_run_button_click_rejects_ambiguous_guard_modes_without_clicking(self) -> None:
    message = FakeInlineButtonMessage(
      buttons = [[SimpleNamespace(data = b"queue:actual", text = "Queue", url = None)]],
      message_id = 52831,
    )
    fake_client = FakeButtonClickClient(message)

    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      session_path.touch()
      with patch.object(telethon_cli, "connect_client", return_value = (fake_client, object())):
        exit_code = await telethon_cli.run_button_click(
          argparse.Namespace(
            button_text = "Queue",
            chat = "@jarvis_tester_1_bot",
            expected_callback_data = "queue:actual",
            expected_url = "https://example.com/queue",
            message_id = 52831,
            session = str(session_path),
          )
        )

    self.assertEqual(exit_code, 1)
    self.assertEqual(fake_client.get_messages_calls, [])
    self.assertEqual(message.click_calls, [])

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

  async def test_run_topic_delete_uses_topic_anchor_for_bounded_cleanup(self) -> None:
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
        exit_code = await telethon_cli.run_topic_delete(
          argparse.Namespace(
            chat = "-1003783709877",
            session = str(session_path),
            topic_anchor = 777,
          )
        )

    self.assertEqual(exit_code, 0)
    self.assertTrue(fake_client.disconnected)
    self.assertEqual(fake_client.requests[0].top_msg_id, 777)
    self.assertEqual(emitted["chat_id"], -1003783709877)
    self.assertTrue(emitted["deleted"])
    self.assertEqual(emitted["topic_anchor"], 777)
    self.assertEqual(emitted["affected"]["pts_count"], 1)


class TelethonCliSyncTests(unittest.TestCase):
  def setUp(self) -> None:
    # The synchronous helpers also get a hermetic override so this suite never
    # opens ~/.openclaw state, even when a future test acquires the default lock.
    self.lock_temp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(self.lock_temp_dir.cleanup)
    self.lock_env = patch.dict(
      os.environ,
      {
        telethon_cli.SESSION_LOCK_PATH_ENV: str(
          Path(self.lock_temp_dir.name) / "test-session.lock"
        )
      },
      clear = False,
    )
    self.lock_env.start()
    self.addCleanup(self.lock_env.stop)

  def test_canonical_lock_does_not_change_with_explicit_session_path(self) -> None:
    with patch.dict(os.environ, {}, clear = True):
      first_session = Path("/tmp/first-userbot.session")
      second_session = Path("/tmp/second-userbot.session")

      self.assertEqual(
        telethon_cli.resolve_session_lock_path(),
        telethon_cli.DEFAULT_SESSION_LOCK,
      )
      self.assertNotEqual(first_session, second_session)
      self.assertNotEqual(
        telethon_cli.resolve_session_lock_path(),
        first_session.with_name(f"{first_session.name}.openclaw.lock"),
      )
      self.assertNotEqual(
        telethon_cli.resolve_session_lock_path(),
        second_session.with_name(f"{second_session.name}.openclaw.lock"),
      )

  def test_lock_argument_overrides_environment_without_normalizing_session(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      explicit_lock = Path(temp_dir) / "explicit.lock"
      environment_lock = Path(temp_dir) / "environment.lock"
      raw_session = str(Path(temp_dir) / "nested" / ".." / "userbot.session")

      with patch.dict(
        os.environ,
        {telethon_cli.SESSION_LOCK_PATH_ENV: str(environment_lock)},
        clear = False,
      ):
        parser = telethon_cli.build_parser()
        args = parser.parse_args([
          "--session",
          raw_session,
          "--lock",
          str(explicit_lock),
          "status",
        ])

        self.assertEqual(args.session, raw_session)
        self.assertEqual(telethon_cli.resolve_session_path(args.session), Path(raw_session))
        self.assertEqual(telethon_cli.resolve_session_lock_path(args.lock), explicit_lock)
        self.assertEqual(telethon_cli.resolve_session_lock_scope(args.lock), "argument_override")

  def test_relative_lock_override_is_rejected(self) -> None:
    with self.assertRaisesRegex(ValueError, "E_INVALID_LOCK_SELECTOR"):
      telethon_cli.resolve_session_lock_path("relative/account.lock")

  def test_lock_timeout_diagnostic_does_not_reveal_override_path(self) -> None:
    secret_lock = Path("/tmp/account-name-that-must-not-leak.lock")
    with (
      patch.object(telethon_cli.time, "time", side_effect = [0, 2]),
      patch.object(telethon_cli.time, "sleep"),
      patch.object(telethon_cli.fcntl, "flock", side_effect = OSError("busy")),
    ):
      with self.assertRaises(TimeoutError) as raised:
        with telethon_cli.acquire_session_lock(
          Path("/tmp/session-that-must-not-leak.session"),
          timeout_seconds = 1,
          lock_path_override = secret_lock,
        ):
          self.fail("contended lock unexpectedly acquired")

    diagnostic = str(raised.exception)
    self.assertIn("scope=argument_override", diagnostic)
    self.assertNotIn(str(secret_lock), diagnostic)
    self.assertNotIn("session-that-must-not-leak", diagnostic)

  def test_canonical_lock_uses_private_directory_and_file_modes(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      canonical_lock = Path(temp_dir) / "telegram-user" / "userbot.session.openclaw.lock"
      with (
        patch.dict(os.environ, {}, clear = True),
        patch.object(telethon_cli, "DEFAULT_SESSION_LOCK", canonical_lock),
      ):
        with telethon_cli.acquire_session_lock(Path(temp_dir) / "unused.session"):
          self.assertEqual(stat.S_IMODE(canonical_lock.parent.stat().st_mode), 0o700)
          self.assertEqual(stat.S_IMODE(canonical_lock.stat().st_mode), 0o600)

  @unittest.skipIf(telethon_cli.fcntl is None, "requires POSIX flock")
  def test_lock_serializes_separate_processes_with_different_sessions(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      lock_path = Path(temp_dir) / "hermetic.lock"
      helper = textwrap.dedent(
        """
        import os
        import sys
        import time
        from pathlib import Path

        import telethon_cli

        print("starting", flush=True)
        with telethon_cli.acquire_session_lock(Path(sys.argv[1]), timeout_seconds=3):
          print("acquired", flush=True)
          time.sleep(float(sys.argv[2]))
        """
      )
      env = {
        **os.environ,
        telethon_cli.SESSION_LOCK_PATH_ENV: str(lock_path),
      }

      first = subprocess.Popen(
        [sys.executable, "-c", helper, str(Path(temp_dir) / "first.session"), "0.8"],
        cwd = SCRIPT_DIR,
        env = env,
        stderr = subprocess.PIPE,
        stdout = subprocess.PIPE,
        text = True,
      )
      self.assertEqual(first.stdout.readline().strip(), "starting")
      self.assertEqual(first.stdout.readline().strip(), "acquired")

      second = subprocess.Popen(
        [sys.executable, "-c", helper, str(Path(temp_dir) / "second.session"), "0"],
        cwd = SCRIPT_DIR,
        env = env,
        stderr = subprocess.PIPE,
        stdout = subprocess.PIPE,
        text = True,
      )
      self.assertEqual(second.stdout.readline().strip(), "starting")
      time.sleep(0.2)
      self.assertIsNone(second.poll(), "second process bypassed the shared lock")

      first_stdout, first_stderr = first.communicate(timeout = 3)
      second_stdout, second_stderr = second.communicate(timeout = 3)
      self.assertEqual(first.returncode, 0, first_stderr)
      self.assertEqual(second.returncode, 0, second_stderr)
      self.assertEqual(first_stdout, "")
      self.assertIn("acquired", second_stdout)

  @unittest.skipIf(telethon_cli.fcntl is None, "requires POSIX flock")
  def test_legacy_per_session_lock_blocks_new_version_operation(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "noncanonical.session"
      machine_lock = Path(temp_dir) / "machine.lock"
      legacy_lock = session_path.with_name(f"{session_path.name}.openclaw.lock")
      old_helper = textwrap.dedent(
        """
        import fcntl
        import sys
        import time

        with open(sys.argv[1], "a+", encoding="utf-8") as handle:
          fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
          print("old-acquired", flush=True)
          time.sleep(0.8)
        """
      )
      new_helper = textwrap.dedent(
        """
        import sys
        from pathlib import Path

        import telethon_cli

        print("new-starting", flush=True)
        with telethon_cli.acquire_session_lock(Path(sys.argv[1]), timeout_seconds=3):
          print("new-acquired", flush=True)
        """
      )
      env = {
        **os.environ,
        telethon_cli.SESSION_LOCK_PATH_ENV: str(machine_lock),
      }

      old_process = subprocess.Popen(
        [sys.executable, "-c", old_helper, str(legacy_lock)],
        cwd = SCRIPT_DIR,
        env = env,
        stderr = subprocess.PIPE,
        stdout = subprocess.PIPE,
        text = True,
      )
      self.assertEqual(old_process.stdout.readline().strip(), "old-acquired")

      new_process = subprocess.Popen(
        [sys.executable, "-c", new_helper, str(session_path)],
        cwd = SCRIPT_DIR,
        env = env,
        stderr = subprocess.PIPE,
        stdout = subprocess.PIPE,
        text = True,
      )
      self.assertEqual(new_process.stdout.readline().strip(), "new-starting")
      time.sleep(0.2)
      self.assertIsNone(new_process.poll(), "new process bypassed the legacy session lock")

      old_stdout, old_stderr = old_process.communicate(timeout = 3)
      new_stdout, new_stderr = new_process.communicate(timeout = 3)
      self.assertEqual(old_process.returncode, 0, old_stderr)
      self.assertEqual(new_process.returncode, 0, new_stderr)
      self.assertEqual(old_stdout, "")
      self.assertIn("new-acquired", new_stdout)

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

  def test_clear_session_artifacts_retains_transition_lock_files(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      session_path = Path(temp_dir) / "userbot.session"
      legacy_lock = session_path.with_name(f"{session_path.name}.openclaw.lock")
      machine_lock = Path(temp_dir) / "machine.openclaw.lock"
      session_path.touch()
      legacy_lock.touch()
      machine_lock.touch()

      with patch.object(telethon_cli, "DEFAULT_SESSION_LOCK", machine_lock):
        removed_paths = telethon_cli.clear_session_artifacts(session_path)

      self.assertIn(str(session_path), removed_paths)
      self.assertTrue(legacy_lock.exists())
      self.assertTrue(machine_lock.exists())

  def test_build_parser_rejects_password_flag(self) -> None:
    parser = telethon_cli.build_parser()
    with self.assertRaises(SystemExit):
      parser.parse_args(["login", "--phone", "+15551234567", "--password", "secret"])

  def test_build_parser_accepts_topic_and_media_send_flags(self) -> None:
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

    topic_delete_args = parser.parse_args([
      "topic-delete",
      "--chat",
      "-1003783709877",
      "--topic-anchor",
      "777",
    ])
    self.assertEqual(topic_delete_args.command, "topic-delete")
    self.assertEqual(topic_delete_args.topic_anchor, 777)

    topic_resolve_args = parser.parse_args([
      "topic-resolve",
      "--chat",
      "-1003783709877",
      "--title",
      "Gmail Keychain Auth RCA",
    ])
    self.assertEqual(topic_resolve_args.command, "topic-resolve")
    self.assertEqual(topic_resolve_args.title, "Gmail Keychain Auth RCA")

    topic_read_args = parser.parse_args([
      "read",
      "--chat",
      "-1003783709877",
      "--topic-anchor",
      "777",
    ])
    self.assertEqual(topic_read_args.command, "read")
    self.assertEqual(topic_read_args.topic_anchor, 777)

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

    button_click_args = parser.parse_args([
      "button-click",
      "--chat",
      "@jarvis_tester_1_bot",
      "--message-id",
      "52831",
      "--button-text",
      "Queue",
      "--expected-callback-data",
      "queue:proof",
    ])
    self.assertEqual(button_click_args.command, "button-click")
    self.assertEqual(button_click_args.message_id, 52831)
    self.assertEqual(button_click_args.button_text, "Queue")
    self.assertEqual(button_click_args.expected_callback_data, "queue:proof")

    mark_read_args = parser.parse_args([
      "mark-read",
      "--chat",
      "@jarvis_tester_1_bot",
    ])
    self.assertEqual(mark_read_args.command, "mark-read")
    self.assertEqual(mark_read_args.chat, "@jarvis_tester_1_bot")

    mark_unread_args = parser.parse_args([
      "mark-unread",
      "--chat",
      "-1003783709877",
    ])
    self.assertEqual(mark_unread_args.command, "mark-unread")
    self.assertEqual(mark_unread_args.chat, "-1003783709877")

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
