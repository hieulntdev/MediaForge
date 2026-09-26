import re
from pathlib import Path

SUPPORTED_SUFFIXES = {".txt", ".csv"}

_URL = re.compile(r"https?://[^\s,;\"'<>]+")


def read_links(path: Path) -> list[str]:
    """Return the unique http(s) links found in a .txt/.csv link list.

    Accepts one link per line (.txt) or a CSV with a URL column; anything that
    is not a link is ignored, so headers and comments are harmless.
    """
    path = Path(path)
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError(
            f"Unsupported file type '{path.suffix or path.name}'. Use .txt or .csv.")
    text = path.read_text(encoding="utf-8", errors="replace")

    links: list[str] = []
    seen: set[str] = set()
    for match in _URL.finditer(text):
        url = match.group(0).rstrip(".,;)")
        if url not in seen:
            seen.add(url)
            links.append(url)
    return links
