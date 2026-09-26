import threading
from pathlib import Path

from src.utils.logger import get_logger

log = get_logger()


class DownloadError(Exception):
    pass


class DownloadCancelled(Exception):
    pass


def backoff_delays(retries: int = 5) -> list[int]:
    return [2 ** i for i in range(retries)]  # 1, 2, 4, 8, 16


def download(url: str, format_id: str, dest: Path, *, opts, progress_cb,
             pause_event: threading.Event, cancel_event: threading.Event,
             settings: dict) -> None:
    import yt_dlp

    dest.parent.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if cancel_event.is_set():
            raise DownloadCancelled()
        while pause_event.is_set():
            if cancel_event.is_set():
                raise DownloadCancelled()
            pause_event.wait(0.1)
        progress_cb(d)

    ydl_opts = {
        "format": format_id,
        "outtmpl": str(dest),
        "continuedl": True,
        "nopart": False,
        "retries": settings.get("retry", 5),
        "fragment_retries": settings.get("retry", 5),
        "concurrent_fragment_downloads": settings.get("concurrent_fragments", 4),
        # yt-dlp treats None as "unlimited" and divides by any other value, so the
        # UI's 0 (no limit) must be translated rather than passed through.
        "ratelimit": settings.get("ratelimit") or None,
        "sleep_interval_requests": settings.get("sleep_interval_requests", 0),
        "progress_hooks": [hook],
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    if opts.cookies_file:
        ydl_opts["cookiefile"] = opts.cookies_file
    if opts.cookies_from_browser:
        ydl_opts["cookiesfrombrowser"] = (opts.cookies_from_browser,)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except DownloadCancelled:
        raise
    except Exception as e:
        raise DownloadError(str(e)) from e
