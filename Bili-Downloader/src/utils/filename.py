import re
from pathlib import Path

from src.models.format_info import codec_label

_FORBIDDEN = re.compile(r'[\\/:*?"<>|]')
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_WS = re.compile(r"\s+")


def sanitize_title(title: str) -> str:
    s = _FORBIDDEN.sub("", title)
    s = _CONTROL.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    # reserve room for index_ (3) + _1080p_HEVC_HDR.mkv (~20) in the full path
    return s[:200]


def build_filename(*, title, index, height, vcodec, is_hdr, ext) -> str:
    clean = sanitize_title(title).replace(" ", "_")
    codec = codec_label(vcodec)
    res = f"{height}p"
    hdr = "_HDR" if is_hdr else ""
    parts = [clean, res, codec + hdr]
    if index is not None:
        parts = [f"{index:02d}"] + parts
    return "_".join(parts) + f".{ext}"


def unique_path(directory: Path, filename: str) -> Path:
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    n = 2
    while True:
        alt = directory / f"{stem}_{n}{suffix}"
        if not alt.exists():
            return alt
        n += 1
