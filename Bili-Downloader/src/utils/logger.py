import logging
import re
from logging.handlers import RotatingFileHandler

from src.utils.paths import LOGS_DIR, ensure_dirs


def mask_secrets(text: str) -> str:
    """Replace the value of any secret key with *** and blank Cookie headers."""
    # key=value or key:value -> key=***
    text = re.sub(
        r"(?i)(\b(?:SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|access_token|refresh_token|password|passwd)\b\s*[=:]\s*)[^\s&;,]+",
        r"\1***",
        text,
    )
    # whole Cookie: header -> Cookie: ***
    text = re.sub(r"(?i)(Cookie\s*:\s*).*", r"\1***", text)
    return text


_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is None:
        _logger = setup_logging()
    return _logger


def setup_logging() -> logging.Logger:
    ensure_dirs()
    logger = logging.getLogger("bilibili-downloader")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    fmt = logging.Formatter("[%(asctime)s] %(levelname)s  %(message)s", "%H:%M:%S")
    if not any(isinstance(h, logging.StreamHandler) for h in logger.handlers):
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        logger.addHandler(sh)
    if not any(isinstance(h, RotatingFileHandler) for h in logger.handlers):
        fh = RotatingFileHandler(LOGS_DIR / "app.log", maxBytes=1_000_000, backupCount=3)
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    return logger
