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
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

try:
  import fcntl
except Exception:  # pragma: no cover - Windows fallback
  fcntl = None

try:
  import msvcrt
except Exception:  # pragma: no cover - POSIX fallback
  msvcrt = None

from telethon import TelegramClient


DEFAULT_SESSION = Path(__file__).resolve().parent / "tmp" / "userbot.session"
DEFAULT_LOCK_TIMEOUT_SECONDS = 15


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


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description = "Telethon transport for OpenClaw Telegram user tooling")
  parser.add_argument("--session", help = "Telethon session path override")
  subparsers = parser.add_subparsers(dest = "command", required = True)

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
  return parser


async def connect_client(session_path: Path) -> tuple[TelegramClient, object]:
  api_id, api_hash = resolve_api_credentials()
  client = TelegramClient(str(session_path), api_id, api_hash, flood_sleep_threshold = 0)
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
          "user": {
            "first_name": getattr(me, "first_name", None),
            "user_id": int(getattr(me, "id", 0) or 0),
            "username": getattr(me, "username", None),
          },
        }
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


async def run() -> int:
  args = build_parser().parse_args()
  try:
    resolve_api_credentials()
  except Exception as err:
    return fail("E_MISSING_CREDS", sanitize_error_text(str(err)))

  try:
    if args.command == "precheck":
      return await run_precheck(args)
    if args.command == "send":
      return await run_send(args)
    if args.command == "read":
      return await run_read(args)
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
