const MODULE_ICONS = Object.freeze({
  bili_downloader: '<rect x="2.5" y="4.5" width="19" height="15" rx="4"></rect><path d="m8.5 2.5 3.5 3 3.5-3M9.5 9l6 3-6 3z"></path>',
  sfx_converter: '<path d="M3 12h2.5l1.5-5 3 10 3-12 3 14 2-7H21"></path>',
  srt_to_speech: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"></path>'
});

const FALLBACK_ICON = '<path d="M4 12h3l2-7 3 14 3-10 2 6h3"></path>';

export function moduleIconMarkup(moduleId) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${MODULE_ICONS[moduleId] || FALLBACK_ICON}</svg>`;
}

export { MODULE_ICONS };
