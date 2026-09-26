"""Normalize ASR transcripts and compare them against SRT text.

Stdlib-only (difflib for similarity, a hand-rolled word-level Levenshtein for
WER) so no extra dependency (jiwer, python-Levenshtein) is needed beyond
faster-whisper itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import re
import unicodedata

CONTENT_SIMILARITY_THRESHOLD = 0.90
CONTENT_WER_THRESHOLD = 0.10
CONTENT_MISSING_RATIO = 0.7
CONTENT_HALLUCINATION_RATIO = 1.3

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Lowercase, drop punctuation, collapse whitespace. Keeps tone marks."""
    # Normalize to NFC form to ensure combining accents are precomposed,
    # so they are preserved by the punctuation-stripping regex.
    text = unicodedata.normalize("NFC", text)
    text = text.strip().lower()
    text = _PUNCT_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text)
    return text.strip()


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def word_error_rate(reference: str, hypothesis: str) -> float:
    """Word-level Levenshtein distance divided by reference word count."""
    ref_words = reference.split()
    hyp_words = hypothesis.split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    rows, cols = len(ref_words) + 1, len(hyp_words) + 1
    distance = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        distance[i][0] = i
    for j in range(cols):
        distance[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            if ref_words[i - 1] == hyp_words[j - 1]:
                distance[i][j] = distance[i - 1][j - 1]
            else:
                distance[i][j] = 1 + min(
                    distance[i - 1][j], distance[i][j - 1], distance[i - 1][j - 1]
                )
    return distance[-1][-1] / len(ref_words)


@dataclass(frozen=True)
class ContentCheck:
    status: str
    similarity: float
    wer: float


def _has_repeated_ngram(words: list[str], n: int = 3) -> bool:
    if len(words) < n * 2:
        return False
    seen: dict[tuple[str, ...], int] = {}
    for i in range(len(words) - n + 1):
        gram = tuple(words[i:i + n])
        seen[gram] = seen.get(gram, 0) + 1
        if seen[gram] > 1:
            return True
    return False


def _short_line_tolerance(word_count: int) -> tuple[float, float]:
    """Similarity floor and WER ceiling to accept, scaled for short lines.

    A fixed 10% WER ceiling gives zero tolerance below ~10 words: any single
    word faster-whisper mishears (tone-mark confusion is common) already
    exceeds it, false-flagging a correctly spoken short line as
    CONTENT_WRONG. Scale the ceiling so at least one word of edit distance is
    always tolerated, and derive the similarity floor from the same
    tolerance so both gates agree on what "one word wrong" means.
    """
    if word_count <= 1:
        # A single-word reference has no partial-credit middle ground: "at
        # least one word tolerated" would mean any transcript passes.
        return CONTENT_SIMILARITY_THRESHOLD, CONTENT_WER_THRESHOLD
    allowed_errors = min(word_count - 1, max(1, round(CONTENT_WER_THRESHOLD * word_count)))
    wer_ceiling = max(CONTENT_WER_THRESHOLD, allowed_errors / word_count)
    similarity_floor = min(CONTENT_SIMILARITY_THRESHOLD, 1 - wer_ceiling)
    return similarity_floor, wer_ceiling


def compare(srt_text: str, transcript: str) -> ContentCheck:
    reference = normalize(srt_text)
    hypothesis = normalize(transcript)
    sim = similarity(reference, hypothesis)
    wer = word_error_rate(reference, hypothesis)
    ref_words = reference.split()
    hyp_words = hypothesis.split()
    # A transcript with MORE words than the reference contains speech the
    # reference doesn't -- an inserted/extra word, not an ASR mishearing --
    # so it never qualifies for the short-line tolerance below. Without this
    # guard, a single inserted word on a ~10-word line lands exactly on the
    # same WER/similarity budget the tolerance grants for a mis-heard word,
    # letting an actually-wrong take pass as CONTENT_OK.
    if len(hyp_words) <= len(ref_words):
        similarity_floor, wer_ceiling = _short_line_tolerance(len(ref_words))
        if sim >= similarity_floor and wer <= wer_ceiling:
            return ContentCheck(status="CONTENT_OK", similarity=sim, wer=wer)

    ratio = (len(hyp_words) / len(ref_words)) if ref_words else 1.0
    if ratio < CONTENT_MISSING_RATIO:
        status = "CONTENT_MISSING"
    elif _has_repeated_ngram(hyp_words):
        status = "CONTENT_REPEATED"
    elif ratio > CONTENT_HALLUCINATION_RATIO and sim < CONTENT_SIMILARITY_THRESHOLD:
        status = "CONTENT_HALLUCINATION"
    else:
        status = "CONTENT_WRONG"
    return ContentCheck(status=status, similarity=sim, wer=wer)
