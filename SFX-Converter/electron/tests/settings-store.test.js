'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SettingsStore } = require('../main/services/settings-store');

test('settings store persists only supported theme values', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-settings-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const settings = new SettingsStore(directory);
  assert.deepEqual(settings.get(), { theme: 'light' });
  assert.deepEqual(settings.set({ theme: 'dark', unexpected: true }), { theme: 'dark' });
  assert.deepEqual(new SettingsStore(directory).get(), { theme: 'dark' });
  assert.deepEqual(settings.set({ theme: 'unsupported' }), { theme: 'dark' });
});
