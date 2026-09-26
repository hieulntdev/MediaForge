"""Application settings used by the Python backend."""

import json

from src.utils.paths import LEGACY_SETTINGS_FILE, SETTINGS_FILE, ensure_dirs

DEFAULT_SETTINGS = {
    "video_quality": "Maximum Accessible",
    "audio_quality": "Maximum Accessible",
    "codec": "Auto / Maximum Quality",
    "container": "Auto",
    "download_subtitle": True,
    "subtitle_format": "srt",
    "concurrent_fragments": 4,
    "retry": 5,
    "delete_temp": True,
    "ratelimit": 0,
}


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
