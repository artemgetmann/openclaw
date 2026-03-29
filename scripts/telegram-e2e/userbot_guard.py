from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from telethon_cli import acquire_session_lock, sanitize_error_text


class SessionGuardError(RuntimeError):
  """Surface session-lock failures to probes with a stable error type."""


def load_env_file(path: Path) -> dict[str, str]:
  values: dict[str, str] = {}
  if not path.is_file():
    return values

  for raw_line in path.read_text(encoding = "utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#"):
      continue
    if line.startswith("export "):
      line = line[len("export "):].strip()
    if "=" not in line:
      continue
    key, value = line.split("=", 1)
    key = key.strip()
    value = value.strip().strip('"').strip("'")
    if key:
      values[key] = value
  return values


@contextmanager
def acquire_session_guard(session_path: Path):
  try:
    with acquire_session_lock(session_path):
      yield
  except TimeoutError as err:
    raise SessionGuardError(str(err)) from err
  except OSError as err:
    raise SessionGuardError(sanitize_error_text(str(err))) from err
