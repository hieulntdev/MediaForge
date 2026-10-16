# Bili Downloader module

The module analyzes Bilibili URLs, checks Netscape-format cookies, selects the
best accessible video/audio streams, downloads optional subtitles, remuxes with
FFmpeg, and verifies output with FFprobe.

## Layout

```text
bili_downloader/
├── module.json
├── desktop-adapter.js
├── ui/                    renderer and download-state projection
└── worker/
    ├── backend_entry.py   persistent JSON-lines worker
    ├── requirements.txt
    └── src/               auth, extractors, models, pipeline and utilities
```

The adapter launches `worker/backend_entry.py` with the `base` runtime and
`worker/` as its working directory. Both adapter reset and worker settings use
the canonical `defaults.json`. Mutable data is redirected to Electron
`userData` through `MEDIAFORGE_DATA_DIR`; FFmpeg/FFprobe paths are injected by
the shell.

Run MediaForge from the repository root with `npm start`. For lightweight
verification use `npm run check`, `npm test`, and:

```bash
PYTHONPATH=backend/mediaforge/modules/bili_downloader/worker \
  runtimes/envs/base/bin/python -c 'from src.settings import DEFAULT_SETTINGS'
```

Real cookie checks, analysis, downloads, pause/resume/cancel, subtitle output,
and FFprobe verification require a manual smoke test with authorized inputs.
