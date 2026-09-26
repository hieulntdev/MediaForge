from src.extractors.wbi import get_mixin_key, sign

IMG_KEY = "7cd084941338484aae1ad9425b84077c"
SUB_KEY = "4932caff0ff746eab6f01bf08b70ac45"


def test_mixin_key_permutation_pinned():
    # Pinned from the reference WBI implementation. Guards against table drift.
    assert get_mixin_key(IMG_KEY + SUB_KEY) == "ea1db124af3c7062474693fa704f4ff8"


def test_w_rid_pinned():
    params = {"bvid": "BV1xx411c7mD", "cid": "12345", "fnval": "4048"}
    signed = sign(dict(params), IMG_KEY, SUB_KEY, wts=1700000000)
    assert signed["wts"] == 1700000000
    assert signed["w_rid"] == "5476ef06c9d531c5940963a4412dfdae"


def test_sign_sorts_keys_deterministically():
    p1 = sign({"cid": "1", "bvid": "BVx"}, IMG_KEY, SUB_KEY, wts=1)
    p2 = sign({"bvid": "BVx", "cid": "1"}, IMG_KEY, SUB_KEY, wts=1)
    assert p1["w_rid"] == p2["w_rid"]
