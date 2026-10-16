'use strict';

const { EventEmitter } = require('node:events');

class ModuleManager extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.registry = context.registry;
    this.taskManager = context.taskManager;
    this.adapters = new Map();
  }

  adapter(moduleId) {
    if (this.adapters.has(moduleId)) return this.adapters.get(moduleId);
    const manifest = this.registry.get(moduleId);
    const factory = require(manifest.adapterPath);
    if (typeof factory.createAdapter !== 'function') throw new Error(`${moduleId}: adapter has no createAdapter().`);
    const adapter = factory.createAdapter({ ...this.context, manifest });
    adapter.on?.('event', (payload) => this.emit('module-event', { module: moduleId, payload }));
    this.adapters.set(moduleId, adapter);
    return adapter;
  }

  async execute(moduleId, action, payload = {}) {
    const manifest = this.registry.get(moduleId);
    if (!manifest.actions.includes(action)) throw new Error(`${moduleId} does not expose action ${action}.`);
    const adapter = this.adapter(moduleId);
    const resourceClass = adapter.resourceClassFor?.(action) || manifest.resourceClass;
    if (resourceClass === 'heavy' && this.taskManager.hasActiveResource('heavy')) {
      throw new Error('Another ML task is already active. Wait for it to finish before starting this task.');
    }
    return adapter.execute(action, payload);
  }

  async control(taskId, operation) {
    const task = this.taskManager.get(taskId);
    const adapter = this.adapter(task.module);
    if (typeof adapter[operation] !== 'function') throw new Error(`${operation} is not supported.`);
    return adapter[operation](taskId);
  }

  isActive(moduleId) {
    if (this.taskManager.activeForModule(moduleId).length > 0) return true;
    return Boolean(this.adapters.get(moduleId)?.isBusy?.());
  }

  async reset(moduleId) {
    this.registry.get(moduleId);
    if (this.isActive(moduleId)) throw new Error('Cannot reset this module while it is processing.');
    const adapter = this.adapter(moduleId);
    if (typeof adapter.resetToDefaults !== 'function') {
      throw new Error(`${moduleId} does not support reset to defaults.`);
    }
    const result = await adapter.resetToDefaults();
    if (this.isActive(moduleId)) throw new Error('Cannot reset this module while it is processing.');
    const clearedTasks = this.taskManager.clearModule(moduleId);
    return { reset: true, clearedTasks, ...(result || {}) };
  }

  async shutdown() {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.shutdown?.()));
  }
}

module.exports = { ModuleManager };
