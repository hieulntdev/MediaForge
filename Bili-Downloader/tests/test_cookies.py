from src.auth.cookies import is_expired, parse_netscape

NETSCAPE = """# Netscape HTTP Cookie File
# This is a comment
.bilibili.com\tTRUE\t/\tFALSE\t4102444800\tSESSDATA\tabc123
.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\txyz789
"""


def test_parse_netscape_skips_comments():
    cookies = parse_netscape(NETSCAPE)
    assert len(cookies) == 2
    assert cookies[0]["name"] == "SESSDATA"
    assert cookies[0]["value"] == "abc123"
    assert cookies[0]["domain"] == ".bilibili.com"


def test_parse_netscape_expiry_epoch():
    cookies = parse_netscape(NETSCAPE)
    assert cookies[0]["expires"] == 4102444800


def test_session_cookie_expires_zero():
    cookies = parse_netscape(NETSCAPE)
    assert cookies[1]["expires"] == 0


def test_is_expired_past():
    assert is_expired({"expires": 1000}, now=2000) is True


def test_is_expired_future_and_session():
    assert is_expired({"expires": 3000}, now=2000) is False
    assert is_expired({"expires": 0}, now=2000) is False
