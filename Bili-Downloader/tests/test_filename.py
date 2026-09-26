from src.utils.filename import build_filename, sanitize_title, unique_path


def test_sanitize_forbidden_chars():
    assert sanitize_title('A/B:C*D?E"F<G>H|I') == "ABCDEFGHI"


def test_sanitize_control_and_whitespace():
    assert sanitize_title("  Hello\tWorld  ") == "Hello World"


def test_sanitize_keeps_unicode():
    assert "中文" in sanitize_title("中文视频")


def test_build_filename_with_index():
    name = build_filename(title="Movie Name", index=1, height=1080, vcodec="hev1",
                          is_hdr=False, ext="mp4")
    assert name == "01_Movie_Name_1080p_HEVC.mp4"


def test_build_filename_no_index():
    name = build_filename(title="Solo", index=None, height=1080, vcodec="avc1",
                          is_hdr=False, ext="mp4")
    assert name == "Solo_1080p_AVC.mp4"


def test_build_filename_hdr_suffix():
    name = build_filename(title="Movie", index=1, height=2160, vcodec="hev1",
                          is_hdr=True, ext="mkv")
    assert name == "01_Movie_2160p_HEVC_HDR.mkv"


def test_unique_path_suffix(tmp_path):
    (tmp_path / "A_1080p_AVC.mp4").write_text("x")
    p = unique_path(tmp_path, "A_1080p_AVC.mp4")
    assert p.name == "A_1080p_AVC_2.mp4"
    p.write_text("x")
    assert unique_path(tmp_path, "A_1080p_AVC.mp4").name == "A_1080p_AVC_3.mp4"


def test_long_title_truncated():
    assert len(build_filename(title="x" * 300, index=None, height=1080,
                              vcodec="avc1", is_hdr=False, ext="mp4")) < 255
