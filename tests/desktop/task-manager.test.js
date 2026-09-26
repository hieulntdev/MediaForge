'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TaskManager } = require('../../apps/desktop/main/services/task-manager');

const manager = () => new TaskManager({ pathService: { taskWorkspace: (id) => `/tmp/mediaforge-test/${id}` } });

test('task manager enforces canonical states and module-defined stages', () => {
  const tasks = manager();
  const task = tasks.create({ module: 'fixture', action: 'work', capabilities: { cancel: true } });
  tasks.transition(task.id, 'RUNNING', { stage: 'decoding' });
  tasks.setProgress(task.id, { current: 2, total: 4 });
  assert.equal(task.stage, 'decoding');
  assert.equal(task.progress.percent, 50);
  tasks.transition(task.id, 'COMPLETED', { stage: 'done' });
  assert.throws(() => tasks.transition(task.id, 'RUNNING'), /Invalid task transition/);
});

test('task logs are bounded and errors use the public error contract', () => {
  const tasks = new TaskManager({ pathService: { taskWorkspace: () => '/tmp/task' }, maxLogs: 2 });
  const task = tasks.create({ module: 'fixture', action: 'work' });
  tasks.transition(task.id, 'RUNNING');
  tasks.addLog(task.id, 'INFO', 'one'); tasks.addLog(task.id, 'INFO', 'two'); tasks.addLog(task.id, 'ERROR', 'three');
  assert.deepEqual(task.logs.map((entry) => entry.message), ['two', 'three']);
  tasks.transition(task.id, 'FAILED', { error: { code: 'FIXTURE', message: 'Failed', detail: 'private', retryable: true } });
  assert.deepEqual(task.error, { code: 'FIXTURE', message: 'Failed', detail: 'private', retryable: true });
});

