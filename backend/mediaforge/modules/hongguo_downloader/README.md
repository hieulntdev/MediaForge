# Hongguo Downloader module

This module accepts public series and episode pages from `https://www.hongguoapp.cn/`.
The site adapter parses server-rendered series/player data and resolves direct
HTTP, HLS, or DASH sources without browser automation. It does not use cookies,
automate authentication, bypass access controls, or process encrypted HLS or
DRM-protected DASH.

Downloads run outside the renderer and use the shared MediaForge task/process
lifecycle. Persistent settings are stored separately from the session queue,
discovery results, logs, and HLS partials. Those transient values are reset on
the next MediaForge launch, while completed outputs and settings are retained.
The downloader remuxes without re-encoding and verifies completed outputs with
FFprobe.

Website layouts and public delivery mechanisms can change. Extraction errors
are surfaced in the Activity Log, while signed media URLs and authorization
data are excluded from persistent state and redacted from errors.
