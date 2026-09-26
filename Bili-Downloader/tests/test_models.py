from src.models.format_info import (
    codec_label,
    dynamic_range_from_qn,
    format_info_from_dict,
)
from src.models.video_info import video_info_from_dict


def test_dynamic_range_from_qn():
    assert dynamic_range_from_qn(126) == "DV"
    assert dynamic_range_from_qn(125) == "HDR10"
    assert dynamic_range_from_qn(120) == "SDR"
    assert dynamic_range_from_qn(None) == "SDR"


def test_codec_label():
    assert codec_label("avc1.640032") == "AVC"
    assert codec_label("hev1.1.6.L120.90") == "HEVC"
    assert codec_label("av01.0.12M.08") == "AV1"


def test_format_info_from_dict_video():
    fmt = {
        "format_id": "100120",
        "ext": "m4s", "vcodec": "avc1.640032", "acodec": "none",
        "width": 1920, "height": 1080, "fps": 30, "vbr": 4000000,
        "quality": 80, "filesize_approx": 100000000,
    }
    f = format_info_from_dict(fmt)
    assert f.kind == "video"
    assert f.vcodec == "avc1.640032"
    assert f.quality_id == 80
    assert f.dynamic_range == "SDR"
    assert f.height == 1080


def test_format_info_from_dict_hdr_inferred():
    f = format_info_from_dict({"format_id": "100125", "ext": "m4s",
                               "vcodec": "hev1.1.6.L150.90", "acodec": "none",
                               "quality": 125, "height": 2160})
    assert f.dynamic_range == "HDR10"


def test_format_info_from_dict_audio_lossless():
    f = format_info_from_dict({"format_id": "30250", "ext": "m4s",
                               "vcodec": "none", "acodec": "flac",
                               "abr": 2000000, "asr": 48000, "audio_channels": 2})
    assert f.kind == "audio"
    assert f.is_lossless is True
    assert f.audio_note == "Hi-Res"


def test_video_info_from_dict_scales_ytdlp_kbps_to_bps():
    """yt-dlp reports vbr/abr in Kbit/s; the model stores bit/s (see video_panel)."""
    info = {
        "id": "BV1xx411c7mD", "title": "T", "duration": 1.0,
        "formats": [
            {"format_id": "100050", "ext": "mp4", "vcodec": "avc1.640032",
             "acodec": "none", "vbr": 745.447, "height": 1080},
            {"format_id": "30280", "ext": "m4a", "vcodec": "none",
             "acodec": "mp4a.40.2", "abr": 176.958},
        ],
    }
    vi = video_info_from_dict(info)
    assert vi.video_formats[0].vbitrate == 745447
    assert vi.audio_formats[0].abitrate == 176958


def test_video_info_from_dict_multi_pages():
    info = {
        "id": "BV1xx411c7mD", "title": "Test", "uploader": "Someone",
        "duration": 60.0, "thumbnail": "https://x/y.jpg",
        "entries": [
            {"id": "BV1xx411c7mD", "title": "Test - P1", "duration": 30.0, "page_number": 1},
            {"id": "BV1xx411c7mD", "title": "Test - P2", "duration": 30.0, "page_number": 2},
        ],
        "formats": [
            {"format_id": "100080", "ext": "m4s", "vcodec": "avc1", "acodec": "none",
             "quality": 80, "height": 1080},
            {"format_id": "30280", "ext": "m4s", "vcodec": "none", "acodec": "mp4a.40.2",
             "abr": 192000},
        ],
    }
    vi = video_info_from_dict(info)
    assert vi.bvid == "BV1xx411c7mD"
    assert len(vi.pages) == 2
    assert vi.pages[0].index == 1
    assert len(vi.video_formats) == 1
    assert len(vi.audio_formats) == 1
