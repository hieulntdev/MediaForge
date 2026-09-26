from dataclasses import dataclass, field
from typing import Literal

from src.models.format_info import FormatInfo, _codec_family

DYNAMIC_RANGE_RANK = {"DV": 5, "HDR10+": 4, "HDR10": 3, "HLG": 2, "SDR": 1, "": 1}
CODEC_EFFICIENCY = {"av1": 3, "hevc": 2, "avc": 1}
VIDEO_MP4_CODECS = {"avc", "hevc"}
AUDIO_MP4_CODECS = {"aac", "mp3", "ac3", "eac3", "alac"}


class CodecUnavailable(Exception):
    def __init__(self, codec: str):
        self.codec = codec
        super().__init__(f"Codec {codec.upper()} not available")


@dataclass
class Selection:
    video: FormatInfo
    audio: FormatInfo | None
    container: Literal["mp4", "mkv"]
    warnings: list[str] = field(default_factory=list)


def select_best_video(formats: list[FormatInfo], codec_pref: str = "auto") -> FormatInfo:
    candidates = [f for f in formats if f.kind == "video"]
    if not candidates:
        raise CodecUnavailable("video")
    if codec_pref and codec_pref.lower() not in ("auto", "maximum quality"):
        fam = codec_pref.lower()
        matching = [f for f in candidates if _codec_family(f.vcodec) == fam]
        if not matching:
            raise CodecUnavailable(fam)
        candidates = matching

    def sort_key(f: FormatInfo):
        return (
            f.height or 0,
            f.quality_id or 0,
            f.vbitrate or 0,
            f.fps or 0,
            DYNAMIC_RANGE_RANK.get(f.dynamic_range, 1),
            CODEC_EFFICIENCY.get(_codec_family(f.vcodec), 0),
        )

    return max(candidates, key=sort_key)


def select_best_audio(formats: list[FormatInfo]) -> FormatInfo | None:
    candidates = [f for f in formats if f.kind == "audio"]
    if not candidates:
        return None

    def sort_key(f: FormatInfo):
        return (
            f.is_lossless,
            f.abitrate or 0,
            f.sample_rate or 0,
            f.channels or 0,
        )

    return max(candidates, key=sort_key)


def decide_container(video: FormatInfo, audio: FormatInfo | None) -> Literal["mp4", "mkv"]:
    video_ok = _codec_family(video.vcodec) in VIDEO_MP4_CODECS
    audio_ok = audio is None or _codec_family(audio.acodec) in AUDIO_MP4_CODECS
    sdr = video.dynamic_range == "SDR"
    if video_ok and audio_ok and sdr:
        return "mp4"
    return "mkv"


def select(video_formats, audio_formats, codec_pref="auto", container_pref="auto") -> Selection:
    warnings: list[str] = []
    try:
        video = select_best_video(video_formats, codec_pref)
    except CodecUnavailable as e:
        warnings.append(
            f"Codec {e.codec.upper()} not available; fell back to Maximum Quality."
        )
        video = select_best_video(video_formats, "auto")

    audio = select_best_audio(audio_formats)
    container = decide_container(video, audio) if container_pref == "auto" else container_pref
    return Selection(video=video, audio=audio, container=container, warnings=warnings)
