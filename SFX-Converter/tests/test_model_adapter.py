from app.models.sfc_locoformer import SFCLocoformerEngine


def test_adapter_prefers_upstream_ema_inference_weights() -> None:
    state = {
        "model.layer": "base",
        "ema_model.module.layer": "ema",
        "ema_model.module.n_averaged": 3,
    }
    assert SFCLocoformerEngine._inference_state_dict(state) == {"layer": "ema"}


def test_adapter_accepts_lightning_state_dict_wrapper() -> None:
    checkpoint = {"state_dict": {"model.layer": 1}}
    assert SFCLocoformerEngine._inference_state_dict(checkpoint) == {"layer": 1}
