#!/usr/bin/env python3
"""
Shared Telethon compatibility helpers for Telegram userbot scripts.

Telethon session schemas drifted over time: some builds use a five-column
`sessions` table, newer ones add `tmp_auth_key`, and real user sessions can be
copied across environments. We normalize only a throwaway copy so the original
secret session file stays untouched while both schema variants remain usable.
"""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path
from typing import Any


LEGACY_SESSION_COLUMNS = (
  "dc_id",
  "server_address",
  "port",
  "auth_key",
  "takeout_id",
)
SUPPORTED_SESSION_COLUMNS = LEGACY_SESSION_COLUMNS + (
  "tmp_auth_key",
)


def _read_session_columns(session_path: Path) -> tuple[str, ...] | None:
  if not session_path.exists() or not session_path.is_file():
    return None

  try:
    connection = sqlite3.connect(f"file:{session_path}?mode=ro", uri = True)
  except sqlite3.Error:
    return None

  try:
    rows = connection.execute("PRAGMA table_info(sessions)").fetchall()
  except sqlite3.Error:
    return None
  finally:
    connection.close()

  if not rows:
    return None
  return tuple(str(row[1]) for row in rows)


def _needs_compat_copy(columns: tuple[str, ...] | None) -> bool:
  if not columns:
    return False
  return set(LEGACY_SESSION_COLUMNS).issubset(columns) and set(columns).issubset(SUPPORTED_SESSION_COLUMNS)


def _copy_session_database(source_path: Path, destination_path: Path) -> None:
  destination_path.parent.mkdir(parents = True, exist_ok = True)
  source = sqlite3.connect(f"file:{source_path}?mode=ro", uri = True)
  destination = sqlite3.connect(destination_path)
  try:
    # SQLite backup folds in committed WAL state without opening the original
    # session for writes or relying on sidecar file copies.
    source.backup(destination)
  finally:
    destination.close()
    source.close()


def _rewrite_sessions_table(
  session_path: Path,
  *,
  source_columns: tuple[str, ...],
  target_columns: tuple[str, ...],
) -> None:
  select_columns = ", ".join(
    column if column in source_columns else f"NULL AS {column}"
    for column in target_columns
  )
  table_columns = ",\n          ".join(
    {
      "dc_id": "dc_id integer primary key",
      "server_address": "server_address text",
      "port": "port integer",
      "auth_key": "auth_key blob",
      "takeout_id": "takeout_id integer",
      "tmp_auth_key": "tmp_auth_key blob",
    }[column]
    for column in target_columns
  )
  insert_columns = ",\n          ".join(target_columns)
  connection = sqlite3.connect(session_path)
  try:
    with connection:
      connection.execute("ALTER TABLE sessions RENAME TO sessions_legacy")
      connection.execute(
        """
        CREATE TABLE sessions (
          {}
        )
        """.format(table_columns)
      )
      connection.execute(
        """
        INSERT INTO sessions (
          {}
        )
        SELECT
        """
        .format(insert_columns)
        + select_columns
        + "\nFROM sessions_legacy"
      )
      connection.execute("DROP TABLE sessions_legacy")
  finally:
    connection.close()


def detect_expected_session_columns(telethon: Any) -> tuple[str, ...]:
  current_version = int(getattr(telethon.sessions.sqlite, "CURRENT_VERSION", 0) or 0)
  if current_version >= 8:
    return SUPPORTED_SESSION_COLUMNS
  return LEGACY_SESSION_COLUMNS


def prepare_session_for_telethon(
  session_path: str | Path,
  *,
  target_columns: tuple[str, ...],
) -> tuple[Path, tempfile.TemporaryDirectory[str] | None]:
  normalized_path = Path(session_path).expanduser()
  if not normalized_path.exists() or not normalized_path.is_file():
    return normalized_path, None

  columns = _read_session_columns(normalized_path)

  temp_dir = tempfile.TemporaryDirectory(
    dir = normalized_path.parent,
    prefix = f".{normalized_path.stem}.telethon-compat-",
  )
  compat_path = Path(temp_dir.name) / normalized_path.name
  try:
    _copy_session_database(normalized_path, compat_path)
    if _needs_compat_copy(columns) and tuple(columns or ()) != target_columns:
      _rewrite_sessions_table(
        compat_path,
        source_columns = columns,
        target_columns = target_columns,
      )
  except Exception:
    temp_dir.cleanup()
    raise
  return compat_path, temp_dir


def create_telegram_client(
  session_path: str | Path,
  api_id: int,
  api_hash: str,
  **kwargs: Any,
):
  try:
    import telethon  # type: ignore
  except Exception as err:  # pragma: no cover - passthrough for missing package
    raise RuntimeError(f"Telethon import failed: {err}") from err

  prepared_path, temp_dir = prepare_session_for_telethon(
    session_path,
    target_columns = detect_expected_session_columns(telethon),
  )
  try:
    client = telethon.TelegramClient(str(prepared_path), api_id, api_hash, **kwargs)
  except Exception:
    if temp_dir is not None:
      temp_dir.cleanup()
    raise

  if temp_dir is None:
    return client

  original_disconnect = client.disconnect

  async def disconnect_with_cleanup(*args: Any, **inner_kwargs: Any):
    try:
      return await original_disconnect(*args, **inner_kwargs)
    finally:
      temp_dir.cleanup()

  client.disconnect = disconnect_with_cleanup
  client._openclaw_compat_session_path = str(prepared_path)
  return client
