'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveBackendLaunch } = require('../main/services/python-resolver');

test('uses explicit Python override', () => {
  const launch = resolveBackendLaunch({
    projectRoot: '/project',
    env: { SFX_CONVERTER_PYTHON: '/custom/python' },
    platform: 'darwin'
  });
  assert.equal(launch.executable, '/custom/python');
  assert.deepEqual(launch.args, ['-u', '-m', 'app.backend']);
  assert.equal(launch.cwd, '/project');
});

test('uses the project virtual environment by default', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-python-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const executable = path.join(projectRoot, '.venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');

  const launch = resolveBackendLaunch({ projectRoot, env: {}, platform: 'darwin' });
  assert.equal(launch.executable, executable);
  assert.deepEqual(launch.args, ['-u', '-m', 'app.backend']);
  assert.equal(launch.cwd, projectRoot);
});

test('reports setup instructions instead of launching an unsupported system Python', () => {
  assert.throws(
    () => resolveBackendLaunch({ projectRoot: '/project-without-venv', env: {}, platform: 'darwin' }),
    /Python environment not found.*\.\/scripts\/setup\.sh/
  );
});
