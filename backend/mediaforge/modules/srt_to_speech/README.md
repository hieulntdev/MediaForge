# SRT-to-Speech module

This module parses SRT files, synthesizes each cue with VieNeu-TTS or MeloTTS,
optionally validates speech content, supports cue retry/preview, and packages a
validated `.zsp` project.

## Layout

```text
srt_to_speech/
├── module.json
├── desktop-adapter.js
├── ui/
└── worker/
    ├── backend_entry.py
    ├── studio/              parser, pipeline, ASR, TTS and ZSP logic
    ├── scripts/             MeloTTS compatibility patch
    ├── requirements.txt
    └── requirements-melotts.txt
```

The adapter runs `worker/backend_entry.py` as a one-shot process. VieNeu and
MeloTTS use separate `tts-vieneu` and `tts-melotts` runtimes because their
PyTorch, NumPy, Transformers and tokenizer stacks conflict. Do not merge them.
Retry data is application-owned and session-scoped; completed `.zsp` files
are user-owned and survive cleanup.

Run MediaForge with `npm start`. Automated checks cover source imports and UI
contracts without loading models. Release validation must exercise SRT
validation, both configured model paths where available, synthesis, content
validation, retry, preview, cancellation, duration matching, and ZSP output.
