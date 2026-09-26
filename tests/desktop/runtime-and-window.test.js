'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WINDOW_METRICS, createWindowOptions, initialWindowBounds } = require('../../apps/desktop/main/window-options');
const { RuntimeResolver } = require('../../apps/desktop/main/services/runtime-resolver');

test('desktop toolchain is pinned to the approved Electron and Node baseline', () => {
  const packageJson = require('../../package.json');
  assert.equal(packageJson.devDependencies.electron, '44.4.5');
  assert.equal(packageJson.engines.node, '>=22 <23');
});

test('window keeps required metrics and renderer isolation', () => {
  const options = createWindowOptions('dark');
  assert.equal(options.width, 1180); assert.equal(options.height, 780);
  assert.equal(options.minWidth, 900); assert.equal(options.minHeight, 650);
  assert.equal(options.resizable, true);
  assert.equal(options.maximizable, true);
  assert.equal(options.fullscreenable, true);
  assert.equal(options.movable, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.backgroundColor, '#1d1d1f');
});

test('window starts centered without being locked to the display work area', () => {
  const workArea = { x: 100, y: 25, width: 1512, height: 957 };
  const bounds = initialWindowBounds(workArea);
  assert.deepEqual(bounds, { x: 266, y: 114, width: 1180, height: 780 });
  assert.deepEqual(createWindowOptions('light', workArea), {
    ...createWindowOptions('light'),
    ...bounds
  });
});

test('initial bounds use the available display while preserving the shared UI minimum', () => {
  assert.deepEqual(WINDOW_METRICS, {
    defaultWidth: 1180,
    defaultHeight: 780,
    minWidth: 900,
    minHeight: 650
  });
  assert.deepEqual(
    initialWindowBounds({ x: -1280, y: 0, width: 1024, height: 700 }),
    { x: -1280, y: 0, width: 1024, height: 700 }
  );
  assert.deepEqual(
    initialWindowBounds({ x: 0, y: 0, width: 800, height: 600 }),
    { x: 0, y: 0, width: 900, height: 650 }
  );
});

test('runtime resolver is data-driven and honors an explicit override', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaforge-runtime-'));
  const runtimes = path.join(temporary, 'runtimes');
  fs.mkdirSync(path.join(runtimes, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(runtimes, 'demo', 'runtime.json'), JSON.stringify({ id: 'demo', environmentVariable: 'DEMO_PYTHON', legacyInterpreter: 'missing' }));
  const resolver = new RuntimeResolver({ projectRoot: temporary, runtimesRoot: runtimes, env: { DEMO_PYTHON: process.execPath } });
  assert.equal(resolver.resolve('demo'), process.execPath);
  assert.throws(() => resolver.resolve('unknown'), /Unknown runtime/);
});

test('runtime resolver prefers a managed isolated environment over a legacy environment', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaforge-managed-runtime-'));
  const runtimes = path.join(temporary, 'runtimes');
  const managed = path.join(runtimes, 'envs', 'demo', 'bin', 'python');
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.mkdirSync(path.join(runtimes, 'demo'), { recursive: true });
  fs.writeFileSync(managed, 'fixture');
  fs.writeFileSync(path.join(runtimes, 'demo', 'runtime.json'), JSON.stringify({ id: 'demo', legacyInterpreter: 'legacy/bin/python' }));
  const resolver = new RuntimeResolver({ projectRoot: temporary, runtimesRoot: runtimes, env: {} });
  assert.equal(resolver.resolve('demo'), managed);
});
