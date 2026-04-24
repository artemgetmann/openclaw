from __future__ import annotations

import json
import os
import pathlib
from collections.abc import Mapping

DEFAULT_FALLBACK_MODEL = "openai-codex/gpt-5.4"


def _normalize_model_value(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, Mapping):
        primary = value.get("primary")
        if isinstance(primary, str):
            return primary.strip()
    return ""


def resolve_default_model(
    *,
    config_path: str | os.PathLike[str] | None = None,
    fallback_model: str = DEFAULT_FALLBACK_MODEL,
) -> str:
    resolved_path = (
        pathlib.Path(config_path).expanduser()
        if config_path
        else pathlib.Path(
            os.environ.get("OPENCLAW_CONFIG_PATH") or pathlib.Path.home() / ".openclaw" / "openclaw.json"
        )
    )

    try:
        raw = resolved_path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except Exception:
        return fallback_model

    if not isinstance(parsed, Mapping):
        return fallback_model

    agents = parsed.get("agents")
    if not isinstance(agents, Mapping):
        return fallback_model

    defaults = agents.get("defaults")
    if not isinstance(defaults, Mapping):
        return fallback_model

    model = _normalize_model_value(defaults.get("model"))
    return model or fallback_model
