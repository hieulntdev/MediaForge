"""Creation and strict validation of ZSP (ZIP) project archives."""

from __future__ import annotations

import json
from pathlib import Path
import wave
import zipfile


PROJECT_FIELDS = ("index", "start", "end", "content", "speaker_name", "audio_filename")


class ZSPValidationError(ValueError):
    pass


def validate_wav(path: Path) -> None:
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getcomptype() != "NONE":
                raise ZSPValidationError(f"{path.name}: WAV is not PCM")
            if wav.getnchannels() != 1:
                raise ZSPValidationError(f"{path.name}: WAV is not mono")
            if wav.getframerate() != 24_000:
                raise ZSPValidationError(f"{path.name}: WAV is not 24000 Hz")
            if wav.getsampwidth() != 2:
                raise ZSPValidationError(f"{path.name}: WAV is not 16-bit")
            if wav.getnframes() == 0:
                raise ZSPValidationError(f"{path.name}: WAV contains no audio")
    except (OSError, EOFError, wave.Error) as exc:
        raise ZSPValidationError(f"{path.name}: invalid RIFF/WAVE: {exc}") from exc


def create_zsp(build_dir: Path, destination: Path) -> None:
    project_path = build_dir / "project.json"
    audio_dir = build_dir / "audio_cache"
    temporary = destination.with_name(destination.name + ".tmp")
    temporary.unlink(missing_ok=True)
    try:
        with zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            archive.write(project_path, "project.json")
            # An explicit directory member matches the supplied reference archive.
            archive.writestr("audio_cache/", b"")
            for wav_path in sorted(audio_dir.glob("*.wav"), key=lambda p: p.name):
                archive.write(wav_path, f"audio_cache/{wav_path.name}")
        validate_zsp(temporary)
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def validate_zsp(path: Path) -> None:
    try:
        with zipfile.ZipFile(path, "r") as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise ZSPValidationError(f"ZIP CRC failed for {bad_member}")
            names = set(archive.namelist())
            if "project.json" not in names:
                raise ZSPValidationError("project.json is missing")
            if "audio_cache/" not in names:
                raise ZSPValidationError("audio_cache/ is missing")
            try:
                project = json.loads(archive.read("project.json").decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                raise ZSPValidationError(f"invalid project.json: {exc}") from exc
            if not isinstance(project, list) or not project:
                raise ZSPValidationError("project.json must be a non-empty array")

            for position, entry in enumerate(project, 1):
                if not isinstance(entry, dict) or tuple(entry.keys()) != PROJECT_FIELDS:
                    raise ZSPValidationError(
                        f"entry {position} must contain exactly the required fields in order"
                    )
                if isinstance(entry["index"], bool) or not isinstance(entry["index"], int):
                    raise ZSPValidationError(f"entry {position}: index must be an integer")
                for field in ("start", "end"):
                    value = entry[field]
                    if isinstance(value, bool) or not isinstance(value, (int, float)):
                        raise ZSPValidationError(f"entry {position}: {field} must be a number")
                for field in ("content", "speaker_name", "audio_filename"):
                    if not isinstance(entry[field], str):
                        raise ZSPValidationError(f"entry {position}: {field} must be a string")
                filename = entry["audio_filename"]
                if Path(filename).name != filename or not filename.lower().endswith(".wav"):
                    raise ZSPValidationError(f"entry {position}: unsafe audio filename")
                member = f"audio_cache/{filename}"
                if member not in names:
                    raise ZSPValidationError(f"entry {position}: {member} is missing")
                _validate_wav_bytes(archive.read(member), filename)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ZSPValidationError(f"invalid ZIP archive: {exc}") from exc


def _validate_wav_bytes(data: bytes, filename: str) -> None:
    import io

    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (
                wav.getcomptype() != "NONE"
                or wav.getnchannels() != 1
                or wav.getframerate() != 24_000
                or wav.getsampwidth() != 2
                or wav.getnframes() == 0
            ):
                raise ZSPValidationError(
                    f"{filename}: expected non-empty PCM, mono, 24000 Hz, 16-bit WAV"
                )
    except (EOFError, wave.Error) as exc:
        raise ZSPValidationError(f"{filename}: invalid RIFF/WAVE: {exc}") from exc
