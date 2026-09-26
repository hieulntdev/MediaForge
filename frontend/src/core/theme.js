const STORAGE_KEY = 'mediaforge:theme';
const LEGACY_KEYS = ['bilibili-downloader:theme', 'srtts:theme'];

function readStoredTheme() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current === 'light' || current === 'dark') return current;
    for (const key of LEGACY_KEYS) {
      const legacy = localStorage.getItem(key);
      if (legacy === 'light' || legacy === 'dark') return legacy;
    }
  } catch { /* Light remains the safe default. */ }
  return window.mediaForge.initialTheme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme, { persist = false } = {}) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Theme still applies. */ }
    window.mediaForge.setSettings({ theme: value }).catch(() => {});
  }
  return value;
}

export function initializeTheme() { return applyTheme(readStoredTheme()); }
export function toggleTheme() { return applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', { persist: true }); }

