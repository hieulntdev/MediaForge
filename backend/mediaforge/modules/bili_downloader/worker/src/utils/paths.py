import os
from pathlib import Path

# src/utils/paths.py -> parents: [0]=src/utils [1]=src [2]=project root
PROJECT_ROOT = Path(__file__).resolve().parents[2]
LEGACY_SETTINGS_FILE = PROJECT_ROOT / "config" / "settings.json"
DATA_ROOT = Path(os.environ["MEDIAFORGE_DATA_DIR"]).expanduser() if os.environ.get("MEDIAFORGE_DATA_DIR") else PROJECT_ROOT

CONFIG_DIR = DATA_ROOT / "config" / "bili-downloader" if DATA_ROOT != PROJECT_ROOT else PROJECT_ROOT / "config"
LOGS_DIR = DATA_ROOT / "logs" if DATA_ROOT != PROJECT_ROOT else PROJECT_ROOT / "logs"
TEMP_DIR = DATA_ROOT / "temp" / "bili-downloader" if DATA_ROOT != PROJECT_ROOT else PROJECT_ROOT / "temp"
DOWNLOAD_DIR = DATA_ROOT / "outputs" / "bili-downloader" if DATA_ROOT != PROJECT_ROOT else PROJECT_ROOT / "downloads"

SETTINGS_FILE = CONFIG_DIR / "settings.json"


def ensure_dirs() -> None:
    for d in (CONFIG_DIR, LOGS_DIR, TEMP_DIR, DOWNLOAD_DIR):
        d.mkdir(parents=True, exist_ok=True)
