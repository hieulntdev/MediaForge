'use strict';

// Clear only renderer-owned browser state at the start of a new application
// process. Cookies are intentionally excluded because MediaForge account input
// is a user-selected file, not an Electron cookie jar.
const TRANSIENT_WEB_STORAGES = Object.freeze([
  'appcache',
  'filesystem',
  'indexdb',
  'localstorage',
  'serviceworkers',
  'cachestorage',
  'websql'
]);

async function resetRendererSession(electronSession) {
  if (!electronSession) throw new TypeError('An Electron session is required.');
  await Promise.all([
    electronSession.clearCache(),
    electronSession.clearStorageData({ storages: [...TRANSIENT_WEB_STORAGES] })
  ]);
}

module.exports = { TRANSIENT_WEB_STORAGES, resetRendererSession };
