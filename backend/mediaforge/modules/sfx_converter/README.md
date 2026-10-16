# SFX Converter module

SFX Converter validates a local video, extracts audio with FFmpeg, separates
the SFX stem with the pinned SFC-Locoformer model, and exports a non-overwriting
44.1 kHz mono PCM 24-bit WAV.

## Layout

```text
sfx_converter/
├── module.json
├── desktop-adapter.js
├── ui/
└── worker/
    ├── app/
    │   ├── backend.py       persistent JSON-lines worker
    │   ├── models/
    │   ├── services/
    │   └── utils/
    ├── scripts/download_model.py
    └── requirements.txt
```

The adapter launches `python -m app.backend` from `worker/` using the
isolated `sfx` runtime. Model storage, logs, and media tools are supplied by
the MediaForge shell. Model revision, checksums, and audio contract are defined
once in `model.json` and consumed by both JavaScript and Python; downloads
publish only verified artifacts.

Run MediaForge with `npm start`. Automated checks do not download the model or
perform inference. A release smoke test must cover model status/prefetch, valid
video selection, progress, cancellation, CPU/MPS fallback, output naming, and
FFprobe/playback verification.
