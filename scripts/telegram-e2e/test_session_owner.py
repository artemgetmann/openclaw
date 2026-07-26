from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
  sys.path.insert(0, str(SCRIPT_DIR))

import session_owner


def create_session(path: Path, *, auth_key: bytes, marker: str = "") -> None:
  """Create the minimum real Telethon SQLite shape used by offline migration."""

  path.parent.mkdir(parents=True, exist_ok=True)
  connection = sqlite3.connect(path)
  try:
    connection.execute("CREATE TABLE sessions (dc_id INTEGER PRIMARY KEY, auth_key BLOB)")
    connection.execute("INSERT INTO sessions (dc_id, auth_key) VALUES (?, ?)", (2, auth_key))
    connection.execute("CREATE TABLE fixture_metadata (marker TEXT)")
    connection.execute("INSERT INTO fixture_metadata (marker) VALUES (?)", (marker,))
    connection.commit()
  finally:
    connection.close()


class SessionOwnerTests(unittest.TestCase):
  def test_collapses_identical_legacy_copies_by_reference(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      create_session(machine, auth_key=b"same-authorization", marker="machine-copy")
      create_session(jarvis, auth_key=b"same-authorization", marker="jarvis-copy")

      source, selected, migration = session_owner.resolve_owner(
        candidates=[("machine", machine), ("jarvis-state-legacy", jarvis)],
        default_session=machine,
        selector_path=selector,
      )

      resolved_machine = Path(os.path.realpath(machine))
      self.assertEqual(source, "machine")
      self.assertEqual(selected, resolved_machine)
      self.assertEqual(migration, "duplicates-collapsed")
      self.assertEqual(selector.read_text(encoding="utf-8"), f"{resolved_machine}\n")
      self.assertEqual(stat.S_IMODE(selector.stat().st_mode), 0o600)
      self.assertEqual(stat.S_IMODE(selector.parent.stat().st_mode), 0o700)

  def test_fails_closed_with_one_precise_claim_per_divergent_source(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      create_session(machine, auth_key=b"machine-account")
      create_session(jarvis, auth_key=b"jarvis-account")

      with self.assertRaisesRegex(
        session_owner.SessionOwnerError,
        r"owner claim --source machine.*owner claim --source jarvis-state-legacy",
      ):
        session_owner.resolve_owner(
          candidates=[("machine", machine), ("jarvis-state-legacy", jarvis)],
          default_session=machine,
          selector_path=selector,
        )

      self.assertFalse(selector.exists())

  def test_existing_machine_selector_survives_restart_and_new_legacy_files(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      create_session(machine, auth_key=b"different-account")
      create_session(jarvis, auth_key=b"chosen-account")
      session_owner.atomic_write_selector(selector, jarvis)

      source, selected, migration = session_owner.resolve_owner(
        candidates=[("machine", machine), ("jarvis-state-legacy", jarvis)],
        default_session=machine,
        selector_path=selector,
      )

      self.assertEqual((source, selected, migration), ("machine-selector", jarvis, "existing"))

  def test_recovers_when_previous_owner_target_was_deleted(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      deleted = root / "deleted-worktree" / "userbot.session"
      jarvis = root / "jarvis.session"
      create_session(jarvis, auth_key=b"stable-account")
      session_owner.atomic_write_selector(selector, deleted)

      source, selected, migration = session_owner.resolve_owner(
        candidates=[("jarvis-state-legacy", jarvis)],
        default_session=root / "machine.session",
        selector_path=selector,
      )

      resolved_jarvis = Path(os.path.realpath(jarvis))
      self.assertEqual(
        (source, selected, migration),
        ("jarvis-state-legacy", resolved_jarvis, "stale-recovered"),
      )
      self.assertEqual(selector.read_text(encoding="utf-8"), f"{resolved_jarvis}\n")

  def test_equal_corrupt_candidates_remain_ambiguous(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      machine = root / "machine.session"
      jarvis = root / "jarvis.session"
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      machine.write_bytes(b"not-a-telegram-session")
      jarvis.write_bytes(b"not-a-telegram-session")

      with self.assertRaisesRegex(session_owner.SessionOwnerError, "E_AMBIGUOUS_SESSION"):
        session_owner.resolve_owner(
          candidates=[("machine", machine), ("jarvis-state-legacy", jarvis)],
          default_session=machine,
          selector_path=selector,
        )

      self.assertFalse(selector.exists())

  def test_atomic_failure_preserves_previous_owner(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      previous = root / "previous.session"
      replacement = root / "replacement.session"
      session_owner.atomic_write_selector(selector, previous)

      with (
        patch.object(Path, "write_text", side_effect=OSError("disk full")),
        self.assertRaises(OSError),
      ):
        session_owner.atomic_write_selector(selector, replacement)

      self.assertEqual(selector.read_text(encoding="utf-8"), f"{previous}\n")

  @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX fork")
  def test_concurrent_publish_leaves_one_complete_reference(self) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
      root = Path(temp_dir)
      selector = root / "owner" / session_owner.SELECTOR_FILENAME
      first = root / "first.session"
      second = root / "second.session"
      children = []
      for selected in (first, second):
        pid = os.fork()
        if pid == 0:
          session_owner.atomic_write_selector(selector, selected)
          os._exit(0)
        children.append(pid)
      for pid in children:
        _, status_code = os.waitpid(pid, 0)
        self.assertEqual(status_code, 0)

      self.assertIn(selector.read_text(encoding="utf-8"), {f"{first}\n", f"{second}\n"})


if __name__ == "__main__":
  unittest.main()
