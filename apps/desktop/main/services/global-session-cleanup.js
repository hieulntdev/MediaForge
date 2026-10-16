'use strict';

const { resetRendererSession } = require('./session-state');

class GlobalSessionCleanup {
  constructor({ pathService, electronSession }) {
    this.pathService = pathService;
    this.electronSession = electronSession;
    this.handlers = new Map();
    this.completed = false;
  }

  register(moduleId, handler = null) {
    const id = String(moduleId || '');
    if (!id) throw new TypeError('A module id is required for session cleanup.');
    if (handler !== null && typeof handler !== 'function') {
      throw new TypeError(`${id}: cleanupSession must be a function.`);
    }
    this.handlers.set(id, handler || (async () => {}));
  }

  registerDiscoveredModules(registry) {
    for (const listed of registry.list()) {
      const manifest = registry.get(listed.id);
      const moduleExports = require(manifest.adapterPath);
      this.register(manifest.id, moduleExports.cleanupSession || null);
    }
  }

  async runOnce() {
    if (this.completed) return { cleaned: false, modules: [...this.handlers.keys()] };
    this.completed = true;
    this.pathService.resetSessionData();
    await resetRendererSession(this.electronSession);
    for (const [moduleId, handler] of this.handlers) {
      await handler({ moduleId, pathService: this.pathService });
    }
    return { cleaned: true, modules: [...this.handlers.keys()] };
  }
}

module.exports = { GlobalSessionCleanup };
