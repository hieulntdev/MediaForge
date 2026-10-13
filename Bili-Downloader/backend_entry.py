"""Long-lived console worker spawned by the Electron main process.

Reads newline-delimited JSON commands on stdin and writes newline-delimited
``BILI_EVENT <json>`` events on stdout. All download/process logic lives in
``src/`` and is reused unchanged; this file is thin transport glue.
"""

from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

from src.auth.account import AccountInfo, check_account
from src.core.analyzer import DownloadItem, analyze
from src.core.pipeline import process
from src.extractors.base import ExtractOptions
from src.settings import DEFAULT_SETTINGS, load_settings, save_settings
from src.utils.links import read_links
from src.utils.logger import mask_secrets
from src.utils.paths import DOWNLOAD_DIR

# stdout is shared by the main loop and the download thread; one lock keeps a
# whole ``BILI_EVENT ...`` line atomic.
_OUT_LOCK = threading.Lock()

_CODEC_MAP = {
    "Auto / Maximum Quality": "auto",
    "AVC": "avc",
    "HEVC": "hevc",
    "AV1": "av1",
}
_CONTAINER_MAP = {
    "Auto": "auto",
    "MP4": "mp4",
    "MKV": "mkv",
}


def emit(event_type: str, **payload) -> None:
    event = {"type": event_type, **payload}
    line = json.dumps(event, ensure_ascii=False, default=str)
    with _OUT_LOCK:
        print(f"BILI_EVENT {line}", flush=True)


def _normalize_codec(value: str) -> str:
    return _CODEC_MAP.get(value, value.lower())


def _normalize_container(value: str) -> str:
    return _CONTAINER_MAP.get(value, value.lower())


def _account_status(info: AccountInfo) -> str:
    return info.status.value


def _fmt_date(raw: str) -> str:
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw


def _project(item: DownloadItem, row: int) -> dict:
    info = item.video_info
    return {
        "row": row,
        "id": item.index if item.index is not None else row + 1,
        "title": item.title,
        "uploader": info.uploader,
        "duration": info.duration,
        "views": info.view_count,
        "date": _fmt_date(info.upload_date),
        "url": info.url,
        "output_path": str(item.output_path),
    }


_state = {
    "cookies_file": None,
    "output_dir": DOWNLOAD_DIR,
    "items": [],                 # list[DownloadItem]
    "opts": ExtractOptions(),
    "pause_event": threading.Event(),
    "cancel_event": threading.Event(),
    "dl_thread": None,
    "speed_samples": {},
}


def _run_check_account(cmd: dict) -> None:
    cookies_file = cmd.get("cookies_file") or _state["cookies_file"]
    if cookies_file:
        _state["cookies_file"] = cookies_file
        _state["opts"] = ExtractOptions(cookies_file=cookies_file)
    info = check_account(cookies_file or None)
    emit(
        "account",
        status=_account_status(info),
        username=info.username or "",
        message=info.message,
        http_status=info.http_status,
        api_code=info.api_code,
    )


def _run_analyze(cmd: dict) -> None:
    url = (cmd.get("url") or "").strip()
    links_file = cmd.get("links_file") or ""
    cookies_file = cmd.get("cookies_file") or None
    output_dir = cmd.get("output_dir") or None
    auto_download = bool(cmd.get("auto_download", False))

    _state["cookies_file"] = cookies_file
    _state["opts"] = ExtractOptions(cookies_file=cookies_file)
    out_dir = Path(output_dir) if output_dir else DOWNLOAD_DIR
    _state["output_dir"] = out_dir

    try:
        if url:
            urls = [url]
        else:
            if not links_file:
                emit("analyze_failed", message="No link list file selected.")
                return
            urls = read_links(Path(links_file))
            if not urls:
                emit("analyze_failed", message=f"No links found in {links_file}")
                return
    except (OSError, ValueError) as e:
        emit("analyze_failed", message=mask_secrets(str(e)))
        return

    settings = load_settings()
    codec_pref = _normalize_codec(settings.get("codec", "Auto / Maximum Quality"))
    container_pref = _normalize_container(settings.get("container", "Auto"))

    items: list[DownloadItem] = []
    for i, u in enumerate(urls):
        emit("analyze_progress", index=i + 1, total=len(urls), url=u)
        try:
            items.extend(analyze(u, _state["opts"], codec_pref, container_pref,
                                 output_dir=out_dir))
        except Exception as e:  # noqa: BLE001
            emit("log", level="ERROR", message=f"{u}: {mask_secrets(str(e))}")

    if not items:
        emit("analyze_failed", message="No downloadable video could be resolved.")
        return

    _state["items"] = items
    emit("analyze_done", items=[_project(it, r) for r, it in enumerate(items)],
         total=len(items))
    if auto_download:
        _start_download(None)


def _nonnegative_number(value) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if math.isfinite(result) and result >= 0 else 0.0


def _speed_for_progress(row: int, data: dict, now: float | None = None) -> float:
    """Return network bytes/second, preferring yt-dlp's measured value."""
    received = _nonnegative_number(data.get("downloaded_bytes"))
    timestamp = time.monotonic() if now is None else now
    native = data.get("speed")
    previous = _state["speed_samples"].get(row)
    speed = 0.0
    try:
        native_value = float(native)
    except (TypeError, ValueError):
        native_value = math.nan
    if math.isfinite(native_value) and native_value >= 0:
        speed = native_value
    elif previous is not None:
        previous_received, previous_time, previous_speed = previous
        elapsed = timestamp - previous_time
        if received >= previous_received and elapsed > 0:
            measured = (received - previous_received) / elapsed
            if math.isfinite(measured) and measured >= 0:
                speed = measured if previous_speed <= 0 else (previous_speed * 0.65 + measured * 0.35)
    _state["speed_samples"][row] = (received, timestamp, speed)
    return speed


def _progress(row: int, d: dict) -> None:
    status = d.get("status")
    if status == "downloading":
        total = _nonnegative_number(d.get("total_bytes") or d.get("total_bytes_estimate"))
        received = _nonnegative_number(d.get("downloaded_bytes"))
        fraction = min(1.0, received / total) if total else 0.0
        speed = _speed_for_progress(row, d)
        emit("progress", row=row, status="downloading", received=received,
             total=total, fraction=fraction, eta=d.get("_eta_str") or "",
             speed=speed)
    elif status == "finished":
        _state["speed_samples"].pop(row, None)
        emit("progress", row=row, status="finished", received=0, total=0,
             fraction=1.0, eta="", speed=0)


def _download_loop(indices: list[int] | None) -> None:
    try:
        settings = load_settings()
        opts = _state["opts"]
        items = _state["items"]
        if indices is None:
            indices = list(range(len(items)))
        for row in indices:
            if _state["cancel_event"].is_set():
                break
            item = items[row]
            _state["speed_samples"].pop(row, None)
            emit("row_update", row=row, status="Downloading", detail="")
            result = process(
                item, settings, opts,
                progress_cb=lambda d, r=row: _progress(r, d),
                log_cb=lambda lvl, msg: emit("log", level=lvl, message=mask_secrets(msg)),
                pause_event=_state["pause_event"],
                cancel_event=_state["cancel_event"],
                stage_cb=lambda stage, detail, r=row: emit(
                    "row_update",
                    row=r,
                    status="Downloading" if stage == "downloading" else "Processing",
                    detail=detail,
                ),
            )
            if result.status == "SUCCESS":
                emit("row_update", row=row, status="Done", detail="")
            elif result.status == "CANCELLED":
                emit("row_update", row=row, status="Queued", detail="")
                break
            else:
                emit("row_update", row=row, status="Failed",
                     detail=mask_secrets(result.error or "Failed"))
    except Exception as e:  # noqa: BLE001
        emit("log", level="ERROR", message=mask_secrets(str(e)))
    finally:
        _state["speed_samples"].clear()
        emit("download_done")


def _start_download(indices: list[int] | None) -> None:
    thread = _state["dl_thread"]
    if thread is not None and thread.is_alive():
        emit("log", level="WARN", message="A download is already running.")
        return
    _state["pause_event"].clear()
    _state["cancel_event"].clear()
    thread = threading.Thread(target=_download_loop, args=(indices,), daemon=True)
    _state["dl_thread"] = thread
    thread.start()


def _dispatch(cmd: dict) -> None:
    name = cmd.get("command")
    if name == "check_account":
        threading.Thread(target=_run_check_account, args=(cmd,), daemon=True).start()
    elif name == "get_settings":
        emit("settings", settings=load_settings())
    elif name == "save_settings":
        save_settings({**DEFAULT_SETTINGS, **cmd.get("settings", {})})
        emit("settings_saved")
    elif name == "analyze":
        threading.Thread(target=_run_analyze, args=(cmd,), daemon=True).start()
    elif name == "download":
        indices = cmd.get("indices")
        if indices is not None:
            indices = [int(i) for i in indices]
        _start_download(indices)
    elif name == "pause":
        _state["pause_event"].set()
    elif name == "resume":
        _state["pause_event"].clear()
    elif name == "cancel":
        _state["cancel_event"].set()
        _state["pause_event"].clear()
    else:
        emit("log", level="ERROR", message=f"Unknown command: {name}")


def main() -> int:
    import sys
    emit("log", level="INFO", message="Backend ready.")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            _dispatch(json.loads(line))
        except json.JSONDecodeError:
            emit("log", level="ERROR", message="Invalid command JSON.")
        except Exception as e:  # noqa: BLE001
            emit("log", level="ERROR", message=mask_secrets(str(e)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
