import json
import urllib.request
from pathlib import Path

from src.models.video_info import VideoInfo
from src.utils.filename import sanitize_title, unique_path


def _ts_srt(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_vtt(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _ts_ass(seconds: float) -> str:
    cs = int(round(seconds * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def convert_subtitle(data: dict, fmt: str) -> str:
    body = data.get("body") or []
    if not body:
        return ""
    fmt = fmt.lower()
    if fmt == "srt":
        blocks = []
        for i, line in enumerate(body, 1):
            blocks.append(
                f"{i}\n{_ts_srt(line['from'])} --> {_ts_srt(line['to'])}\n{line['content']}"
            )
        return "\n\n".join(blocks) + "\n"
    if fmt == "vtt":
        lines = ["WEBVTT", ""]
        for line in body:
            lines.append(f"{_ts_vtt(line['from'])} --> {_ts_vtt(line['to'])}")
            lines.append(line["content"])
            lines.append("")
        return "\n".join(lines)
    if fmt == "ass":
        header = (
            "[Script Info]\nScriptType: v4.00+\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        )
        lines = [header]
        for line in body:
            text = line["content"].replace("\n", "\\N")
            lines.append(
                f"Dialogue: 0,{_ts_ass(line['from'])},{_ts_ass(line['to'])},Default,,0,0,0,,{text}"
            )
        return "\n".join(lines) + "\n"
    raise ValueError(f"Unsupported subtitle format: {fmt}")


def download_subtitles(video_info: VideoInfo, out_dir: Path, fmt: str = "srt",
                       *, opts) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    stem = sanitize_title(video_info.title)
    for sub in video_info.subtitles:
        if not sub.url:
            continue
        req = urllib.request.Request(sub.url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        text = convert_subtitle(data, fmt)
        if not text:
            continue
        path = unique_path(out_dir, f"{stem}.{sub.lang}.{fmt}")
        path.write_text(text, encoding="utf-8")
        saved.append(path)
    return saved
