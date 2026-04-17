from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
  sys.path.insert(0, str(SCRIPT_DIR))

from telethon_compat import LEGACY_SESSION_COLUMNS, SUPPORTED_SESSION_COLUMNS, prepare_session_for_telethon


def write_session_db(path: Path, *, include_tmp_auth_key: bool) -> None:
  connection = sqlite3.connect(path)
  try:
    with connection:
      if include_tmp_auth_key:
        connection.execute(
          """
          CREATE TABLE sessions (
            dc_id integer primary key,
            server_address text,
            port integer,
            auth_key blob,
            takeout_id integer,
            tmp_auth_key blob
          )
          """
        )
        connection.execute(
          """
          INSERT INTO sessions (dc_id, server_address, port, auth_key, takeout_id, tmp_auth_key)
          VALUES (2, '149.154.167.50', 443, X'0102', 99, X'0304')
          """
        )
        return

      connection.execute(
        """
        CREATE TABLE sessions (
          dc_id integer primary key,
          server_address text,
          port integer,
          auth_key blob,
          takeout_id integer
        )
        """
      )
      connection.execute(
        """
        INSERT INTO sessions (dc_id, server_address, port, auth_key, takeout_id)
        VALUES (2, '149.154.167.50', 443, X'0102', 99)
        """
      )
  finally:
    connection.close()


def session_columns(path: Path) -> list[str]:
  connection = sqlite3.connect(path)
  try:
    rows = connection.execute("PRAGMA table_info(sessions)").fetchall()
  finally:
    connection.close()
  return [str(row[1]) for row in rows]


def session_row(path: Path) -> tuple[object, ...]:
  connection = sqlite3.connect(path)
  try:
    row = connection.execute("SELECT * FROM sessions").fetchone()
  finally:
    connection.close()
  assert row is not None
  return tuple(row)


class TelethonCompatTests(unittest.TestCase):
  def test_prepare_session_for_telethon_expands_legacy_session(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      original_path = Path(temp_dir) / "userbot.session"
      write_session_db(original_path, include_tmp_auth_key = False)

      compat_path, compat_dir = prepare_session_for_telethon(
        original_path,
        target_columns = SUPPORTED_SESSION_COLUMNS,
      )
      try:
        self.assertIsNotNone(compat_dir)
        self.assertNotEqual(compat_path, original_path)
        self.assertEqual(session_columns(compat_path), list(SUPPORTED_SESSION_COLUMNS))
        self.assertEqual(session_row(compat_path), (2, "149.154.167.50", 443, b"\x01\x02", 99, None))
      finally:
        if compat_dir is not None:
          compat_dir.cleanup()

      self.assertEqual(
        session_columns(original_path),
        ["dc_id", "server_address", "port", "auth_key", "takeout_id"],
      )

  def test_prepare_session_for_telethon_reuses_supported_session(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      original_path = Path(temp_dir) / "userbot.session"
      write_session_db(original_path, include_tmp_auth_key = True)

      compat_path, compat_dir = prepare_session_for_telethon(
        original_path,
        target_columns = SUPPORTED_SESSION_COLUMNS,
      )
      try:
        self.assertIsNotNone(compat_dir)
        self.assertNotEqual(compat_path, original_path)
        self.assertEqual(session_columns(compat_path), list(SUPPORTED_SESSION_COLUMNS))
      finally:
        if compat_dir is not None:
          compat_dir.cleanup()

  def test_prepare_session_for_telethon_skips_missing_session(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      missing_path = Path(temp_dir) / "missing.session"
      compat_path, compat_dir = prepare_session_for_telethon(
        missing_path,
        target_columns = SUPPORTED_SESSION_COLUMNS,
      )
      self.assertEqual(compat_path, missing_path)
      self.assertIsNone(compat_dir)

  def test_prepare_session_for_telethon_rewrites_newer_session_for_legacy_target(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      original_path = Path(temp_dir) / "userbot.session"
      write_session_db(original_path, include_tmp_auth_key = True)

      compat_path, compat_dir = prepare_session_for_telethon(
        original_path,
        target_columns = LEGACY_SESSION_COLUMNS,
      )
      try:
        self.assertIsNotNone(compat_dir)
        self.assertNotEqual(compat_path, original_path)
        self.assertEqual(session_columns(compat_path), list(LEGACY_SESSION_COLUMNS))
        self.assertEqual(session_row(compat_path), (2, "149.154.167.50", 443, b"\x01\x02", 99))
      finally:
        if compat_dir is not None:
          compat_dir.cleanup()


if __name__ == "__main__":
  unittest.main()
