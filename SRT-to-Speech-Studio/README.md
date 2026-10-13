# SRT-to-Speech Studio

## Overview

Ứng dụng desktop Electron + Python tạo audio theo từng cue SRT và đóng gói dự
án `.zsp`. Người dùng có thể chọn VieNeu-TTS v3 Turbo hoặc MeloTTS, theo dõi
tiến độ, nghe từng WAV, retry cue lỗi và chỉ đóng gói khi bấm **Save Project**.

Ứng dụng hiện hướng tới macOS 12+ trên Apple Silicon. Pipeline giữ nguyên định
dạng đầu vào/đầu ra: WAV mono PCM16 24 kHz, `project.json` có field theo thứ tự
cố định và archive `.zsp` được kiểm tra JSON/WAV/ZIP CRC trước khi ghi đè.

## Project Structure

```text
SRT-to-Speech-Studio/
├── backend_entry.py          # entry point Electron gọi trực tiếp
├── studio.sh                 # setup VieNeu/MeloTTS và chạy ứng dụng
├── requirements.txt          # runtime VieNeu đã pin
├── requirements-melotts.txt  # runtime MeloTTS cách ly
├── studio/
│   ├── bootstrap.py          # kiểm tra interpreter/dependency
│   ├── pipeline.py           # synthesis, retry, progress và CLI
│   ├── audio_validation.py   # trim, atempo và khớp duration
│   ├── srt_parser.py         # parser SRT
│   ├── zsp.py                # tạo/validate archive
│   ├── asr/                  # transcript validation
│   └── tts/
│       ├── __init__.py       # chọn engine, không eager-import model tùy chọn
│       ├── hardware.py       # runtime plan cho VieNeu
│       ├── vieneu_engine.py  # adapter VieNeu-TTS
│       └── melotts_engine.py # adapter MeloTTS
├── electron-app/             # main/preload/renderer
└── scripts/                  # patch tương thích MeCab khi setup MeloTTS
```

`.venv/`, `.venv-melotts/`, `node_modules/`, `__pycache__/` và `.DS_Store` là
artefact local/generated, đã được `.gitignore` loại trừ.

Luồng chạy:

```text
Electron renderer → preload IPC → Electron main
    → backend_entry.py → studio.pipeline
    → studio.tts ─┬→ VieNeu-TTS v3 Turbo
                  └→ MeloTTS
    → WAV 24 kHz mono PCM16 → retry cache → validated .zsp
```

## Supported TTS Models

### VieNeu-TTS v3 Turbo

- Model mặc định; clone voice từ MP3 tham chiếu dài khoảng 3–8 giây.
- Trên Apple Silicon, mặc định dùng ONNX Runtime/CPU arm64, precision `int8`.
- Model được tải từ Hugging Face ở lần tổng hợp đầu và lưu trong
  `~/.cache/huggingface`.
- Có thể cấu hình nâng cao bằng `SRT_STUDIO_TTS_BACKEND`,
  `SRT_STUDIO_TTS_DEVICE`, `SRT_STUDIO_TTS_PRECISION` và
  `SRT_STUDIO_TTS_THREADS`. Backend không khả dụng sẽ fallback theo logic hiện có.

### MeloTTS

- Model tùy chọn, dùng speaker dựng sẵn; không clone giọng từ MP3.
- Hỗ trợ `EN`, `ES`, `FR`, `ZH`, `JP`, `KR`; upstream không hỗ trợ tiếng Việt.
- Có thể chọn thiết bị bằng `SRT_STUDIO_MELO_DEVICE=auto|cpu|mps|cuda`.
- Chạy trong `.venv-melotts`, tách khỏi VieNeu. Hai stack xung đột ở NumPy,
  Transformers, Tokenizers và Hugging Face dependencies nên không được cài
  chung một môi trường.

## Installation

### macOS

Yêu cầu:

| Thành phần | Yêu cầu |
|---|---|
| macOS | 12 Monterey trở lên |
| CPU | Apple Silicon arm64; Intel không được hỗ trợ chính thức |
| Python | 3.10+, khuyến nghị Python 3.12 arm64 native |
| Node.js | LTS + npm, dùng cho Electron |
| FFmpeg | cần khi audio dài hơn slot SRT và phải time-stretch |
| Internet | cần khi tải model/dictionary lần đầu |

Cài công cụ hệ thống:

```sh
brew install python@3.12 node ffmpeg
python3.12 -c 'import platform; print(platform.machine())' # phải là arm64
```

Các script không dùng `sudo`, không sửa Python hệ thống/shell profile và không
xóa virtualenv hiện có.

## Setup

### Setup VieNeu

```sh
./studio.sh setup vieneu
```

`./studio.sh setup` cũng mặc định chọn VieNeu. Lệnh tạo hoặc dùng lại `.venv`,
cài các wheel đã pin trong `requirements.txt`, cài `vieneu==3.3.0` bằng
`--no-deps` rồi kiểm tra runtime.

Cài thủ công tương đương:

```sh
python3.12 -m venv .venv
.venv/bin/python3 -m pip install --upgrade pip
.venv/bin/python3 -m pip install --only-binary=:all: -r requirements.txt
.venv/bin/python3 -m pip install --no-deps vieneu==3.3.0
```

`--no-deps` ở bước cuối là có chủ ý: các dependency runtime cần thiết đã được
pin, còn Gradio/librosa của các mode khác không cần cho v3 Turbo.

### Setup MeloTTS

Sau khi setup VieNeu:

```sh
./studio.sh setup melotts
```

Hoặc setup cả hai theo đúng thứ tự:

```sh
./studio.sh setup all
```

Lệnh tạo `.venv-melotts`, cài revision MeloTTS đã kiểm tra, UniDic/NLTK data và
patch namespace MeCab trên filesystem macOS không phân biệt hoa thường. Không
cài `requirements-melotts.txt` vào `.venv` và không đổi thứ tự cài
`python-mecab-ko`/`mecab-python3`.

## Running

```sh
./studio.sh run
```

Launcher kiểm tra VieNeu runtime, tự chạy `npm install` nếu `node_modules` chưa
có rồi mở Electron. Giữ Terminal mở trong lúc synthesis để xem log và lỗi.

Interpreter có thể được ghi đè độc lập:

```sh
SRT_STUDIO_PYTHON=/opt/homebrew/bin/python3.12 ./studio.sh run
SRT_STUDIO_MELOTTS_PYTHON=/path/to/melotts/python ./studio.sh run
```

Repository chạy trực tiếp từ source; chưa cấu hình build `.app`, `.dmg` hay
`electron-builder`.

## Usage

1. Chọn file phụ đề `.srt`.
2. Chọn **TTS Model**. VieNeu cần MP3 tham chiếu; MeloTTS cần Language/Speaker.
3. Chọn thư mục output và số **Processing Threads** (mặc định 4).
4. Bấm **Create Audio** và theo dõi progress/Activity Log.
5. Dùng **Play** để nghe WAV đã tạo ngay từ retry cache.
6. Dùng **Retry** cho một cue hoặc **Retry Failed** cho các cue lỗi/thiếu.
7. Bấm **Validate Now** để so nội dung audio hiện có với SRT khi cần.
8. Bấm **Save Project** để đóng gói trạng thái hiện có thành `.zsp` cùng tên SRT.

Cancel giữ lại các cue hoàn thành. Save Project là thao tác riêng và không tự
chạy sau synthesis; archive cũ chỉ bị thay thế sau khi archive mới hợp lệ.

## Troubleshooting

**Không tìm thấy Python 3.10+ hoặc Python chạy qua Rosetta**

Chạy `brew install python@3.12`, kiểm tra `which -a python3.12` và xác nhận
`platform.machine()` trả về `arm64`.

**TTS model not found / lỗi tải model**

Kiểm tra mạng hoặc chép sẵn cache Hugging Face vào `~/.cache/huggingface`.
Có thể đặt `HF_TOKEN` nếu tài khoản gặp giới hạn tải.

**Thiếu FFmpeg**

Chạy `brew install ffmpeg`. Cue ngắn chỉ cần pad silence, nhưng cue có audio dài
hơn slot SRT cần filter `atempo` để giữ pitch.

**Electron thoát ngay hoặc báo `getPath` undefined**

Xem log tại
`~/Library/Application Support/srt-to-speech-studio-electron/logs/main.log`.
Launcher tự bỏ `ELECTRON_RUN_AS_NODE`. Nếu chạy Electron thủ công, dùng:

```sh
env -u ELECTRON_RUN_AS_NODE ./studio.sh run
```

**MeloTTS không khởi động**

Chạy lại `./studio.sh setup melotts`; không sửa tay MeCab hoặc trộn package với
`.venv`. Có thể đặt `SRT_STUDIO_MELOTTS_PYTHON` nếu dùng runtime tương thích khác.

## Development Notes

Chạy kiểm tra cú pháp và chẩn đoán trực tiếp:

```sh
.venv/bin/python3 -m studio.tts.hardware

cd electron-app
npm run check
```

Sau đó chạy `./studio.sh run` và kiểm tra chọn file, tổng hợp, retry, phát audio
và lưu project trực tiếp trong Electron.

Các contract cần giữ khi phát triển:

- Electron gọi `backend_entry.py`; backend nạp `studio.pipeline` trong cùng process.
- CLI không truyền `--tts-model` vẫn chọn VieNeu. MeloTTS dùng
  `--tts-model melotts --melo-language EN --melo-speaker EN-US`.
- Tên field, thứ tự xử lý, JSON event, retry directory và output `.zsp` là
  contract giữa UI/backend, không đổi nếu không có migration rõ ràng.
- Duration matching dùng các biến `SRT_STUDIO_DURATION_TOLERANCE_MS`,
  `SRT_STUDIO_QUALITY_WARNING_SPEED`, `SRT_STUDIO_SEVERE_WARNING_SPEED` và nhóm
  `SRT_STUDIO_SILENCE_*` được mô tả cạnh constant trong
  `studio/audio_validation.py`.
- Router TTS nằm trong `studio/tts/__init__.py`; engine được import lazily để
  VieNeu không cần PyTorch/MeloTTS và MeloTTS không ảnh hưởng runtime VieNeu.

Phiên bản ứng dụng hiện tại: **3.0.0**.
