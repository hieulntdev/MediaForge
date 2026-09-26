'use strict';

// Apply the main-process preference before stylesheets are evaluated so the
// first painted frame and its native controls use the same color scheme.
document.documentElement.dataset.theme = window.sfxApi?.initialTheme === 'dark' ? 'dark' : 'light';
