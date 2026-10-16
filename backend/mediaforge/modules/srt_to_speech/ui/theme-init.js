'use strict';

// Apply the saved preference before styles are loaded so a dark-theme window
// never paints the light canvas first. Light remains the documented default.
(() => {
  const THEME_KEY = 'srtts:theme';
  let savedTheme = null;

  try {
    savedTheme = localStorage.getItem(THEME_KEY);
  } catch (_error) {
    // A disabled/unavailable storage backend must not prevent first paint.
  }

  document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';
})();
