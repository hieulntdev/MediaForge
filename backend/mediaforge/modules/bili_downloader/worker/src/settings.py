"""Application settings used by the Python backend."""

import json
from pathlib import Path

from src.utils.paths import LEGACY_SETTINGS_FILE, SETTINGS_FILE, ensure_dirs

DEFAULTS_FILE = Path(__file__).resolve().parents[2] / "defaults.json"
DEFAULT_SETTINGS = json.loads(DEFAULTS_FILE.read_text(encoding="utf-8"))


def load_settings() -> dict:
    ensure_dirs()
    source = SETTINGS_FILE if SETTINGS_FILE.exists() else LEGACY_SETTINGS_FILE
    if source.exists():
        try:
            data = json.loads(source.read_text())
            if source != SETTINGS_FILE:
                # Non-destructive migration: copy validated JSON into the new
                # MediaForge namespace and leave the legacy file untouched.
                SETTINGS_FILE.write_text(json.dumps(data, indent=2))
            return {**DEFAULT_SETTINGS, **data}
        except (json.JSONDecodeError, OSError):
            pass
    return dict(DEFAULT_SETTINGS)


def save_settings(settings: dict) -> None:
    ensure_dirs()
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
