# SFX Converter

SFX Converter là ứng dụng Electron chạy trực tiếp từ source, nhận một video và xuất một
file WAV chất lượng cao chỉ chứa sound-effects stem:

```text
video -> FFmpeg audio extraction -> SFC-Locoformer Medium (DnR) -> SFX WAV
```

Dialogue và music bị loại bỏ. Output hiện có không bị ghi đè; ứng dụng tự thêm
`_1`, `_2`, ... vào tên file.

## Tính năng

- Xác minh media thật bằng FFprobe thay vì tin phần mở rộng.
- Tách audio đúng contract của model bằng FFmpeg.
- SFC-Locoformer Medium với checkpoint DnR được pin và checksum.
- Streaming inference theo segment 12 giây, overlap 6 giây.
- WAV 44.1 kHz mono, PCM 24-bit, tên `<video_name>_sfx.wav`.
- Electron UI responsive, light/dark theme, log và progress realtime.
- Hủy tác vụ an toàn, không cho chạy trùng, dọn child process khi đóng app.
- CUDA -> Apple MPS -> CPU; tự fallback CPU khi MPS không hỗ trợ operation.

## Kiến trúc

```text
Electron Renderer (HTML/CSS/state)
  -> window.sfxApi (Preload/contextBridge)
    -> IPC handlers (Electron Main)
      -> BackendProcess (Node child_process.spawn)
        -> Python JSON-lines sidecar
          -> SeparationService
            -> VideoService / AudioService (FFprobe + FFmpeg)
            -> SFCLocoformerEngine -> ModelManager
            -> ExportService
```

Renderer không có quyền truy cập Node.js. `contextIsolation` được bật,
`nodeIntegration` tắt và mọi file/folder picker đều chạy qua Electron Main.
Python sidecar sống trong toàn bộ session nên model đã load được tái sử dụng ở
lần chạy sau. Backend business logic trong `app/services`, `app/models` và
`app/utils` không bị chuyển sang JavaScript.

Giao thức giữa Main và Python là JSON Lines qua stdin/stdout. State, progress,
log, success, cancellation và error được stream ngay khi phát sinh; stderr cũng
được đưa vào log panel.

## Yêu cầu phát triển

- macOS Apple Silicon hoặc Intel
- Node.js 20 trở lên và npm
- Python 3.10-3.12
- FFmpeg và FFprobe trên `PATH`
- Khoảng 130 MB cho checkpoint, ngoài các dependency Python/PyTorch

```bash
brew install ffmpeg
```

## Cài đặt

Script tạo `.venv` trong project và không cài package vào Python hệ thống:

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

Để tải và checksum model ngay lúc setup:

```bash
./scripts/setup.sh --download-model
```

Nếu chưa tải, app sẽ tải model trong lần extract đầu. Có thể cấu hình các path:

- `SFX_CONVERTER_MODEL_DIR`: thư mục model.
- `SFX_CONVERTER_DATA_DIR`: dữ liệu ứng dụng.
- `SFX_CONVERTER_LOG_DIR`: file log.
- `SFX_CONVERTER_PYTHON`: Python executable dùng trong development.

## Chạy từ Terminal

Chỉ cần một terminal:

```bash
npm start
```

Electron tự mở Python từ `.venv/bin/python` (hoặc biến
`SFX_CONVERTER_PYTHON`) và quản lý vòng đời process.

Trong quá trình phát triển, `npm run dev` là alias tương đương của `npm start`.

Workflow:

1. Chọn video.
2. Giữ thư mục output tự chọn hoặc chọn thư mục khác.
3. Chọn **Extract SFX**.
4. Theo dõi progress/log, hoặc chọn **Hủy xử lý**.

## Model và audio contract

- Model: `locoformer-medium.enc-crossattn96dim.dec-crossattn96dim.musical64.learnable-query`
- Dataset: DnR
- Artifact revision: `0827e70a9e0c6f21b9b46cb9dfe4f7e4ebd307c5`
- Input: 44,100 Hz mono
- STFT: `n_fft=2048`, `hop_length=512`
- Source order: `speech`, `music`, `sfx`; chỉ giữ index 2
- Long-form inference: segment 12 giây, shift 6 giây
- Output: 44,100 Hz mono, PCM 24-bit WAV

Các giá trị, hash và revision được pin trong `app/settings.py`.

## Kiểm tra trực tiếp

```bash
npm run lint:syntax
.venv/bin/ruff check .
npm start
```

Sau khi mở ứng dụng, kiểm tra chọn video, thư mục output, trạng thái model,
start/cancel và file WAV xuất ra trực tiếp trong Electron.

## Cấu trúc project

```text
electron/
  main/          lifecycle, BrowserWindow, IPC và child-process service
  preload/       contextBridge API whitelist
  renderer/      HTML, CSS và UI state
  shared/        tên IPC channel dùng chung
app/
  backend.py     JSON-lines adapter cho Electron
  settings.py    cấu hình model/path
  models/        model manager và SFC-Locoformer adapter
  services/      pipeline nghiệp vụ audio/video/export
  utils/         FFmpeg, logging và path helpers
scripts/         setup và tải model
```

## Xử lý sự cố

- **Không mở được backend khi development:** chạy `./scripts/setup.sh`, hoặc đặt
  `SFX_CONVERTER_PYTHON` tới Python 3.10-3.12 có đủ dependency.
- **Không tìm thấy FFmpeg/FFprobe:** cài `brew install ffmpeg` và mở lại app từ
  terminal để kiểm tra `PATH`.
- **Model checksum sai:** xóa riêng artifact lỗi trong
  `SFX_CONVERTER_MODEL_DIR`; app sẽ tải lại bản pin.
- **MPS lỗi:** app log warning và tự chuyển model sang CPU. Lượt chạy đó sẽ chậm.
- **Log kỹ thuật:** ngoài log realtime trong UI, file `sfx-converter.log` nằm ở
  platform log directory.

## Upstream và license

Ứng dụng dùng implementation chính thức
`b-sigpro/spectral-feature-compression` và model artifact từ
`kohei0209/spectral_feature_compression`. Hãy tuân thủ license của model,
repository upstream, Electron, PyTorch, FFmpeg và các dependency liên quan.
