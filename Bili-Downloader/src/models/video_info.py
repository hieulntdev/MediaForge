from dataclasses import dataclass, field

from src.models.format_info import FormatInfo, format_info_from_dict


@dataclass
class PageInfo:
    index: int
    title: str
    cid: int
    duration: float
    url: str


@dataclass
class SubtitleInfo:
    lang: str
    url: str


@dataclass
class VideoInfo:
    url: str
    bvid: str
    title: str
    uploader: str
    duration: float
    thumbnail_url: str
    view_count: int = 0
    upload_date: str = ""  # yt-dlp style YYYYMMDD, empty when unknown
    pages: list[PageInfo] = field(default_factory=list)
    video_formats: list[FormatInfo] = field(default_factory=list)
    audio_formats: list[FormatInfo] = field(default_factory=list)
    subtitles: list[SubtitleInfo] = field(default_factory=list)
    extractor: str = "yt-dlp"


def _ytdlp_format(f: dict) -> FormatInfo:
    """yt-dlp reports vbr/abr in Kbit/s; FormatInfo stores bit/s (see video_panel)."""
    scaled = {
        **f,
        **{k: int(round(f[k] * 1000)) for k in ("vbr", "abr") if f.get(k)},
    }
    return format_info_from_dict(scaled)


def video_info_from_dict(info: dict) -> VideoInfo:
    video_fmts = [
        _ytdlp_format(f)
        for f in info.get("formats", [])
        if (f.get("vcodec") not in (None, "none"))
    ]
    audio_fmts = [
        _ytdlp_format(f)
        for f in info.get("formats", [])
        if (f.get("acodec") not in (None, "none")) and (f.get("vcodec") in (None, "none"))
    ]
    entries = info.get("entries") or []
    pages = [
        PageInfo(
            index=int(e.get("page_number") or i + 1),
            title=e.get("title") or info.get("title", ""),
            cid=int(e.get("id")) if str(e.get("id", "")).isdigit() else 0,
            duration=float(e.get("duration") or 0.0),
            url=e.get("webpage_url") or info.get("webpage_url", ""),
        )
        for i, e in enumerate(entries)
    ]
    return VideoInfo(
        url=info.get("webpage_url") or info.get("original_url") or "",
        bvid=str(info.get("id") or ""),
        title=info.get("title") or "",
        uploader=info.get("uploader") or info.get("channel") or "",
        duration=float(info.get("duration") or 0.0),
        thumbnail_url=info.get("thumbnail") or "",
        view_count=int(info.get("view_count") or 0),
        upload_date=str(info.get("upload_date") or ""),
        pages=pages,
        video_formats=video_fmts,
        audio_formats=audio_fmts,
        subtitles=[SubtitleInfo(lang=k, url=v) for k, v in (info.get("subtitles") or {}).items()],
    )
