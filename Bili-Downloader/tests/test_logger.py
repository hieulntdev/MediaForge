from src.utils.logger import mask_secrets


def test_masks_sessdata_key_value():
    line = "cookie SESSDATA=abc123def456; path=/"
    assert "abc123def456" not in mask_secrets(line)


def test_masks_bili_jct_and_tokens():
    line = "bili_jct=xyz789 access_token=topsecret refresh_token=refreshme"
    out = mask_secrets(line)
    for secret in ("xyz789", "topsecret", "refreshme"):
        assert secret not in out


def test_masks_password_colon():
    line = "password:hunter2"
    assert "hunter2" not in mask_secrets(line)


def test_masks_cookie_header_entirely():
    line = "Cookie: SESSDATA=aaa; bili_jct=bbb"
    out = mask_secrets(line)
    assert "SESSDATA" not in out or "aaa" not in out


def test_keeps_normal_text():
    line = "[INFO] Starting download of BV1xx411c7mD"
    assert mask_secrets(line) == line
