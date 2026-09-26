from pathlib import Path

from app.utils.ffmpeg import extract_audio_command, ffprobe_command


def test_ffprobe_command_uses_json_and_literal_path() -> None:
    path = Path("/tmp/a video;still-safe.mp4")
    command = ffprobe_command("/usr/bin/ffprobe", path)
    assert command[-1] == str(path)
    assert command[:3] == ["/usr/bin/ffprobe", "-v", "error"]
    assert "json" in command


def test_extract_command_matches_checkpoint_audio_contract() -> None:
    command = extract_audio_command("ffmpeg", Path("in.mov"), Path("out.wav"), 44_100, 1)
    assert command[command.index("-ar") + 1] == "44100"
    assert command[command.index("-ac") + 1] == "1"
    assert command[command.index("-c:a") + 1] == "pcm_f32le"
    assert command[command.index("-map") + 1] == "0:a:0"
