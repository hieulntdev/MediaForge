import threading
from dataclasses import dataclass
from pathlib import Path

from src.core.analyzer import DownloadItem
from src.core.downloader import DownloadCancelled, DownloadError, download
from src.core.muxer import MuxError, mux
from src.core.subtitle import download_subtitles
from src.core.verifier import VerifyExpectation, verify
from src.utils.ffprobe import probe
from src.utils.logger import get_logger, mask_secrets
from src.utils.paths import TEMP_DIR

log = get_logger()


@dataclass
class PipelineResult:
    item: DownloadItem
    status: str  # "SUCCESS" | "FAILED" | "CANCELLED"
    output_path: Path | None
    error: str | None


def process(item: DownloadItem, settings: dict, opts, progress_cb, log_cb,
            pause_event: threading.Event, cancel_event: threading.Event,
            stage_cb=None) -> PipelineResult:
    temp_dir = TEMP_DIR / item.bvid / str(item.cid)
    temp_dir.mkdir(parents=True, exist_ok=True)
    video_tmp = temp_dir / f"video.{item.video.ext}"
    audio_tmp = temp_dir / f"audio.{item.audio.ext}" if item.audio else None

    def log_progress(d):
        progress_cb(d)

    try:
        if stage_cb:
            stage_cb("downloading", "Video stream")
        log_cb("INFO", f"Downloading video stream {item.video.format_id}")
        download(item.video_info.url, item.video.format_id, video_tmp, opts=opts,
                 progress_cb=log_progress, pause_event=pause_event,
                 cancel_event=cancel_event, settings=settings)
        if audio_tmp:
            if stage_cb:
                stage_cb("downloading", "Audio stream")
            log_cb("INFO", f"Downloading audio stream {item.audio.format_id}")
            download(item.video_info.url, item.audio.format_id, audio_tmp, opts=opts,
                     progress_cb=log_progress, pause_event=pause_event,
                     cancel_event=cancel_event, settings=settings)

        if stage_cb:
            stage_cb("merging", "Muxing…")
        log_cb("INFO", "Muxing")
        mux(video_tmp, audio_tmp, item.output_path)

        if stage_cb:
            stage_cb("processing", "Verifying…")
        log_cb("INFO", "Verifying")
        probe_data = probe(item.output_path)
        expected = VerifyExpectation(
            duration=item.video_info.duration,
            width=item.video.width or 0, height=item.video.height or 0,
            fps=item.video.fps or 0.0, vcodec=item.video.vcodec or "",
            acodec=item.audio.acodec if item.audio else None,
            vbitrate=item.video.vbitrate,
            abitrate=item.audio.abitrate if item.audio else None,
            sample_rate=item.audio.sample_rate if item.audio else None,
            expect_hdr=item.video.dynamic_range != "SDR",
        )
        result = verify(probe_data, expected)
        if not result.passed:
            for e in result.errors:
                log_cb("ERROR", e)
            return PipelineResult(item, "FAILED", item.output_path,
                                  "; ".join(result.errors))

        if settings.get("download_subtitle", True):
            if stage_cb:
                stage_cb("processing", "Downloading subtitles…")
            fmt = settings.get("subtitle_format", "srt")
            download_subtitles(item.video_info, item.output_path.parent, fmt, opts=opts)

        if settings.get("delete_temp", True):
            _rmtree(temp_dir)
        return PipelineResult(item, "SUCCESS", item.output_path, None)

    except DownloadCancelled:
        return PipelineResult(item, "CANCELLED", None, "Cancelled by user.")
    except (DownloadError, MuxError, RuntimeError) as e:
        log_cb("ERROR", mask_secrets(str(e)))
        return PipelineResult(item, "FAILED", None, str(e))


def _rmtree(path: Path) -> None:
    import shutil
    shutil.rmtree(path, ignore_errors=True)
