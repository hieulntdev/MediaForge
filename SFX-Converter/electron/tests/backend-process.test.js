'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BackendProcess } = require('../main/services/backend-process');

test('rejects backend startup immediately when Python exits before ready', async () => {
  const backend = new BackendProcess({ projectRoot: '/project' });
  const startup = new Promise((resolve, reject) => {
    backend.readyResolve = resolve;
    backend.readyReject = reject;
  });
  backend.readyPromise = startup;
  backend.startupStderr = ["ModuleNotFoundError: No module named 'platformdirs'"];

  backend.handleExit(1, null);

  await assert.rejects(
    startup,
    /exited before it was ready \(exit code 1\).*ModuleNotFoundError.*platformdirs/
  );
});
