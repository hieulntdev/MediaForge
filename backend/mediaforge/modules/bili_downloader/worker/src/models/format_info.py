from dataclasses import dataclass
from typing import Literal


def dynamic_range_from_qn(qn: int | None) -> str:
    if qn == 126:
        return "DV"
    if qn == 125:
        return "HDR10"
    return "SDR"


def _codec_family(codec: str | None) -> str:
    if not codec:
        return ""
    v = codec.lower()
    if "av01" in v or v.startswith("av1"):
        return "av1"
    if "hevc" in v or "hev1" in v or "hvc1" in v or "h265" in v:
        return "hevc"
    if "avc" in v or "h264" in v:
        return "avc"
    if "flac" in v:
        return "flac"
    if "opus" in v:
        return "opus"
    if "mp3" in v:
        return "mp3"
    if "ec-3" in v or "eac3" in v:
        return "eac3"
    if v == "ac3" or "ac-3" in v:
        return "ac3"
    if "alac" in v:
        return "alac"
    if "aac" in v or "mp4a" in v:
        return "aac"
    return v


def codec_label(vcodec: str | None) -> str:
    return {"av1": "AV1", "hevc": "HEVC", "avc": "AVC"}.get(
        _codec_family(vcodec), (vcodec or "Unknown").upper()
    )


@dataclass(frozen=True)
class FormatInfo:
    format_id: str
    kind: Literal["video", "audio"]
    ext: str
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    vcodec: str | None = None
    vbitrate: int | None = None
    quality_id: int | None = None
    dynamic_range: str = "SDR"
    acodec: str | None = None
    abitrate: int | None = None
    sample_rate: int | None = None
    channels: int | None = None
    is_lossless: bool = False
    filesize: int | None = None
    audio_note: str = ""


def format_info_from_dict(fmt: dict) -> FormatInfo:
    vcodec = fmt.get("vcodec") or None
    acodec = fmt.get("acodec") or None
    if vcodec == "none":
        vcodec = None
    if acodec == "none":
        acodec = None
    kind: Literal["video", "audio"] = "audio" if (acodec and not vcodec) else "video"

    quality_id = fmt.get("quality")
    if not isinstance(quality_id, int):
        quality_id = None

    fmt_id = str(fmt.get("format_id", ""))
    acodec_l = (acodec or "").lower()
    is_lossless = fmt_id in ("30250", "30251") or acodec_l in ("flac", "ape", "alac", "wav")
    audio_note = ""
    if fmt_id in ("30250", "30251"):
        audio_note = "Hi-Res"
    elif acodec_l in ("ec-3", "eac3"):
        audio_note = "Dolby Audio"

    return FormatInfo(
        format_id=fmt_id,
        kind=kind,
        ext=fmt.get("ext") or "m4s",
        width=fmt.get("width") or None,
        height=fmt.get("height") or None,
        fps=fmt.get("fps") or None,
        vcodec=vcodec,
        vbitrate=fmt.get("vbr") or None,
        quality_id=quality_id,
        dynamic_range=fmt.get("dynamic_range") or dynamic_range_from_qn(quality_id),
        acodec=acodec,
        abitrate=fmt.get("abr") or None,
        sample_rate=fmt.get("asr") or None,
        channels=fmt.get("audio_channels") or None,
        is_lossless=is_lossless,
        filesize=fmt.get("filesize") or fmt.get("filesize_approx"),
        audio_note=audio_note,
    )
