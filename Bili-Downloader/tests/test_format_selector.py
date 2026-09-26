import pytest

from src.core.format_selector import (
    CodecUnavailable, decide_container, select, select_best_audio, select_best_video,
)
from src.models.format_info import FormatInfo


def vf(height, vbitrate, vcodec, qn=120, dr="SDR", fmt_id="x", fps=30):
    return FormatInfo(format_id=fmt_id, kind="video", ext="m4s",
                      height=height, vbitrate=vbitrate, vcodec=vcodec,
                      quality_id=qn, dynamic_range=dr, fps=fps)


def af(abitrate, acodec="mp4a.40.2", lossless=False, sr=48000, ch=2, fmt_id="a"):
    return FormatInfo(format_id=fmt_id, kind="audio", ext="m4s",
                      abitrate=abitrate, acodec=acodec, is_lossless=lossless,
                      sample_rate=sr, channels=ch)


def test_higher_resolution_wins():
    assert select_best_video([vf(720, 1_000_000, "avc1"), vf(1080, 1_000_000, "avc1")]).height == 1080


def test_higher_bitrate_beats_codec_efficiency():
    hevc = vf(1080, 8_000_000, "hev1")
    av1_low = vf(1080, 4_000_000, "av01")
    assert select_best_video([av1_low, hevc]).vcodec == "hev1"


def test_codec_tiebreak_when_bitrate_equal():
    hevc = vf(1080, 8_000_000, "hev1")
    av1 = vf(1080, 8_000_000, "av01")
    assert select_best_video([hevc, av1]).vcodec == "av01"


def test_dynamic_range_tiebreak():
    hdr = vf(1080, 8_000_000, "hev1", qn=125, dr="HDR10")
    sdr = vf(1080, 8_000_000, "hev1", dr="SDR")
    assert select_best_video([sdr, hdr]).dynamic_range == "HDR10"


def test_codec_preference_filters():
    avc = vf(1080, 8_000_000, "avc1")
    hevc = vf(1080, 7_000_000, "hev1")
    assert select_best_video([avc, hevc], codec_pref="avc").vcodec == "avc1"


def test_codec_preference_unavailable_raises():
    with pytest.raises(CodecUnavailable):
        select_best_video([vf(1080, 8_000_000, "avc1")], codec_pref="av1")


def test_select_falls_back_with_warning():
    sel = select([vf(1080, 8_000_000, "avc1")], [af(192_000)], codec_pref="av1")
    assert sel.video.vcodec == "avc1"
    assert any("AV1" in w for w in sel.warnings)


def test_audio_lossless_first():
    aac = af(320_000, acodec="mp4a.40.2")
    flac = af(1_500_000, acodec="flac", lossless=True)
    assert select_best_audio([aac, flac]).is_lossless is True


def test_audio_higher_bitrate():
    low = af(128_000)
    high = af(320_000)
    assert select_best_audio([low, high]).abitrate == 320_000


@pytest.mark.parametrize("video,audio,expected", [
    (vf(1080, 1, "avc1"), af(1, "mp4a.40.2"), "mp4"),
    (vf(1080, 1, "hev1"), af(1, "mp4a.40.2"), "mp4"),
    (vf(2160, 1, "av01"), af(1, "mp4a.40.2"), "mkv"),
    (vf(2160, 1, "hev1", dr="HDR10"), af(1, "mp4a.40.2"), "mkv"),
])
def test_container_cases(video, audio, expected):
    assert decide_container(video, audio) == expected


def test_opus_forces_mkv():
    assert decide_container(vf(1080, 1, "avc1"), af(1, "opus")) == "mkv"
