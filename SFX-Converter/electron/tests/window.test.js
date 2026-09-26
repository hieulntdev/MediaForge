'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWindowOptions } = require('../main/window');

test('main window follows the required desktop metrics and renderer isolation', () => {
  const options = createWindowOptions('light');

  assert.equal(options.width, 1180);
  assert.equal(options.height, 780);
  assert.equal(options.minWidth, 900);
  assert.equal(options.minHeight, 650);
  assert.equal(options.show, false);
  assert.equal(options.backgroundColor, '#f5f5f7');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
});

test('dark startup uses the canonical canvas and passes only the theme hint', () => {
  const options = createWindowOptions('dark');

  assert.equal(options.backgroundColor, '#1d1d1f');
  assert.deepEqual(options.webPreferences.additionalArguments, ['--sfx-theme=dark']);
});
