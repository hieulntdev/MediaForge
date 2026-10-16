import logging
import re
from logging.handlers import RotatingFileHandler

from src.utils.paths import LOGS_DIR, ensure_dirs


def mask_secrets(text: str) -> str:
    """Replace the value of any secret key with *** and blank Cookie headers."""
    secret_names = (
        r"SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|bili_ticket|"
        r"access_token|refresh_token|authorization|password|passwd"
    )
    # key=value or key:value -> key=***
    text = re.sub(
        rf"(?i)(\b(?:{secret_names})\b\s*[=:\t]\s*)[^\s&;,]+",
        r"\1***",
        text,
    )
    # JSON-style quoted keys, for example {"SESSDATA": "secret"}.
    text = re.sub(
        rf'(?i)(["\'](?:{secret_names})["\']\s*:\s*["\'])[^"\']*',
        r"\1***",
        text,
    )
    # whole Cookie: header -> Cookie: ***
    text = re.sub(r"(?i)(Cookie\s*:\s*).*", r"\1***", text)
    # Authorization headers may not use a key=value shape.
    text = re.sub(r"(?i)(Authorization\s*:\s*).*", r"\1***", text)
    return text


class _SecretFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = mask_secrets(record.getMessage())
        record.args = ()
        return True


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
    if not any(isinstance(item, _SecretFilter) for item in logger.filters):
        logger.addFilter(_SecretFilter())

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
