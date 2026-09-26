'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function jsFiles(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...jsFiles(target));
    else if (entry.name.endsWith('.js')) output.push(target);
  }
  return output;
}

test('desktop core does not import concrete module adapters', () => {
  const root = path.resolve(__dirname, '../../apps/desktop/main');
  for (const file of jsFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /modules\/(bili_downloader|sfx_converter|srt_to_speech)/, file);
  }
});

