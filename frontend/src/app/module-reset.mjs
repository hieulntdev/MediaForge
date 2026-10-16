const MODULE_STORAGE = Object.freeze({
  bili_downloader: Object.freeze({
    session: ['bilibili-downloader:ui-state-v2'],
    preferences: []
  }),
  srt_to_speech: Object.freeze({
    session: [],
    preferences: ['srtts:threads', 'srtts:tts-model']
  }),
  sfx_converter: Object.freeze({ session: [], preferences: [] }),
  hongguo_downloader: Object.freeze({ session: [], preferences: [] })
});

function removeKeys(keys) {
  for (const key of keys) localStorage.removeItem(key);
}

export function clearAllModuleSessionStorage() {
  try {
    for (const definition of Object.values(MODULE_STORAGE)) removeKeys(definition.session);
  } catch {
    // A fresh in-memory renderer state is still used when storage is unavailable.
  }
}

export function clearModuleStorage(moduleId, { includePreferences = false } = {}) {
  const definition = MODULE_STORAGE[moduleId];
  if (!definition) return;
  try {
    removeKeys(definition.session);
    if (includePreferences) removeKeys(definition.preferences);
  } catch {
    // The iframe reload below still resets non-persisted state.
  }
}

export { MODULE_STORAGE };
