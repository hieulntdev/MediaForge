import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend_entry import (
    _account_status,
    _normalize_codec,
    _normalize_container,
    _project,
)
from src import settings
from src.auth.account import AccountInfo
from src.core.analyzer import DownloadItem
from src.models.format_info import FormatInfo
from src.models.video_info import VideoInfo


def _item() -> DownloadItem:
    video = FormatInfo(format_id="16", kind="video", ext="m4s", height=1080, vcodec="avc1")
    audio = FormatInfo(format_id="30280", kind="audio", ext="m4s", acodec="mp4a")
    info = VideoInfo(
        url="https://www.bilibili.com/video/BV1234567890",
        bvid="BV1234567890", title="Test Video", uploader="Uploader",
        duration=120.0, thumbnail_url="", view_count=12345, upload_date="20260917",
    )
    return DownloadItem(
        index=1, bvid="BV1234567890", cid=123, title="Test Video",
        video=video, audio=audio, container="mp4",
        output_path=Path("/tmp/out.mp4"), video_info=info,
    )


def test_normalize_codec_maps_display_labels():
    assert _normalize_codec("Auto / Maximum Quality") == "auto"
    assert _normalize_codec("AVC") == "avc"
    assert _normalize_codec("HEVC") == "hevc"
    assert _normalize_codec("AV1") == "av1"


def test_normalize_container_maps_display_labels():
    assert _normalize_container("Auto") == "auto"
    assert _normalize_container("MP4") == "mp4"
    assert _normalize_container("MKV") == "mkv"


def test_account_status_valid():
    assert _account_status(AccountInfo(True, "alice", False, True, "Logged in")) == "valid"


def test_account_status_invalid():
    assert _account_status(AccountInfo(False, None, False, True, "Not logged in")) == "invalid"


def test_account_status_expired():
    info = AccountInfo(False, None, False, False, "Cookie expired. Please refresh.")
    assert _account_status(info) == "expired"


def test_account_status_error():
    info = AccountInfo(False, None, False, False, "Check Account failed (network error).")
    assert _account_status(info) == "error"


def test_project_returns_display_projection():
    p = _project(_item(), 3)
    assert p == {
        "row": 3, "id": 1, "title": "Test Video", "uploader": "Uploader",
        "duration": 120.0, "views": 12345, "date": "2026-09-17",
        "url": "https://www.bilibili.com/video/BV1234567890",
        "output_path": "/tmp/out.mp4",
    }


def test_settings_round_trip_and_merge_defaults(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr(settings, "SETTINGS_FILE", settings_file)
    monkeypatch.setattr(settings, "ensure_dirs", lambda: None)

    settings.save_settings({"codec": "HEVC"})

    assert json.loads(settings_file.read_text()) == {"codec": "HEVC"}
    loaded = settings.load_settings()
    assert loaded["codec"] == "HEVC"
    assert loaded["container"] == settings.DEFAULT_SETTINGS["container"]


def test_settings_invalid_json_falls_back_to_defaults(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    settings_file.write_text("not json")
    monkeypatch.setattr(settings, "SETTINGS_FILE", settings_file)
    monkeypatch.setattr(settings, "ensure_dirs", lambda: None)

    assert settings.load_settings() == settings.DEFAULT_SETTINGS
