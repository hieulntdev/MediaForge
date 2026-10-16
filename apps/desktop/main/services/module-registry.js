'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REQUIRED_FIELDS = [
  'id', 'version', 'displayName', 'description', 'frontendRoute',
  'runtime', 'actions', 'capabilities', 'inputs', 'outputs', 'adapter', 'ui'
];

function validateManifest(manifest, source = 'module.json') {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError(`${source}: manifest must be an object.`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest)) throw new TypeError(`${source}: missing ${field}.`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(manifest.id)) throw new TypeError(`${source}: invalid id.`);
  if (!/^[a-z0-9-]+$/.test(manifest.frontendRoute)) throw new TypeError(`${source}: invalid frontendRoute.`);
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0 || new Set(manifest.actions).size !== manifest.actions.length) {
    throw new TypeError(`${source}: actions must be a non-empty unique array.`);
  }
  if (typeof manifest.capabilities?.cancel !== 'boolean' || typeof manifest.capabilities?.pause !== 'boolean') {
    throw new TypeError(`${source}: invalid capabilities.`);
  }
  if (!/^[a-z0-9-]+\.js$/.test(manifest.adapter)) throw new TypeError(`${source}: invalid adapter.`);
  if (!manifest.ui || typeof manifest.ui.entry !== 'string') throw new TypeError(`${source}: invalid ui entry.`);
  if (!['biliAPI', 'sfxApi', 'srtAPI', 'hongguoAPI'].includes(manifest.ui.bridge)) throw new TypeError(`${source}: invalid UI bridge.`);
  if (!['light', 'medium', 'heavy'].includes(manifest.resourceClass)) throw new TypeError(`${source}: invalid resourceClass.`);
  return manifest;
}

class ModuleRegistry {
  constructor({ modulesRoot, projectRoot }) {
    this.modulesRoot = path.resolve(modulesRoot);
    this.projectRoot = path.resolve(projectRoot);
    this.modules = new Map();
  }

  discover() {
    const discovered = new Map();
    if (!fs.existsSync(this.modulesRoot)) return [];
    for (const entry of fs.readdirSync(this.modulesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(this.modulesRoot, entry.name, 'module.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifestPath);
      if (discovered.has(manifest.id)) throw new Error(`Duplicate module id: ${manifest.id}`);
      const moduleDirectory = path.dirname(manifestPath);
      const adapterPath = path.resolve(moduleDirectory, manifest.adapter);
      if (path.dirname(adapterPath) !== moduleDirectory) throw new Error(`${manifest.id}: adapter escapes its module directory.`);
      const uiEntry = path.resolve(this.projectRoot, manifest.ui.entry);
      const uiRelative = path.relative(this.projectRoot, uiEntry);
      if (uiRelative.startsWith('..') || path.isAbsolute(uiRelative)) throw new Error(`${manifest.id}: UI entry escapes the project root.`);
      if (!fs.statSync(adapterPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`${manifest.id}: adapter does not exist.`);
      if (!fs.statSync(uiEntry, { throwIfNoEntry: false })?.isFile()) throw new Error(`${manifest.id}: UI entry does not exist.`);
      const resolved = Object.freeze({ ...manifest, manifestPath, moduleDirectory, adapterPath, uiEntry });
      discovered.set(manifest.id, resolved);
    }
    this.modules = discovered;
    return this.list();
  }

  get(moduleId) {
    const manifest = this.modules.get(moduleId);
    if (!manifest) throw new Error(`Unknown module: ${moduleId}`);
    return manifest;
  }

  list() {
    return [...this.modules.values()].map((manifest) => ({
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      frontendRoute: manifest.frontendRoute,
      runtime: manifest.runtime,
      actions: [...manifest.actions],
      capabilities: { ...manifest.capabilities },
      inputs: [...manifest.inputs],
      outputs: [...manifest.outputs],
      resourceClass: manifest.resourceClass || 'light',
      accent: manifest.ui.accent,
      frontendUrl: pathToFileURL(manifest.uiEntry).href
    }));
  }
}

module.exports = { ModuleRegistry, validateManifest };
