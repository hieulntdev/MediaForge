from pathlib import Path


def parse_netscape(text: str) -> list[dict]:
    cookies = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, flag, path, secure, expiry, name, value = parts[:7]
        cookies.append({
            "domain": domain,
            "include_subdomains": flag.upper() == "TRUE",
            "path": path,
            "secure": secure.upper() == "TRUE",
            "expires": int(expiry) if expiry else 0,
            "name": name,
            "value": value,
        })
    return cookies


def is_expired(cookie: dict, now: float | None = None) -> bool:
    import time
    now = time.time() if now is None else now
    expiry = cookie.get("expires", 0)
    return expiry > 0 and expiry < now


def load_netscape_path(path: Path) -> str:
    # yt-dlp accepts a Netscape cookies.txt directly via --cookies
    return str(path)


SUPPORTED_BROWSERS = {"chrome", "chromium", "edge", "firefox", "safari"}


def browser_arg(browser: str) -> str | None:
    name = (browser or "").strip().lower()
    return name if name in SUPPORTED_BROWSERS else None
