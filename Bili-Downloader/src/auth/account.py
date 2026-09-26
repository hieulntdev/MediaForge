import json
import urllib.request
from dataclasses import dataclass

from src.utils.logger import get_logger

log = get_logger()
NAV = "https://api.bilibili.com/x/web-interface/nav"


@dataclass
class AccountInfo:
    logged_in: bool
    username: str | None
    premium: bool
    cookie_valid: bool
    message: str


def check_account(cookies_file: str | None = None,
                  cookies_from_browser: str | None = None) -> AccountInfo:
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}
    cookie = _build_cookie_header(cookies_file)
    if cookie:
        headers["Cookie"] = cookie
    try:
        req = urllib.request.Request(NAV, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # network / JSON errors
        log.error("Check Account failed: %s", e)
        return AccountInfo(False, None, False, False, "Check Account failed (network error).")

    if payload.get("code") == -101:
        return AccountInfo(False, None, False, False, "Cookie expired. Please refresh.")
    data = payload.get("data") or {}
    is_login = bool(data.get("isLogin"))
    uname = data.get("uname")
    vip_type = data.get("vipType")
    premium = vip_type == 1
    return AccountInfo(
        logged_in=is_login,
        username=uname if is_login else None,
        premium=premium,
        cookie_valid=payload.get("code") == 0,
        message="Logged in" if is_login else "Not logged in",
    )


def _build_cookie_header(cookies_file: str | None) -> str:
    if not cookies_file:
        return ""
    try:
        with open(cookies_file) as f:
            rows = [l.rstrip("\n").split("\t") for l in f
                    if l.strip() and not l.startswith("#")]
        return "; ".join(f"{c[5]}={c[6]}" for c in rows if len(c) >= 7)
    except OSError:
        return ""
