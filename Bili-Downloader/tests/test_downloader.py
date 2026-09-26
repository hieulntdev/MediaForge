import threading
from pathlib import Path
from types import SimpleNamespace

import yt_dlp

from src.core.downloader import backoff_delays, download


def test_backoff_sequence():
    assert backoff_delays() == [1, 2, 4, 8, 16]


class _RecordingYDL:
    """Stands in for yt_dlp.YoutubeDL so we can inspect the options it is given."""

    captured: dict = {}

    def __init__(self, opts):
        _RecordingYDL.captured = opts

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def download(self, urls):
        return 0


def _capture_opts(settings, monkeypatch) -> dict:
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _RecordingYDL)
    opts = SimpleNamespace(cookies_file=None, cookies_from_browser=None)
    download("https://example.com/v", "1", Path("/tmp/bili-test.mp4"), opts=opts,
             progress_cb=lambda d: None,
             pause_event=threading.Event(), cancel_event=threading.Event(),
             settings=settings)
    return _RecordingYDL.captured


def test_zero_ratelimit_becomes_none(monkeypatch):
    """0 means "unlimited" in settings; yt-dlp divides by ratelimit, so it wants None."""
    assert _capture_opts({"ratelimit": 0}, monkeypatch)["ratelimit"] is None


def test_missing_ratelimit_becomes_none(monkeypatch):
    assert _capture_opts({}, monkeypatch)["ratelimit"] is None


def test_positive_ratelimit_is_passed_through(monkeypatch):
    assert _capture_opts({"ratelimit": 1_000_000}, monkeypatch)["ratelimit"] == 1_000_000
