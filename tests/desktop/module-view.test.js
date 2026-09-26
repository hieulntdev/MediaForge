'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { bundleModuleView } = require('../../apps/desktop/main/ipc-router');

const root = path.resolve(__dirname, '..', '..');

test('module view bundles local assets and injects only its manifest bridge', () => {
  const output = bundleModuleView({
    uiEntry: path.join(root, 'Bili-Downloader', 'electron-app', 'index.html'),
    ui: { bridge: 'biliAPI' }
  });
  assert.match(output, /data-mediaforge-asset="styles\.css"/);
  assert.match(output, /data-mediaforge-asset="renderer\.js"/);
  assert.match(output, /parent\["biliAPI"\]/);
  assert.match(output, /html,body\{min-width:0!important;min-height:0!important\}/);
  assert.doesNotMatch(output, /Content-Security-Policy/);
  assert.doesNotMatch(output, /<link[^>]+styles\.css/);
});

test('SRT compatibility bridge exposes the output-folder picker', () => {
  const preload = fs.readFileSync(path.join(root, 'apps', 'desktop', 'preload', 'index.js'), 'utf8');
  const srtBridge = preload.slice(preload.indexOf("contextBridge.exposeInMainWorld('srtAPI'"));
  assert.match(srtBridge, /selectOutput:\s*\(defaultPath\)\s*=>\s*ipcRenderer\.invoke\(CHANNELS\.DIALOG_OPEN,\s*\{ kind: 'folder', defaultPath \}\)/);
});
