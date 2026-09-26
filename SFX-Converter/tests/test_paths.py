from pathlib import Path

from app.utils.paths import next_available_output, output_filename


def test_output_filename_uses_video_stem() -> None:
    assert output_filename(Path("movie.final.mp4")) == "movie.final_sfx.wav"


def test_next_available_output_never_overwrites(tmp_path: Path) -> None:
    video = tmp_path / "movie.mp4"
    (tmp_path / "movie_sfx.wav").touch()
    (tmp_path / "movie_sfx_1.wav").touch()
    assert next_available_output(video, tmp_path) == tmp_path / "movie_sfx_2.wav"
