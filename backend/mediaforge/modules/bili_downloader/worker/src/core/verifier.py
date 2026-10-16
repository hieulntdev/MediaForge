from dataclasses import dataclass, field

from src.models.format_info import _codec_family

WARN_TOLERANCE = 0.1
FAIL_TOLERANCE = 0.5


@dataclass
class VerifyExpectation:
    duration: float
    width: int
    height: int
    fps: float
    vcodec: str
    acodec: str | None
    vbitrate: int | None
    abitrate: int | None
    sample_rate: int | None
    expect_hdr: bool


@dataclass
class VerifyResult:
    passed: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _streams(probe: dict) -> list[dict]:
    return probe.get("streams") or []


def _video_stream(probe: dict) -> dict | None:
    for s in _streams(probe):
        if s.get("codec_type") == "video":
            return s
    return None


def _audio_stream(probe: dict) -> dict | None:
    for s in _streams(probe):
        if s.get("codec_type") == "audio":
            return s
    return None


def _bitrate_diff(a: int | None, b: int | None) -> bool:
    if not a or not b:
        return False
    return abs(a - b) / max(a, b) > 0.20


def _hdr_present(vstream: dict) -> bool:
    return vstream.get("color_transfer") in ("smpte2084", "arib-std-b67")


def verify(probe: dict, expected: VerifyExpectation) -> VerifyResult:
    errors: list[str] = []
    warnings: list[str] = []
    fmt = probe.get("format") or {}
    vstream = _video_stream(probe)
    astream = _audio_stream(probe)

    # 1-2 existence / size
    if int(fmt.get("size") or 0) <= 0:
        errors.append("File is empty (0 bytes).")
    # 3 duration
    out_dur = float(fmt.get("duration") or 0.0)
    if out_dur <= 0:
        errors.append("Output duration missing.")
    else:
        diff = abs(out_dur - expected.duration)
        if diff > FAIL_TOLERANCE:
            errors.append(
                f"Duration mismatch: source {expected.duration}s vs output {out_dur}s."
            )
        elif diff > WARN_TOLERANCE:
            warnings.append(f"Duration off by {diff:.2f}s (within tolerance).")
    # 4 video stream
    if vstream is None:
        errors.append("No video stream.")
    else:
        # 6 resolution
        if (vstream.get("width"), vstream.get("height")) != (expected.width, expected.height):
            errors.append("Resolution mismatch.")
        # 7 fps
        fps = _parse_fps(vstream.get("avg_frame_rate"))
        if fps is not None and expected.fps and abs(fps - expected.fps) > 0.01:
            errors.append(f"FPS mismatch: expected {expected.fps}, got {fps}.")
        # 8 video codec
        # ffprobe reports short names ("h264") but the manifest reports RFC 6381
        # strings ("avc1.640032"), so compare the family both forms reduce to.
        if expected.vcodec and _codec_family(vstream.get("codec_name")) != _codec_family(expected.vcodec):
            errors.append(f"Video codec mismatch: expected {expected.vcodec}.")
        # 10 video bitrate
        vbr = int(vstream.get("bit_rate") or 0) or None
        if _bitrate_diff(vbr, expected.vbitrate):
            errors.append("Video bitrate deviates > 20%.")
        # 13 HDR metadata
        if expected.expect_hdr and not _hdr_present(vstream):
            errors.append("HDR metadata lost.")
    # 5 audio stream
    if expected.acodec is not None and astream is None:
        errors.append("No audio stream.")
    elif astream is not None and expected.acodec is not None:
        # 9 audio codec
        if _codec_family(astream.get("codec_name")) != _codec_family(expected.acodec):
            errors.append(f"Audio codec mismatch: expected {expected.acodec}.")
        # 11 audio bitrate
        abr = int(astream.get("bit_rate") or 0) or None
        if _bitrate_diff(abr, expected.abitrate):
            errors.append("Audio bitrate deviates > 20%.")
        # 12 sample rate (the manifest often omits it, so only flag a known mismatch)
        if expected.sample_rate and int(astream.get("sample_rate") or 0) not in (0, expected.sample_rate):
            errors.append("Sample rate mismatch.")

    return VerifyResult(passed=not errors, errors=errors, warnings=warnings)


def _parse_fps(fps_str: str | None) -> float | None:
    if not fps_str or "/" not in fps_str:
        return None
    num, den = fps_str.split("/", 1)
    try:
        if float(den) == 0:
            return None
        return float(num) / float(den)
    except ValueError:
        return None
