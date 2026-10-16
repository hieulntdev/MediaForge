from src.extractors.base import BilibiliExtractor, ExtractOptions, ExtractorUnavailable
from src.models.video_info import VideoInfo, video_info_from_dict
from src.utils.logger import get_logger

log = get_logger()


class YtDlpExtractor(BilibiliExtractor):
    def is_available(self) -> bool:
        try:
            import yt_dlp  # noqa: F401
            return True
        except ImportError:
            return False

    def extract(self, url: str, opts: ExtractOptions) -> list[VideoInfo]:
        try:
            import yt_dlp
        except ImportError as e:
            raise ExtractorUnavailable("yt-dlp is not installed") from e

        ydl_opts = {
            "extract_flat": False,
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "logger": _SilentLogger(),
        }
        if opts.cookies_file:
            ydl_opts["cookiefile"] = opts.cookies_file
        if opts.cookies_from_browser:
            ydl_opts["cookiesfrombrowser"] = (opts.cookies_from_browser,)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        if info is None:
            raise ExtractorUnavailable("yt-dlp returned no info")

        if info.get("_type") == "playlist":
            entries = info.get("entries") or []
            return [video_info_from_dict(e) for e in entries if e]
        return [video_info_from_dict(info)]


def get_ytdlp_version() -> str:
    try:
        import yt_dlp
        return getattr(yt_dlp.version, "__version__", "unknown")
    except ImportError:
        return "not installed"


class _SilentLogger:
    def debug(self, *a, **k): ...
    def warning(self, *a, **k): ...
    def error(self, *a, **k): ...
