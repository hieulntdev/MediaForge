'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { ModuleRegistry, validateManifest } = require('../../apps/desktop/main/services/module-registry');

const projectRoot = path.resolve(__dirname, '..', '..');

test('registry discovers all three manifests without hard-coded module ids', () => {
  const registry = new ModuleRegistry({ modulesRoot: path.join(projectRoot, 'backend', 'mediaforge', 'modules'), projectRoot });
  const modules = registry.discover();
  assert.equal(modules.length, 3);
  assert.deepEqual(modules.map((module) => module.id).sort(), ['bili_downloader', 'sfx_converter', 'srt_to_speech']);
  for (const module of modules) {
    assert.ok(module.frontendUrl.startsWith('file:'));
    assert.ok(module.actions.length > 0);
  }
});

test('manifest validation rejects missing contract fields', () => {
  assert.throws(() => validateManifest({ id: 'broken' }, 'fixture'), /missing version/);
});

