"""TTS engine selection without importing optional engines at startup."""

from __future__ import annotations

from typing import Any


VIENEU_MODEL = "vieneu"
MELOTTS_MODEL = "melotts"
DEFAULT_TTS_MODEL = VIENEU_MODEL


class TTSSelectionError(ValueError):
    pass


def normalize_model_name(value: object) -> str:
    text = str(value or DEFAULT_TTS_MODEL).strip().lower()
    aliases = {
        "vieneu": VIENEU_MODEL,
        "vieneu-tts v3 turbo": VIENEU_MODEL,
        "vieneu-tts-v3-turbo": VIENEU_MODEL,
        "melotts": MELOTTS_MODEL,
        "melo": MELOTTS_MODEL,
    }
    try:
        return aliases[text]
    except KeyError as exc:
        raise TTSSelectionError(
            f"Unknown TTS model {value!r}; choose VieNeu-TTS v3 Turbo or MeloTTS"
        ) from exc


def create_engine(
    model: object = DEFAULT_TTS_MODEL,
    *,
    melo_language: str = "EN",
    melo_speaker: str | None = None,
) -> Any:
    selected = normalize_model_name(model)
    if selected == VIENEU_MODEL:
        from studio.tts.vieneu_engine import TTSEngine

        return TTSEngine()
    from studio.tts.melotts_engine import MeloTTSEngine

    return MeloTTSEngine(language=melo_language, speaker=melo_speaker)


def needs_reference_audio(model: object) -> bool:
    return normalize_model_name(model) == VIENEU_MODEL
