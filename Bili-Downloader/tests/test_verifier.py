from src.core.verifier import VerifyExpectation, verify


def _probe(duration=60.0, vcodec="h264", acodec="aac", width=1920, height=1080,
           fps=30.0, vbitrate=4000000, abitrate=192000, sample_rate=48000,
           hdr=False):
    streams = [{
        "codec_type": "video", "codec_name": vcodec, "width": width, "height": height,
        "avg_frame_rate": f"{fps}/1", "bit_rate": str(vbitrate),
    }, {
        "codec_type": "audio", "codec_name": acodec, "bit_rate": str(abitrate),
        "sample_rate": str(sample_rate),
    }]
    if hdr:
        streams[0]["color_transfer"] = "smpte2084"
    return {"format": {"duration": str(duration), "size": "1000000"}, "streams": streams}


def _exp(**kw):
    base = dict(duration=60.0, width=1920, height=1080, fps=30.0, vcodec="h264",
                acodec="aac", vbitrate=4000000, abitrate=192000, sample_rate=48000,
                expect_hdr=False)
    base.update(kw)
    return VerifyExpectation(**base)


def test_passes_when_all_match():
    assert verify(_probe(), _exp()).passed is True


def test_duration_within_warn_tolerance():
    r = verify(_probe(duration=60.4), _exp(duration=60.0))
    assert r.passed is True
    assert r.warnings  # 0.4s > 0.1s warn threshold


def test_duration_fail_over_half_second():
    r = verify(_probe(duration=61.0), _exp(duration=60.0))
    assert r.passed is False
    assert any("duration" in e.lower() for e in r.errors)


def test_missing_audio_stream():
    p = _probe()
    p["streams"] = [s for s in p["streams"] if s["codec_type"] != "audio"]
    r = verify(p, _exp())
    assert r.passed is False
    assert any("audio" in e.lower() for e in r.errors)


def test_wrong_resolution():
    r = verify(_probe(width=1280, height=720), _exp())
    assert r.passed is False


def test_hdr_metadata_lost():
    r = verify(_probe(), _exp(expect_hdr=True))
    assert r.passed is False
    assert any("hdr" in e.lower() for e in r.errors)


def test_zero_byte_file():
    p = _probe()
    p["format"]["size"] = "0"
    r = verify(p, _exp())
    assert r.passed is False


def test_codec_matches_across_ffprobe_and_manifest_forms():
    """ffprobe says h264/aac; the manifest says avc1.640032/mp4a.40.2."""
    r = verify(_probe(vcodec="h264", acodec="aac"),
               _exp(vcodec="avc1.640032", acodec="mp4a.40.2"))
    assert r.passed is True


def test_wrong_codec_family_still_fails():
    r = verify(_probe(vcodec="hevc", acodec="aac"), _exp(vcodec="avc1.640032"))
    assert r.passed is False
    assert any("codec" in e.lower() for e in r.errors)


def test_unknown_expected_sample_rate_is_skipped():
    """The manifest often omits sample rate; that must not fail the check."""
    r = verify(_probe(sample_rate=44100), _exp(sample_rate=None))
    assert r.passed is True


def test_sample_rate_mismatch_still_fails():
    r = verify(_probe(sample_rate=44100), _exp(sample_rate=48000))
    assert r.passed is False
    assert any("sample rate" in e.lower() for e in r.errors)
