import hashlib
from functools import reduce
from urllib.parse import urlencode

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]


def get_mixin_key(orig: str) -> str:
    return reduce(lambda s, i: s + orig[i], MIXIN_KEY_ENC_TAB, "")[:32]


def sign(params: dict, img_key: str, sub_key: str, wts: int) -> dict:
    mixin_key = get_mixin_key(img_key + sub_key)
    params = dict(sorted(params.items()))
    params["wts"] = wts
    filtered = {
        k: "".join(ch for ch in str(v) if ch not in "!'()*")
        for k, v in params.items()
    }
    query = urlencode(filtered)
    w_rid = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    params["w_rid"] = w_rid
    return params
