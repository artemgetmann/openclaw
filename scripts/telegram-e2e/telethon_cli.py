#!/usr/bin/env python3
"""
Structured Telethon transport for repo-local Telegram user E2E tooling.

The TypeScript CLI owns operator UX and matching logic. This backend stays
small on purpose: connect safely, send messages, and read normalized message
metadata without leaking secrets into stderr/stdout.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

try:
  import fcntl
except Exception:  # pragma: no cover - Windows fallback
  fcntl = None

try:
  import msvcrt
except Exception:  # pragma: no cover - POSIX fallback
  msvcrt = None

from telethon_compat import create_telegram_client


DEFAULT_SESSION = Path(__file__).resolve().parent / "tmp" / "userbot.session"
DEFAULT_LOCK_TIMEOUT_SECONDS = 15
PENDING_AUTH_SUFFIX = ".openclaw-login.json"
LOGIN_PASSWORD_ENV = "OPENCLAW_TELEGRAM_USER_LOGIN_PASSWORD"


def emit(payload: object, *, stream = sys.stdout) -> int:
  stream.write(json.dumps(payload, ensure_ascii=True))
  stream.write("\n")
  stream.flush()
  return 0


def sanitize_error_text(raw: str) -> str:
  text = raw.replace("\n", " ").replace("\r", " ").strip()
  for secret in (
    os.environ.get("TELEGRAM_API_HASH", ""),
    os.environ.get("TELEGRAM_BOT_TOKEN", ""),
    os.environ.get("TG_BOT_TOKEN", ""),
    os.environ.get(LOGIN_PASSWORD_ENV, ""),
  ):
    if secret:
      text = text.replace(secret, "<redacted>")
  text = re.sub(r"\s+", " ", text).strip()
  return text[:400] if text else "unexpected error"


def fail(code: str, message: str, *, details: dict[str, object] | None = None, exit_code: int = 1) -> int:
  emit(
    {
      "error": {
        "code": code,
        "message": message,
        "details": details or None,
      }
    },
    stream = sys.stderr,
  )
  return exit_code


def resolve_api_credentials() -> tuple[int, str]:
  api_id_raw = (os.environ.get("TELEGRAM_API_ID") or "").strip()
  api_hash = (os.environ.get("TELEGRAM_API_HASH") or "").strip()
  if not api_id_raw or not api_hash:
    raise ValueError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required.")
  if not api_id_raw.isdigit() or api_id_raw == "0":
    raise ValueError("TELEGRAM_API_ID must be a positive integer.")
  return int(api_id_raw), api_hash


def resolve_session_path(explicit: str | None) -> Path:
  from_env = (os.environ.get("OPENCLAW_TELEGRAM_USER_SESSION") or "").strip()
  raw = explicit or from_env or str(DEFAULT_SESSION)
  session_path = Path(raw).expanduser()
  session_path.parent.mkdir(parents=True, exist_ok=True)
  return session_path


def resolve_chat(chat_raw: str) -> int | str:
  chat = chat_raw.strip()
  if chat.lstrip("-").isdigit():
    return int(chat)
  return chat


def resolve_pending_auth_path(session_path: Path) -> Path:
  return session_path.with_name(f"{session_path.name}{PENDING_AUTH_SUFFIX}")


def is_valid_pending_auth_state(state: str) -> bool:
  return state in {"awaiting_code", "awaiting_password"}


def read_pending_auth_state(session_path: Path) -> dict[str, object] | None:
  pending_path = resolve_pending_auth_path(session_path)
  if not pending_path.exists() or not pending_path.is_file():
    return None
  try:
    payload = json.loads(pending_path.read_text(encoding = "utf-8"))
  except Exception:
    return None
  if not isinstance(payload, dict):
    return None
  return payload


def write_pending_auth_state(
  session_path: Path,
  *,
  phone: str,
  phone_code_hash: str,
  state: str,
) -> dict[str, object]:
  payload = {
    "phone": phone,
    "phone_code_hash": phone_code_hash,
    "state": state,
  }
  pending_path = resolve_pending_auth_path(session_path)
  pending_path.parent.mkdir(parents = True, exist_ok = True)
  pending_path.write_text(json.dumps(payload, ensure_ascii = True, indent = 2) + "\n", encoding = "utf-8")
  return payload


def clear_pending_auth_state(session_path: Path) -> None:
  pending_path = resolve_pending_auth_path(session_path)
  try:
    pending_path.unlink()
  except FileNotFoundError:
    return


def build_user_payload(me) -> dict[str, object | None]:
  return {
    "first_name": getattr(me, "first_name", None),
    "user_id": int(getattr(me, "id", 0) or 0),
    "username": getattr(me, "username", None),
  }


def build_pending_login_payload(pending_auth: dict[str, object] | None) -> dict[str, object | None] | None:
  if not pending_auth:
    return None
  state = str(pending_auth.get("state") or "").strip()
  phone = str(pending_auth.get("phone") or "").strip()
  if not is_valid_pending_auth_state(state):
    return None
  return {
    "phone": phone or None,
    "state": state,
  }


def emit_auth_status(
  *,
  chat_payload: dict[str, object | None] | None,
  pending_auth: dict[str, object] | None,
  session_path: Path,
  state: str,
  user_payload: dict[str, object | None] | None,
) -> int:
  return emit(
    {
      "chat": chat_payload,
      "pending_login": build_pending_login_payload(pending_auth),
      "session_path": str(session_path),
      "state": state,
      "user": user_payload,
    }
  )


def clear_session_artifacts(session_path: Path) -> list[str]:
  removed_paths: list[str] = []
  if session_path.exists() and session_path.is_dir():
    raise ValueError(
      f"Refusing to clear Telegram session artifacts because session path is a directory: {session_path}"
    )
  # Telethon can leave SQLite sidecars behind depending on shutdown timing and
  # platform filesystem semantics. Only delete the exact file artifacts that
  # belong to this session path; never recurse into directories.
  candidate_paths = [
    session_path,
    resolve_pending_auth_path(session_path),
    session_path.with_name(f"{session_path.name}.openclaw.lock"),
    Path(f"{session_path}-journal"),
    Path(f"{session_path}-shm"),
    Path(f"{session_path}-wal"),
  ]

  for candidate in candidate_paths:
    if candidate.exists() and candidate.is_dir():
      raise ValueError(f"Refusing to delete unexpected directory artifact: {candidate}")
    try:
      candidate.unlink()
      removed_paths.append(str(candidate))
    except FileNotFoundError:
      continue
  return removed_paths


async def refresh_pending_code_request(
  client,
  session_path: Path,
  *,
  phone: str,
) -> dict[str, object]:
  sent = await client.send_code_request(phone)
  return write_pending_auth_state(
    session_path,
    phone = phone,
    phone_code_hash = str(getattr(sent, "phone_code_hash", "") or ""),
    state = "awaiting_code",
  )


def read_login_password() -> str:
  return str(os.environ.get(LOGIN_PASSWORD_ENV) or "").strip()


def classify_login_error(error: Exception) -> str:
  return error.__class__.__name__


@contextmanager
def acquire_session_lock(session_path: Path, timeout_seconds: int = DEFAULT_LOCK_TIMEOUT_SECONDS):
  lock_path = session_path.with_name(f"{session_path.name}.openclaw.lock")
  lock_path.parent.mkdir(parents=True, exist_ok=True)
  with open(lock_path, "a+", encoding = "utf-8") as handle:
    deadline = time.time() + max(1, timeout_seconds)
    while True:
      try:
        if fcntl is not None:
          fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
          break
        if msvcrt is not None:  # pragma: no cover - Windows only
          msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
          break
        break
      except OSError:
        if time.time() >= deadline:
          raise TimeoutError(f"timed out waiting for session lock at {lock_path}") from None
        time.sleep(0.2)

    try:
      yield
    finally:
      try:
        if fcntl is not None:
          fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        elif msvcrt is not None:  # pragma: no cover - Windows only
          msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
      except OSError:
        pass


def build_chat_payload(chat) -> dict[str, object | None]:
  return {
    "chat_id": int(getattr(chat, "id", 0) or 0) or None,
    "peer_type": type(chat).__name__,
    "title": getattr(chat, "title", None),
    "username": getattr(chat, "username", None),
  }


def build_message_payload(message, *, chat = None) -> dict[str, object | None]:
  reply_to = getattr(message, "reply_to", None)
  direct_topic_id = getattr(getattr(message, "direct_messages_topic", None), "topic_id", None)
  thread_anchor = (
    direct_topic_id
    if direct_topic_id is not None
    else getattr(reply_to, "reply_to_top_id", None)
    if reply_to is not None and getattr(reply_to, "reply_to_top_id", None) is not None
    else getattr(reply_to, "reply_to_msg_id", None)
    if reply_to is not None
    else None
  )
  resolved_chat = chat if chat is not None else getattr(message, "chat", None)
  return {
    "chat_id": int(getattr(message, "chat_id", 0) or 0) or None,
    "chat_title": getattr(resolved_chat, "title", None),
    "chat_username": getattr(resolved_chat, "username", None),
    "date": getattr(message, "date", None).isoformat() if getattr(message, "date", None) else None,
    "direct_messages_topic": {"topic_id": int(direct_topic_id)} if direct_topic_id is not None else None,
    "direct_messages_topic_id": int(direct_topic_id) if direct_topic_id is not None else None,
    "message_id": int(getattr(message, "id", 0) or 0),
    "out": bool(getattr(message, "out", False)),
    "reply_to_msg_id": int(getattr(reply_to, "reply_to_msg_id", 0)) if getattr(reply_to, "reply_to_msg_id", None) is not None else None,
    "reply_to_top_id": int(getattr(reply_to, "reply_to_top_id", 0)) if getattr(reply_to, "reply_to_top_id", None) is not None else None,
    "sender_id": int(getattr(message, "sender_id", 0) or 0) or None,
    "text": (getattr(message, "message", "") or "").strip(),
    "thread_anchor": int(thread_anchor) if thread_anchor is not None else None,
  }


def dialog_has_unread(dialog) -> bool:
  return any(
    int(getattr(dialog, field, 0) or 0) > 0
    for field in ("unread_count", "unread_mentions_count", "unread_reactions_count")
  )


def dialog_matches_inbox_filters(dialog, *, dm_only: bool, unread_only: bool) -> bool:
  if dm_only and not bool(getattr(dialog, "is_user", False)):
    return False
  if unread_only and not dialog_has_unread(dialog):
    return False
  return True


def compute_inbox_scan_cap(*, limit: int, dm_only: bool, unread_only: bool) -> int:
  # Unfiltered inbox reads can stop at the caller's requested window because every
  # scanned dialog is eligible for return. Filtered reads are different: a busy
  # account can have hundreds of pinned/groups/read chats ahead of the first
  # unread DM, so we reserve a larger but still bounded scan budget.
  if not dm_only and not unread_only:
    return limit

  filter_multiplier = 12
  if dm_only and unread_only:
    filter_multiplier = 25
  elif dm_only or unread_only:
    filter_multiplier = 15
  return min(5_000, max(limit * filter_multiplier, 1_000))


def build_dialog_payload(dialog) -> dict[str, object | None]:
  entity = getattr(dialog, "entity", None)
  notify_settings = getattr(dialog, "dialog", None)
  mute_until = getattr(getattr(notify_settings, "notify_settings", None), "mute_until", None)
  # Telethon can surface mute_until either as an epoch-like integer or as a
  # concrete datetime. Normalize both shapes before comparing against "now" so
  # inbox serialization never crashes on unread dialog enumeration.
  if isinstance(mute_until, datetime):
    mute_until_epoch = mute_until.timestamp()
  elif mute_until is None:
    mute_until_epoch = None
  else:
    mute_until_epoch = float(mute_until)
  muted = bool(mute_until_epoch and mute_until_epoch > time.time())
  name = str(getattr(dialog, "name", "") or "").strip()
  title = getattr(entity, "title", None)
  username = getattr(entity, "username", None)
  last_message = getattr(dialog, "message", None)
  return {
    "archived": bool(getattr(dialog, "archived", False)),
    "chat_id": int(getattr(entity, "id", 0) or 0) or None,
    "chat_title": title,
    "chat_username": username,
    "display_name": name or title or username or str(getattr(entity, "id", "unknown")),
    "folder_id": int(getattr(dialog, "folder_id", 0)) if getattr(dialog, "folder_id", None) is not None else None,
    "is_bot": bool(getattr(entity, "bot", False)),
    "is_channel": bool(getattr(dialog, "is_channel", False)),
    "is_group": bool(getattr(dialog, "is_group", False)),
    "is_user": bool(getattr(dialog, "is_user", False)),
    "last_message": build_message_payload(last_message, chat = entity) if last_message is not None else None,
    "muted": muted,
    "pinned": bool(getattr(dialog, "pinned", False)),
    "unread_count": int(getattr(dialog, "unread_count", 0) or 0),
    "unread_mentions_count": int(getattr(dialog, "unread_mentions_count", 0) or 0),
    "unread_reactions_count": int(getattr(dialog, "unread_reactions_count", 0) or 0),
  }


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description = "Telethon transport for OpenClaw Telegram user tooling")
  parser.add_argument("--session", help = "Telethon session path override")
  subparsers = parser.add_subparsers(dest = "command", required = True)

  status = subparsers.add_parser("status", help = "Inspect login/session health")
  status.add_argument("--chat", help = "Optional chat target to resolve")

  login = subparsers.add_parser("login", help = "Log in a real Telegram account")
  login.add_argument("--phone", required = True, help = "Telegram phone number")
  login.add_argument("--code", help = "Telegram login code")

  precheck = subparsers.add_parser("precheck", help = "Validate the Telegram user session")
  precheck.add_argument("--chat", help = "Optional chat target to resolve")

  send = subparsers.add_parser("send", help = "Send a message as the Telegram user")
  send.add_argument("--chat", required = True, help = "Target chat username or id")
  send.add_argument("--message", required = True, help = "Message text")
  send.add_argument("--reply-to", type = int, default = 0, help = "Reply-to message id")

  read = subparsers.add_parser("read", help = "Read recent messages and metadata")
  read.add_argument("--chat", required = True, help = "Target chat username or id")
  read.add_argument("--limit", type = int, default = 20, help = "Maximum number of messages")
  read.add_argument("--after-id", type = int, default = 0, help = "Only return newer messages")
  read.add_argument("--before-id", type = int, default = 0, help = "Only return older messages")

  inbox = subparsers.add_parser("inbox", help = "List dialogs with unread metadata")
  inbox.add_argument("--limit", type = int, default = 20, help = "Maximum number of dialogs")
  inbox.add_argument("--unread", action = "store_true", help = "Only include unread dialogs")
  inbox.add_argument("--dm-only", action = "store_true", help = "Only include direct messages")

  subparsers.add_parser("logout", help = "Clear the Telegram user session")
  return parser


async def connect_client(session_path: Path) -> tuple[Any, object]:
  api_id, api_hash = resolve_api_credentials()
  client = create_telegram_client(
    session_path,
    api_id,
    api_hash,
    flood_sleep_threshold = 0,
  )
  await client.connect()
  if not await client.is_user_authorized():
    await client.disconnect()
    raise PermissionError("Telegram user session is not authorized.")
  me = await client.get_me()
  return client, me


async def run_precheck(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  if not session_path.exists():
    return fail(
      "E_MISSING_SESSION",
      f"Session file not found at {session_path}.",
      details = {"session_path": str(session_path)},
    )

  with acquire_session_lock(session_path):
    client, me = await connect_client(session_path)
    try:
      chat_payload = None
      if args.chat:
        resolved = await client.get_entity(resolve_chat(args.chat))
        chat_payload = build_chat_payload(resolved)
      return emit(
        {
          "chat": chat_payload,
          "session_path": str(session_path),
          "user": build_user_payload(me),
        }
      )
    finally:
      await client.disconnect()


async def run_status(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  pending_auth = read_pending_auth_state(session_path)

  try:
    resolve_api_credentials()
  except Exception:
    return emit_auth_status(
      chat_payload = None,
      pending_auth = pending_auth,
      session_path = session_path,
      state = "missing_credentials",
      user_payload = None,
    )

  if session_path.exists():
    with acquire_session_lock(session_path):
      api_id, api_hash = resolve_api_credentials()
      client = create_telegram_client(
        session_path,
        api_id,
        api_hash,
        flood_sleep_threshold = 0,
      )
      try:
        await client.connect()
        if await client.is_user_authorized():
          clear_pending_auth_state(session_path)
          me = await client.get_me()
          chat_payload = None
          if args.chat:
            resolved = await client.get_entity(resolve_chat(args.chat))
            chat_payload = build_chat_payload(resolved)
          return emit_auth_status(
            chat_payload = chat_payload,
            pending_auth = None,
            session_path = session_path,
            state = "ready",
            user_payload = build_user_payload(me),
          )
      finally:
        await client.disconnect()

  if pending_auth is not None:
    pending_state = str(pending_auth.get("state") or "").strip()
    if is_valid_pending_auth_state(pending_state):
      return emit_auth_status(
        chat_payload = None,
        pending_auth = pending_auth,
        session_path = session_path,
        state = pending_state,
        user_payload = None,
      )

  if not session_path.exists():
    return emit_auth_status(
      chat_payload = None,
      pending_auth = None,
      session_path = session_path,
      state = "missing_session",
      user_payload = None,
    )

  return emit_auth_status(
    chat_payload = None,
    pending_auth = None,
    session_path = session_path,
    state = "needs_reauth",
    user_payload = None,
  )


async def run_login(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  phone = str(args.phone or "").strip()
  code = str(args.code or "").strip()
  password = read_login_password()
  if not phone:
    return fail("E_USAGE", "Telegram login requires --phone.")

  with acquire_session_lock(session_path):
    api_id, api_hash = resolve_api_credentials()
    client = create_telegram_client(
      session_path,
      api_id,
      api_hash,
      flood_sleep_threshold = 0,
    )
    try:
      await client.connect()
      if await client.is_user_authorized():
        clear_pending_auth_state(session_path)
        me = await client.get_me()
        return emit_auth_status(
          chat_payload = None,
          pending_auth = None,
          session_path = session_path,
          state = "ready",
          user_payload = build_user_payload(me),
        )

      pending_auth = read_pending_auth_state(session_path)
      pending_phone = str((pending_auth or {}).get("phone") or "").strip()
      pending_hash = str((pending_auth or {}).get("phone_code_hash") or "").strip()
      pending_state = str((pending_auth or {}).get("state") or "").strip()

      # Reusing the existing code hash avoids spamming fresh OTP sends while a
      # caller is still in the middle of the same login attempt.
      if (
        not code
        and not password
        and pending_auth is not None
        and pending_phone == phone
        and is_valid_pending_auth_state(pending_state)
      ):
        return emit_auth_status(
          chat_payload = None,
          pending_auth = pending_auth,
          session_path = session_path,
          state = pending_state,
          user_payload = None,
        )

      if not code and not password:
        stored = await refresh_pending_code_request(client, session_path, phone = phone)
        return emit_auth_status(
          chat_payload = None,
          pending_auth = stored,
          session_path = session_path,
          state = "awaiting_code",
          user_payload = None,
        )

      if not pending_hash or pending_phone != phone:
        return fail(
          "E_LOGIN_CODE_NOT_REQUESTED",
          "No pending Telegram login code was found for this phone. Start login without --code first.",
        )

      try:
        if password:
          await client.sign_in(password = password)
        else:
          await client.sign_in(phone = phone, code = code, phone_code_hash = pending_hash)
      except Exception as err:
        error_name = classify_login_error(err)
        if error_name == "SessionPasswordNeededError":
          stored = write_pending_auth_state(
            session_path,
            phone = phone,
            phone_code_hash = pending_hash,
            state = "awaiting_password",
          )
          return emit_auth_status(
            chat_payload = None,
            pending_auth = stored,
            session_path = session_path,
            state = "awaiting_password",
            user_payload = None,
          )
        if error_name in {
          "PhoneCodeEmptyError",
          "PhoneCodeExpiredError",
          "PhoneCodeHashEmptyError",
          "PhoneCodeHashExpiredError",
          "PhoneCodeInvalidError",
        }:
          stored = await refresh_pending_code_request(client, session_path, phone = phone)
          return emit_auth_status(
            chat_payload = None,
            pending_auth = stored,
            session_path = session_path,
            state = "awaiting_code",
            user_payload = None,
          )
        raise

      if not await client.is_user_authorized():
        return fail("E_UNAUTHORIZED_SESSION", "Telegram login completed without an authorized session.")

      clear_pending_auth_state(session_path)
      me = await client.get_me()
      return emit_auth_status(
        chat_payload = None,
        pending_auth = None,
        session_path = session_path,
        state = "ready",
        user_payload = build_user_payload(me),
      )
    finally:
      await client.disconnect()


async def run_send(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  with acquire_session_lock(session_path):
    client, _ = await connect_client(session_path)
    try:
      sent = await client.send_message(
        entity = resolve_chat(args.chat),
        message = args.message,
        reply_to = args.reply_to or None,
      )
      chat = await sent.get_chat()
      return emit({"message": build_message_payload(sent, chat = chat)})
    finally:
      await client.disconnect()


async def run_read(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  limit = max(1, min(int(args.limit or 20), 200))
  with acquire_session_lock(session_path):
    client, _ = await connect_client(session_path)
    try:
      messages = await client.get_messages(resolve_chat(args.chat), limit = limit)
      normalized = []
      for message in messages:
        message_id = int(getattr(message, "id", 0) or 0)
        if args.after_id and message_id <= args.after_id:
          continue
        if args.before_id and message_id >= args.before_id:
          continue
        normalized.append(build_message_payload(message))
      return emit({"messages": normalized})
    finally:
      await client.disconnect()


async def run_inbox(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  limit = max(1, min(int(args.limit or 20), 200))
  with acquire_session_lock(session_path):
    client, _ = await connect_client(session_path)
    try:
      dialogs = []
      scan_cap = compute_inbox_scan_cap(
        limit = limit,
        dm_only = bool(args.dm_only),
        unread_only = bool(args.unread),
      )
      # Keep the scan bounded, but do not assume the first few hundred dialogs are
      # representative once filters are applied client-side.
      async for dialog in client.iter_dialogs(limit = scan_cap, ignore_pinned = False):
        if not dialog_matches_inbox_filters(
          dialog,
          dm_only = bool(args.dm_only),
          unread_only = bool(args.unread),
        ):
          continue
        dialogs.append(build_dialog_payload(dialog))
        if len(dialogs) >= limit:
          break
      return emit({"dialogs": dialogs})
    finally:
      await client.disconnect()


async def run_logout(args: argparse.Namespace) -> int:
  session_path = resolve_session_path(args.session)
  with acquire_session_lock(session_path):
    removed_paths = clear_session_artifacts(session_path)
  return emit(
    {
      "cleared": len(removed_paths) > 0,
      "removed_paths": removed_paths,
      "session_path": str(session_path),
    }
  )


async def run() -> int:
  args = build_parser().parse_args()

  try:
    if args.command == "status":
      return await run_status(args)
    if args.command == "logout":
      return await run_logout(args)
    resolve_api_credentials()
    if args.command == "precheck":
      return await run_precheck(args)
    if args.command == "login":
      return await run_login(args)
    if args.command == "send":
      return await run_send(args)
    if args.command == "read":
      return await run_read(args)
    if args.command == "inbox":
      return await run_inbox(args)
    return fail("E_USAGE", f"Unsupported command: {args.command}")
  except TimeoutError as err:
    return fail("E_SESSION_LOCK_TIMEOUT", sanitize_error_text(str(err)))
  except PermissionError as err:
    return fail("E_UNAUTHORIZED_SESSION", sanitize_error_text(str(err)))
  except ValueError as err:
    return fail("E_USAGE", sanitize_error_text(str(err)))
  except Exception as err:  # pragma: no cover - script-level fallback
    return fail("E_TELEGRAM_USER_BACKEND", sanitize_error_text(str(err)))


def main() -> None:
  try:
    raise SystemExit(asyncio.run(run()))
  except KeyboardInterrupt:
    raise SystemExit(130) from None


if __name__ == "__main__":
  main()
