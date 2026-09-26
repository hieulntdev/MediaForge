from __future__ import annotations

import sys
import unicodedata
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from studio.asr.compare import ContentCheck, compare, normalize, similarity, word_error_rate


class NormalizeTests(unittest.TestCase):
    def test_lowercases_and_strips_punctuation(self) -> None:
        self.assertEqual(normalize("Xin chào, các bạn!"), "xin chào các bạn")

    def test_collapses_whitespace(self) -> None:
        self.assertEqual(normalize("một   hai\tba"), "một hai ba")

    def test_keeps_vietnamese_tone_marks(self) -> None:
        # Tone marks change meaning; normalization must not strip diacritics.
        self.assertIn("chào", normalize("Xin chào"))
        self.assertNotEqual(normalize("ma"), normalize("mà"))

    def test_preserves_tone_marks_on_nfd_input(self) -> None:
        # NFD-decomposed Vietnamese input (base + combining accent as separate codepoints)
        # should have tone marks preserved after normalization (not silently dropped by regex).
        nfd_input = unicodedata.normalize("NFD", "mà")
        nfc_input = unicodedata.normalize("NFC", "mà")
        # Both should normalize to the same NFC form with tone mark intact.
        self.assertEqual(normalize(nfd_input), normalize(nfc_input))
        # Verify the result actually contains the tone-marked form, not "ma".
        self.assertNotEqual(normalize(nfd_input), normalize("ma"))


class WordErrorRateTests(unittest.TestCase):
    def test_identical_text_has_zero_wer(self) -> None:
        self.assertEqual(word_error_rate("một hai ba", "một hai ba"), 0.0)

    def test_one_substitution_out_of_three_words(self) -> None:
        self.assertAlmostEqual(word_error_rate("một hai ba", "một hai bốn"), 1 / 3)

    def test_missing_word_counts_as_an_error(self) -> None:
        self.assertAlmostEqual(word_error_rate("một hai ba", "một ba"), 1 / 3)

    def test_empty_reference_with_empty_hypothesis_is_zero(self) -> None:
        self.assertEqual(word_error_rate("", ""), 0.0)


class SimilarityTests(unittest.TestCase):
    def test_similarity_partial_match(self) -> None:
        # Partial (non-identical, non-empty) match should return ratio between 0 and 1 exclusive.
        result = similarity("một hai ba", "một hai bốn")
        self.assertGreater(result, 0.0)
        self.assertLess(result, 1.0)

    def test_similarity_identical_strings(self) -> None:
        # Identical strings should have ratio of 1.0.
        self.assertEqual(similarity("một hai ba", "một hai ba"), 1.0)

    def test_similarity_completely_different_strings(self) -> None:
        # Completely different strings should have ratio of 0.0.
        self.assertEqual(similarity("abc", "xyz"), 0.0)


class CompareTests(unittest.TestCase):
    def test_matching_transcript_is_content_ok(self) -> None:
        result = compare("Xin chào các bạn", "xin chào các bạn")
        self.assertEqual(result.status, "CONTENT_OK")
        self.assertGreaterEqual(result.similarity, 0.90)

    def test_transcript_missing_most_words_is_content_missing(self) -> None:
        result = compare(
            "Hôm nay trời đẹp và tôi rất vui khi được đi chơi cùng bạn bè",
            "hôm nay",
        )
        self.assertEqual(result.status, "CONTENT_MISSING")

    def test_transcript_with_repeated_phrase_is_content_repeated(self) -> None:
        result = compare(
            "tôi thích ăn kem vào buổi tối",
            "tôi thích ăn kem tôi thích ăn kem vào buổi tối",
        )
        self.assertEqual(result.status, "CONTENT_REPEATED")

    def test_result_is_a_content_check(self) -> None:
        result = compare("một hai ba", "một hai ba")
        self.assertIsInstance(result, ContentCheck)

    def test_transcript_with_extra_hallucinated_content_is_content_hallucination(
        self,
    ) -> None:
        # Reference is much shorter; transcript is longer with unrelated extra content.
        # This should trigger CONTENT_HALLUCINATION (ratio > 1.3 and similarity < 0.90).
        result = compare("một hai", "một hai ba bốn năm sáu bảy tám chín mười")
        self.assertEqual(result.status, "CONTENT_HALLUCINATION")

    def test_transcript_with_wrong_content_is_content_wrong(self) -> None:
        # Same word count as reference but completely different content,
        # not triggering MISSING/REPEATED/HALLUCINATION.
        result = compare("tôi thích ăn phở", "hôm nay trời mưa to")
        self.assertEqual(result.status, "CONTENT_WRONG")

    def test_short_line_tolerates_one_word_asr_mishearing(self) -> None:
        # A fixed 10% WER ceiling gives zero tolerance below ~10 words, so a
        # correctly spoken 3-word line where the ASR mishears one tone-marked
        # word ("Sáng" heard as "Sẵn") must not be flagged CONTENT_WRONG.
        result = compare("Sáng hôm sau,", "Sẵn hôm sau!")
        self.assertEqual(result.status, "CONTENT_OK")

    def test_short_line_with_two_wrong_words_out_of_three_stays_content_wrong(self) -> None:
        # The relaxed short-line tolerance must still catch a genuinely wrong
        # take, not just rubber-stamp every short line.
        result = compare("một hai ba", "bốn năm ba")
        self.assertEqual(result.status, "CONTENT_WRONG")

    def test_longer_line_tolerates_one_word_asr_mishearing(self) -> None:
        # Same tone-mark mishearing pattern on an 8-word line ("tỉnh" heard
        # as "tình") -- one wrong word should not sink a line this long.
        result = compare(
            "tôi lại tỉnh dậy trên chính giường mình.",
            "tôi lại tình dậy trên chính giường mình.",
        )
        self.assertEqual(result.status, "CONTENT_OK")

    def test_longer_line_with_two_wrong_words_stays_content_wrong(self) -> None:
        # Two words wrong out of eight (25%) is still a meaningfully
        # different transcript, not ASR noise -- the tolerance must not
        # stretch this far.
        result = compare(
            "tôi lại tỉnh dậy trên chính giường mình.",
            "tôi lại tình dạy trên chính giường mình.",
        )
        self.assertEqual(result.status, "CONTENT_WRONG")

    def test_short_line_with_one_inserted_word_is_not_content_ok(self) -> None:
        # A single word tacked onto an otherwise-correct 10-word line sits
        # exactly inside the short-line mishearing budget (1 word / 10) --
        # but this is TTS speaking extra content, not ASR mishearing an
        # existing word, so it must never pass as CONTENT_OK.
        result = compare(
            "định cho cô ấy xem lại đoạn mình đã quay",
            "định cho cô ấy xem lại đoạn mình đã quay phô",
        )
        self.assertNotEqual(result.status, "CONTENT_OK")
