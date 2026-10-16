'use strict';

// Browser cache is transient, but localStorage and IndexedDB may contain
// namespaced user preferences. Renderer session keys are removed explicitly
// by frontend/src/app/module-reset.mjs instead of clearing an entire origin.
async function resetRendererSession(electronSession) {
  if (!electronSession) throw new TypeError('An Electron session is required.');
  await electronSession.clearCache();
}

module.exports = { resetRendererSession };
