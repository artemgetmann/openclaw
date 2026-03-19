#!/usr/bin/env python3
"""
Shared guard helpers for Telegram MTProto userbot scripts.

These helpers keep live checks deterministic by:
1) sanitizing errors without leaking secrets,
2) enforcing a single owner for the Telethon sqlite session, and
3) loading simple env-style files without requiring shell sourcing.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import re
import subprocess
import sys
from pathlib import Path


class SessionGuardError(RuntimeError):
  """Raised when the Telethon session cannot be used safely."""


def load_env_file(path: Path) -> dict[str, str]:
  data: dict[str, str] = {}
  if not path.exists():
    return data
  for raw_line in path.read_text().splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
      continue
    key, value = line.split("=", 1)
    data[key] = value
  return data


def sanitize_error_text(raw: str) -> str:
  text = raw.replace("\n", " ").replace("\r", " ").strip()
  for secret in (
    os.environ.get("TELEGRAM_API_HASH", ""),
    os.environ.get("TG_BOT_TOKEN", ""),
    os.environ.get("TELEGRAM_BOT_TOKEN", ""),
  ):
    if secret:
      text = text.replace(secret, "<redacted>")
  text = re.sub(r"\s+", " ", text).strip()
  if not text:
    return "unexpected error"
  return text[:240]


def _list_session_holder_pids(session_path: Path) -> list[int]:
  holders: set[int] = set()
  for candidate in (session_path, Path(f"{session_path}-journal")):
    try:
      proc = subprocess.run(
        ["lsof", "-t", str(candidate)],
        check=False,
        capture_output=True,
        text=True,
      )
    except FileNotFoundError:
      continue
    if proc.returncode not in (0, 1):
      continue
    for raw_pid in proc.stdout.splitlines():
      raw_pid = raw_pid.strip()
      if raw_pid.isdigit():
        holders.add(int(raw_pid))
  return sorted(holders)


@contextlib.contextmanager
def acquire_session_guard(session_path: Path):
  """
  Fail fast when another process is already using the Telethon session.

  We use both:
  - a dedicated `.lock` file for cooperative locking across our scripts, and
  - an `lsof` check on sqlite files to catch stale/parallel Telethon owners.
  """
  session_path = session_path.expanduser()
  session_path.parent.mkdir(parents=True, exist_ok=True)
  lock_path = Path(f"{session_path}.lock")
  lock_fd = open(lock_path, "a+", encoding="utf-8")
  try:
    try:
      fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as err:
      raise SessionGuardError(
        f"userbot session lock busy: {lock_path.name}. Another Telegram E2E script is already running."
      ) from err

    holder_pids = [pid for pid in _list_session_holder_pids(session_path) if pid != os.getpid()]
    if holder_pids:
      raise SessionGuardError(
        "userbot session already open by another process: "
        + ", ".join(str(pid) for pid in holder_pids)
      )

    lock_fd.seek(0)
    lock_fd.truncate()
    lock_fd.write(f"pid={os.getpid()}\nscript={Path(sys.argv[0]).name}\n")
    lock_fd.flush()
    yield
  finally:
    try:
      fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
    finally:
      lock_fd.close()
