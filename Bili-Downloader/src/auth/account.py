from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum
from typing import Any

from src.auth.cookies import (
    CookieFileError,
    build_cookie_header,
    is_bilibili_cookie,
    is_expired,
    read_netscape,
)
from src.utils.logger import get_logger

log = get_logger()
NAV = "https://api.bilibili.com/x/web-interface/nav"
AUTH_COOKIE = "SESSDATA"
REQUEST_TIMEOUT = 15
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


class CookieStatus(str, Enum):
    VALID = "VALID"
    EXPIRED = "EXPIRED"
    INVALID = "INVALID"
    FILE_ERROR = "FILE_ERROR"
    NETWORK_ERROR = "NETWORK_ERROR"
    TIMEOUT = "TIMEOUT"
    RATE_LIMITED = "RATE_LIMITED"
    SERVER_ERROR = "SERVER_ERROR"
    UNKNOWN = "UNKNOWN"


STATUS_MESSAGES = {
    CookieStatus.VALID: "Cookie is valid. Authentication successful.",
    CookieStatus.EXPIRED: "Cookie has expired. Please refresh your cookies.",
    CookieStatus.INVALID: "Cookie authentication failed. Please check your cookie file.",
    CookieStatus.FILE_ERROR: "Unable to read or parse the cookie file.",
    CookieStatus.NETWORK_ERROR: "Unable to connect to Bilibili. Check your network connection.",
    CookieStatus.TIMEOUT: "Cookie verification timed out. Please try again.",
    CookieStatus.RATE_LIMITED: "Bilibili is temporarily limiting requests. Please try again later.",
    CookieStatus.SERVER_ERROR: "Bilibili server error. Cookie validity could not be verified.",
    CookieStatus.UNKNOWN: "Unable to determine cookie status. Check the logs for details.",
}


@dataclass
class AccountInfo:
    logged_in: bool
    username: str | None
    premium: bool
    cookie_valid: bool
    message: str
    status: CookieStatus = CookieStatus.UNKNOWN
    http_status: int | None = None
    api_code: int | str | None = None


def _result(
    status: CookieStatus,
    reason: str,
    *,
    stage: str,
    logged_in: bool = False,
    username: str | None = None,
    premium: bool = False,
    http_status: int | None = None,
    api_code: int | str | None = None,
) -> AccountInfo:
    level = "info" if status is CookieStatus.VALID else "warning"
    getattr(log, level)(
        "Cookie verification: stage=%s status=%s http_status=%s "
        "api_code=%s reason=%s",
        stage,
        status.value,
        http_status if http_status is not None else "none",
        api_code if api_code is not None else "none",
        reason,
    )
    return AccountInfo(
        logged_in=logged_in,
        username=username if logged_in else None,
        premium=premium,
        cookie_valid=status is CookieStatus.VALID,
        message=STATUS_MESSAGES[status],
        status=status,
        http_status=http_status,
        api_code=api_code,
    )


def _parse_response(raw: bytes) -> dict[str, Any] | None:
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _response_result(payload: dict[str, Any] | None, http_status: int) -> AccountInfo:
    api_code = payload.get("code") if payload is not None else None
    data = payload.get("data") if payload is not None else None
    data = data if isinstance(data, dict) else {}

    if http_status == 429:
        return _result(
            CookieStatus.RATE_LIMITED,
            "HTTP rate limit response",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    if http_status in {408, 504}:
        return _result(
            CookieStatus.TIMEOUT,
            "HTTP timeout response",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    if 500 <= http_status:
        return _result(
            CookieStatus.SERVER_ERROR,
            "Bilibili returned a server error",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    # -101 means "not logged in". It does not distinguish a missing,
    # rejected, revoked, or expired cookie, so it must not map to EXPIRED.
    if api_code == -101:
        return _result(
            CookieStatus.INVALID,
            "Bilibili reported that the request is not logged in",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    if http_status == 401:
        return _result(
            CookieStatus.INVALID,
            "HTTP authentication was rejected",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    if http_status == 403:
        return _result(
            CookieStatus.UNKNOWN,
            "HTTP access was forbidden without a conclusive authentication response",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    if not 200 <= http_status < 300:
        return _result(
            CookieStatus.UNKNOWN,
            "unexpected HTTP response",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )

    if payload is None:
        return _result(
            CookieStatus.UNKNOWN,
            "response body was not a JSON object",
            stage="authentication",
            http_status=http_status,
        )

    is_login = data.get("isLogin")
    if api_code == 0 and is_login is True:
        vip_type = data.get("vipType")
        return _result(
            CookieStatus.VALID,
            "API confirmed an authenticated session",
            stage="authentication",
            logged_in=True,
            username=data.get("uname") if isinstance(data.get("uname"), str) else None,
            premium=vip_type in {1, 2},
            http_status=http_status,
            api_code=api_code,
        )
    if api_code == 0 and is_login is False:
        return _result(
            CookieStatus.INVALID,
            "API returned isLogin=false",
            stage="authentication",
            http_status=http_status,
            api_code=api_code,
        )
    return _result(
        CookieStatus.UNKNOWN,
        "unexpected Bilibili business response",
        stage="authentication",
        http_status=http_status,
        api_code=api_code,
    )


def check_account(cookies_file: str | None = None,
                  cookies_from_browser: str | None = None) -> AccountInfo:
    if not cookies_file:
        reason = (
            "browser cookie extraction is not supported by account verification"
            if cookies_from_browser
            else "no cookie file was provided"
        )
        return _result(CookieStatus.FILE_ERROR, reason, stage="file_validation")

    try:
        cookies = read_netscape(cookies_file)
    except CookieFileError as error:
        cause = error.__cause__
        detail = f"{error}; error_type={type(cause or error).__name__}"
        return _result(CookieStatus.FILE_ERROR, detail, stage="file_validation")

    auth_cookies = [
        cookie for cookie in cookies
        if cookie.get("name") == AUTH_COOKIE and is_bilibili_cookie(cookie)
    ]
    if not auth_cookies:
        return _result(
            CookieStatus.INVALID,
            f"required authentication cookie {AUTH_COOKIE} is missing",
            stage="expiration_check",
        )
    if all(is_expired(cookie) for cookie in auth_cookies):
        return _result(
            CookieStatus.EXPIRED,
            f"all {AUTH_COOKIE} cookies have an expired timestamp",
            stage="expiration_check",
        )

    cookie_header = build_cookie_header(cookies, request_path="/x/web-interface/nav")
    if not cookie_header:
        return _result(
            CookieStatus.INVALID,
            "no usable Bilibili cookies remain after validation",
            stage="expiration_check",
        )

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Cookie": cookie_header,
        "Referer": "https://www.bilibili.com/",
        "User-Agent": USER_AGENT,
    }
    try:
        req = urllib.request.Request(NAV, headers=headers)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
            response_status = getattr(response, "status", None)
            status = int(response_status if response_status is not None else response.getcode())
            payload = _parse_response(response.read())
        return _response_result(payload, status)
    except urllib.error.HTTPError as error:
        # HTTPError bodies often contain the useful Bilibili business code.
        try:
            payload = _parse_response(error.read())
        except (OSError, ValueError):
            payload = None
        return _response_result(payload, int(error.code))
    except (TimeoutError, socket.timeout):
        return _result(
            CookieStatus.TIMEOUT,
            "request exceeded the verification timeout",
            stage="authentication",
        )
    except urllib.error.URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            return _result(
                CookieStatus.TIMEOUT,
                "URL request timed out",
                stage="authentication",
            )
        return _result(
            CookieStatus.NETWORK_ERROR,
            f"connection failed; error_type={type(error.reason).__name__}",
            stage="authentication",
        )
    except OSError as error:
        return _result(
            CookieStatus.NETWORK_ERROR,
            f"connection failed; error_type={type(error).__name__}",
            stage="authentication",
        )
    except Exception as error:  # noqa: BLE001 - unknown failures stay UNKNOWN
        return _result(
            CookieStatus.UNKNOWN,
            f"unexpected verification error; error_type={type(error).__name__}",
            stage="authentication",
        )


def _build_cookie_header(cookies_file: str | None) -> str:
    if not cookies_file:
        return ""
    return build_cookie_header(read_netscape(cookies_file))
