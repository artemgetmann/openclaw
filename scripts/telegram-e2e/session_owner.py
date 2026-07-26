#!/usr/bin/env python3
"""Machine-wide Telegram user-session ownership without credential movement.

This module deliberately uses only the Python standard library so worktree
bootstrap can run before the Telethon virtualenv exists. Online authorization
checks live in ``telethon_cli.py``; this file owns candidate discovery results,
offline duplicate detection, and atomic selector persistence.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import sqlite3
import sys
import time
from typing import Iterable

try:
  import fcntl
except ImportError:  # pragma: no cover - Windows only
  fcntl = None

try:
  import msvcrt
except ImportError:  # pragma: no cover - POSIX only
  msvcrt = None


SELECTOR_FILENAME = "canonical-session.path"
DEFAULT_LOCK_TIMEOUT_SECONDS = 30
SOURCE_PATTERN = frozenset(
  {
    "machine",
    "jarvis-state-legacy",
    "lane-legacy",
    "machine-selector",
    "main-canonical-legacy",
    "main-legacy",
    "state-legacy",
  }
)


class SessionOwnerError(RuntimeError):
  """A safe, operator-facing ownership failure."""


def validate_absolute_path(raw: str, *, context: str) -> Path:
  if not raw or any(ord(character) <= 31 or ord(character) == 127 for character in raw):
    raise SessionOwnerError(f"E_INVALID_SESSION_SELECTOR: {context} contains invalid text.")
  selected = Path(raw).expanduser()
  if not selected.is_absolute():
    raise SessionOwnerError(f"E_INVALID_SESSION_SELECTOR: {context} must be absolute.")
  return Path(os.path.abspath(selected))


def parse_candidate(raw: str) -> tuple[str, Path]:
  source, separator, candidate = raw.partition("=")
  if separator != "=" or source not in SOURCE_PATTERN:
    raise SessionOwnerError("E_INVALID_SESSION_CANDIDATE: expected a recognized source and path.")
  return source, validate_absolute_path(candidate, context=f"{source} session candidate")


def dedupe_candidates(candidates: Iterable[tuple[str, Path]]) -> list[tuple[str, Path]]:
  """Preserve priority while folding labels that resolve to one physical path."""

  unique: dict[str, tuple[str, Path]] = {}
  for source, candidate in candidates:
    if not candidate.is_file():
      continue
    key = os.path.realpath(candidate)
    existing = unique.get(key)
    if existing is None:
      unique[key] = (source, Path(key))
      continue
    unique[key] = (f"{existing[0]}+{source}", existing[1])
  return list(unique.values())


def read_selector(selector_path: Path) -> Path | None:
  if not selector_path.exists():
    return None
  if not selector_path.is_file():
    raise SessionOwnerError("E_INVALID_SESSION_SELECTOR: machine owner selector is not a file.")
  try:
    selected = selector_path.read_text(encoding="utf-8").strip()
  except OSError as error:
    raise SessionOwnerError("E_INVALID_SESSION_SELECTOR: machine owner selector is unreadable.") from error
  return validate_absolute_path(selected, context="machine owner selector")


def atomic_write_selector(selector_path: Path, session_path: Path) -> None:
  """Publish one reference without ever touching the referenced database."""

  selector_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
  try:
    os.chmod(selector_path.parent, 0o700)
  except OSError:
    pass
  temporary = selector_path.with_name(f".{selector_path.name}.{os.getpid()}.tmp")
  try:
    temporary.write_text(f"{session_path}\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, selector_path)
  finally:
    try:
      temporary.unlink()
    except FileNotFoundError:
      pass


@contextmanager
def acquire_machine_lock(lock_path: Path, *, timeout_seconds: int):
  """Serialize bootstrap and online claims through the shared user-session lock."""

  lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
  try:
    os.chmod(lock_path.parent, 0o700)
  except OSError:
    pass
  deadline = time.time() + max(1, timeout_seconds)
  with lock_path.open("a+", encoding="utf-8") as handle:
    try:
      os.chmod(lock_path, 0o600)
    except OSError:
      pass
    while True:
      try:
        if fcntl is not None:
          fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt is not None:  # pragma: no cover - Windows only
          msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        break
      except OSError:
        if time.time() >= deadline:
          raise SessionOwnerError(
            "E_SESSION_LOCK_TIMEOUT: timed out waiting for the machine Telegram session lock."
          ) from None
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


def _sqlite_authorization_fingerprint(session_path: Path) -> bytes | None:
  """Hash Telegram authorization material internally; never return raw keys."""

  try:
    connection = sqlite3.connect(f"file:{session_path}?mode=ro", uri=True)
    try:
      rows = connection.execute(
        "SELECT dc_id, auth_key FROM sessions ORDER BY dc_id"
      ).fetchall()
    finally:
      connection.close()
  except (OSError, sqlite3.Error):
    return None
  normalized = []
  for dc_id, auth_key in rows:
    if not isinstance(auth_key, bytes) or not auth_key:
      return None
    normalized.append(str(int(dc_id)).encode("ascii") + b":" + auth_key)
  if not normalized:
    return None
  return hashlib.sha256(b"\0".join(normalized)).digest()


def offline_session_fingerprint(session_path: Path) -> bytes | None:
  """Recognize Telethon sessions only when their authorization row is readable."""

  sqlite_fingerprint = _sqlite_authorization_fingerprint(session_path)
  if sqlite_fingerprint is not None:
    return b"sqlite:" + sqlite_fingerprint
  # Equal opaque bytes do not prove that a candidate is a valid or authorized
  # Telethon database. Corrupt and unknown formats must reach the online claim
  # flow instead of being silently certified as duplicate credentials.
  return None


def resolve_owner(
  *,
  candidates: list[tuple[str, Path]],
  default_session: Path,
  selector_path: Path,
) -> tuple[str, Path, str]:
  """Resolve or migrate one owner using only evidence safe before networking."""

  selected = read_selector(selector_path)
  if selected is not None and selected.is_file():
    return "machine-selector", selected, "existing"

  existing = dedupe_candidates(candidates)
  recovering_stale_selector = selected is not None
  if not existing:
    atomic_write_selector(selector_path, default_session)
    migration = "stale-reinitialized" if recovering_stale_selector else "initialized"
    return "machine-default", default_session, migration
  if len(existing) == 1:
    source, session_path = existing[0]
    atomic_write_selector(selector_path, session_path)
    migration = "stale-recovered" if recovering_stale_selector else "adopted"
    return source.split("+")[0], session_path, migration

  fingerprints = [offline_session_fingerprint(session_path) for _, session_path in existing]
  first = fingerprints[0]
  if first is not None and all(fingerprint == first for fingerprint in fingerprints[1:]):
    source, session_path = existing[0]
    atomic_write_selector(selector_path, session_path)
    return source.split("+")[0], session_path, "duplicates-collapsed"

  sources = ",".join(source for source, _ in existing)
  actions = " or ".join(
    f"openclaw telegram-user owner claim --source {source.split('+')[0]}"
    for source, _ in existing
  )
  raise SessionOwnerError(
    "E_AMBIGUOUS_SESSION: divergent implicit Telegram session owners exist "
    f"({sources}). Verify the active account once with: {actions}"
  )


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description="Resolve one machine Telegram user-session owner")
  parser.add_argument("--selector", required=True, help="Machine-wide owner selector path")
  parser.add_argument("--lock", help="Machine-wide owner lock path")
  parser.add_argument(
    "--lock-timeout",
    type=int,
    default=DEFAULT_LOCK_TIMEOUT_SECONDS,
    help="Seconds to wait for machine-wide ownership lock",
  )
  parser.add_argument("--default-session", required=True, help="Default machine session path")
  parser.add_argument(
    "--candidate",
    action="append",
    default=[],
    help="Recognized source=absolute-path candidate in priority order",
  )
  return parser


def main() -> None:
  args = build_parser().parse_args()
  try:
    selector = validate_absolute_path(args.selector, context="machine owner selector")
    lock_path = validate_absolute_path(
      args.lock or str(selector.with_name("userbot.session.openclaw.lock")),
      context="machine owner lock",
    )
    default_session = validate_absolute_path(args.default_session, context="default session")
    candidates = [parse_candidate(raw) for raw in args.candidate]
    with acquire_machine_lock(lock_path, timeout_seconds=args.lock_timeout):
      source, session_path, migration = resolve_owner(
        candidates=candidates,
        default_session=default_session,
        selector_path=selector,
      )
    # Bootstrap needs the selected path and non-secret classification. Rejecting
    # control characters above keeps this tab-delimited transport unambiguous.
    sys.stdout.write(f"{source}\t{migration}\t{session_path}\n")
  except SessionOwnerError as error:
    sys.stderr.write(f"{error}\n")
    raise SystemExit(1) from None


if __name__ == "__main__":
  main()
