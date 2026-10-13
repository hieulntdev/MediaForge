from __future__ import annotations

import re
import time
from pathlib import Path


HTTP_ONLY_PREFIX = "#HttpOnly_"
SUPPORTED_BROWSERS = {"chrome", "chromium", "edge", "firefox", "safari"}
_COOKIE_NAME = re.compile(r'^[^\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]+$')


class CookieFileError(ValueError):
    """The selected cookie file cannot be read or parsed as Netscape cookies."""


def _normalise_expiry(value: str, line_number: int) -> int:
    if not value:
        return 0
    try:
        expiry = int(value)
    except ValueError as error:
        raise CookieFileError(
            f"line {line_number}: expiration must be a Unix timestamp"
        ) from error

    if expiry <= 0:
        return 0

    # Netscape stores seconds. Some exporters accidentally write milliseconds
    # (or microseconds), so reduce only values that cannot reasonably be a
    # seconds timestamp. This avoids treating a far-future cookie as expired.
    while expiry > 100_000_000_000:
        expiry //= 1000
    return expiry


def parse_netscape(text: str) -> list[dict]:
    """Parse Netscape cookies without discarding HttpOnly or session cookies.

    ``#HttpOnly_`` is a data prefix used by Netscape cookie files, not a
    comment. Other comment lines are ignored. Malformed data rows fail the
    whole parse so callers can report a file error rather than silently making
    an authentication request with a partial cookie set.
    """

    cookies: list[dict] = []
    for line_number, source_line in enumerate(text.splitlines(), start=1):
        line = source_line.rstrip("\r\n")
        if not line.strip():
            continue

        http_only = line.startswith(HTTP_ONLY_PREFIX)
        if http_only:
            line = line[len(HTTP_ONLY_PREFIX):]
        elif line.startswith("#"):
            continue

        parts = line.split("\t", 6)
        if len(parts) != 7:
            raise CookieFileError(
                f"line {line_number}: expected 7 tab-separated Netscape fields"
            )

        domain, flag, path, secure, expiry, name, value = parts
        if not domain or not name or not _COOKIE_NAME.fullmatch(name):
            raise CookieFileError(f"line {line_number}: invalid cookie domain or name")
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            raise CookieFileError(f"line {line_number}: invalid cookie value")

        cookies.append({
            "domain": domain,
            "include_subdomains": flag.upper() == "TRUE",
            "path": path or "/",
            "secure": secure.upper() == "TRUE",
            "expires": _normalise_expiry(expiry, line_number),
            "name": name,
            "value": value,
            "http_only": http_only,
        })
    return cookies


def read_netscape(path: str | Path) -> list[dict]:
    cookie_path = Path(path)
    try:
        text = cookie_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise CookieFileError("unable to read the cookie file") from error

    cookies = parse_netscape(text)
    if not cookies:
        raise CookieFileError("the cookie file contains no cookie entries")
    return cookies


def is_expired(cookie: dict, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    expiry = cookie.get("expires", 0)
    return expiry > 0 and expiry <= now


def is_bilibili_cookie(cookie: dict) -> bool:
    domain = str(cookie.get("domain") or "").lstrip(".").lower()
    return domain == "bilibili.com" or domain.endswith(".bilibili.com")


def build_cookie_header(
    cookies: list[dict],
    *,
    now: float | None = None,
    request_path: str = "/",
) -> str:
    """Build an HTTPS Bilibili Cookie header from usable Netscape entries."""

    now = time.time() if now is None else now
    values = []
    for cookie in cookies:
        cookie_path = str(cookie.get("path") or "/")
        if not is_bilibili_cookie(cookie):
            continue
        if not request_path.startswith(cookie_path):
            continue
        if is_expired(cookie, now):
            continue
        values.append(f"{cookie['name']}={cookie['value']}")
    return "; ".join(values)


def load_netscape_path(path: Path) -> str:
    # yt-dlp accepts a Netscape cookies.txt directly via --cookies.
    return str(path)


def browser_arg(browser: str) -> str | None:
    name = (browser or "").strip().lower()
    return name if name in SUPPORTED_BROWSERS else None
