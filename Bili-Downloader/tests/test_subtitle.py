import pytest

from src.core.subtitle import convert_subtitle

BODY = {"body": [
    {"from": 1.0, "to": 3.5, "content": "Hello world"},
    {"from": 3.5, "to": 6.0, "content": "Second line"},
]}


def test_srt_format():
    out = convert_subtitle(BODY, "srt")
    assert out.startswith("1\n")
    assert "00:00:01,000 --> 00:00:03,500" in out
    assert "Hello world" in out
    assert "\n2\n" in out


def test_vtt_format():
    out = convert_subtitle(BODY, "vtt")
    assert out.startswith("WEBVTT\n")
    assert "00:00:01.000 --> 00:00:03.500" in out


def test_ass_format():
    out = convert_subtitle(BODY, "ass")
    assert "[Script Info]" in out
    assert "[Events]" in out
    assert "Dialogue:" in out


def test_empty_body():
    assert convert_subtitle({"body": []}, "srt") == ""


def test_unknown_format_raises():
    with pytest.raises(ValueError):
        convert_subtitle(BODY, "docx")
