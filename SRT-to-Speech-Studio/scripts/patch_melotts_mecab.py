#!/usr/bin/env python3
"""Make Japanese and Korean MeCab bindings coexist on macOS.

The two distributions use package directory names that differ only by case:
``MeCab`` and ``mecab``. The default macOS filesystem merges those directories.
Keep mecab-python3's public ``MeCab`` package, then point g2pkk and the Korean
wrapper directly at the Korean submodules that remain in that shared directory.
"""

from __future__ import annotations

from importlib.metadata import distribution
from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text(encoding="utf-8")
    if new in source:
        return
    if old not in source:
        raise RuntimeError(f"expected MeloTTS compatibility target not found in {path}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


def main() -> None:
    g2pkk = Path(distribution("g2pkk").locate_file("g2pkk/g2pkk.py"))
    korean_mecab = Path(
        distribution("python-mecab-ko").locate_file("mecab/mecab.py")
    )

    replace_once(
        g2pkk,
        'importlib.util.find_spec("mecab")',
        'importlib.util.find_spec("MeCab.mecab")',
    )
    replace_once(
        g2pkk,
        "m = self.load_module_func('mecab')\n                return m.MeCab()",
        "from MeCab.mecab import MeCab\n                return MeCab()",
    )
    replace_once(
        korean_mecab,
        "from mecab.types import Dictionary, Morpheme",
        "from MeCab.types import Dictionary, Morpheme",
    )
    replace_once(
        korean_mecab,
        "from mecab.utils import create_lattice, ensure_list, to_csv",
        "from MeCab.utils import create_lattice, ensure_list, to_csv",
    )
    print("MeCab compatibility patch: ready")


if __name__ == "__main__":
    main()
