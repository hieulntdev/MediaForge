'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { ModuleManager } = require('../../apps/desktop/main/services/module-manager');

class FixtureAdapter extends EventEmitter {
  resourceClassFor(action) { return action === 'start' ? 'heavy' : 'light'; }
  execute(action) { return { action }; }
}

test('heavy concurrency guard still permits lightweight status and cancel actions', async () => {
  const manager = new ModuleManager({
    registry: { get: () => ({ actions: ['start', 'status', 'cancel'], resourceClass: 'heavy' }) },
    taskManager: { hasActiveResource: () => true }
  });
  manager.adapters.set('fixture', new FixtureAdapter());
  await assert.rejects(manager.execute('fixture', 'start'), /Another ML task/);
  assert.deepEqual(await manager.execute('fixture', 'status'), { action: 'status' });
  assert.deepEqual(await manager.execute('fixture', 'cancel'), { action: 'cancel' });
});
