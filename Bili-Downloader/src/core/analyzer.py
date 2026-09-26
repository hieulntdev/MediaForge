from dataclasses import dataclass
from pathlib import Path

from src.core.format_selector import select
from src.extractors.base import ExtractOptions, ExtractorUnavailable
from src.extractors.bilibili_fallback import BilibiliFallbackExtractor
from src.extractors.ytdlp_bilibili import YtDlpExtractor
from src.models.format_info import FormatInfo
from src.models.video_info import VideoInfo
from src.utils.filename import build_filename, unique_path
from src.utils.paths import DOWNLOAD_DIR


@dataclass
class DownloadItem:
    index: int | None
    bvid: str
    cid: int
    title: str
    video: FormatInfo
    audio: FormatInfo | None
    container: str
    output_path: Path
    video_info: VideoInfo


def analyze(url: str, opts: ExtractOptions, codec_pref: str = "auto",
            container_pref: str = "auto",
            output_dir: Path | None = None) -> list[DownloadItem]:
    out_dir = output_dir or DOWNLOAD_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    videos = _extract(url, opts)

    items: list[DownloadItem] = []
    multi = sum(len(v.pages) for v in videos) > 1 or len(videos) > 1

    for vi in videos:
        sel = select(vi.video_formats, vi.audio_formats, codec_pref, container_pref)
        if vi.pages:
            for page in vi.pages:
                idx = page.index if multi else None
                is_hdr = sel.video.dynamic_range != "SDR"
                fname = build_filename(title=page.title, index=idx,
                                       height=sel.video.height,
                                       vcodec=sel.video.vcodec, is_hdr=is_hdr,
                                       ext=sel.container)
                items.append(DownloadItem(
                    index=idx, bvid=vi.bvid, cid=page.cid, title=page.title,
                    video=sel.video, audio=sel.audio, container=sel.container,
                    output_path=unique_path(out_dir, fname), video_info=vi,
                ))
        else:
            is_hdr = sel.video.dynamic_range != "SDR"
            fname = build_filename(title=vi.title, index=None,
                                   height=sel.video.height,
                                   vcodec=sel.video.vcodec, is_hdr=is_hdr,
                                   ext=sel.container)
            items.append(DownloadItem(
                index=None, bvid=vi.bvid, cid=0, title=vi.title,
                video=sel.video, audio=sel.audio, container=sel.container,
                output_path=unique_path(out_dir, fname), video_info=vi,
            ))
    return items


def _extract(url: str, opts: ExtractOptions) -> list[VideoInfo]:
    primary = YtDlpExtractor()
    try:
        result = primary.extract(url, opts)
        if result and any(r.video_formats for r in result):
            return result
    except ExtractorUnavailable:
        pass
    fallback = BilibiliFallbackExtractor()
    return fallback.extract(url, opts)
