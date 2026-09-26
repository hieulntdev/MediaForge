'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function inspectPython(executable, timeout = 5000) {
  return new Promise((resolve) => {
    const code = 'import json,platform; print(json.dumps({"version": platform.python_version(), "architecture": platform.machine()}))';
    execFile(executable, ['-c', code], { timeout }, (error, stdout, stderr) => {
      try {
        const detail = JSON.parse(String(stdout).trim());
        const compatible = detail.version.startsWith('3.12.') && detail.architecture === 'arm64';
        resolve({ ok: !error && compatible, executable, version: `Python ${detail.version}`, architecture: detail.architecture,
          error: error ? String(stderr || error.message).trim() : (compatible ? null : `Expected Python 3.12 arm64, found ${detail.version} ${detail.architecture}.`) });
      } catch {
        resolve({ ok: false, executable, version: '', architecture: '', error: String(stderr || error?.message || 'Unable to inspect Python runtime.').trim() });
      }
    });
  });
}

class RuntimeResolver {
  constructor({ projectRoot, runtimesRoot = path.join(projectRoot, 'runtimes'), env = process.env }) {
    this.projectRoot = path.resolve(projectRoot);
    this.runtimesRoot = path.resolve(runtimesRoot);
    this.env = env;
    this.manifests = new Map();
    this.discover();
  }

  discover() {
    this.manifests.clear();
    if (!fs.existsSync(this.runtimesRoot)) return;
    for (const entry of fs.readdirSync(this.runtimesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'envs') continue;
      const manifestPath = path.join(this.runtimesRoot, entry.name, 'runtime.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest.id || this.manifests.has(manifest.id)) throw new Error(`Invalid or duplicate runtime: ${manifest.id}`);
      this.manifests.set(manifest.id, Object.freeze({ ...manifest, manifestPath }));
    }
  }

  resolve(runtimeId) {
    const manifest = this.manifests.get(runtimeId);
    if (!manifest) throw new Error(`Unknown runtime: ${runtimeId}`);
    const override = manifest.environmentVariable ? this.env[manifest.environmentVariable] : null;
    const managed = path.join(this.runtimesRoot, 'envs', runtimeId, 'bin', 'python');
    const fallback = path.resolve(this.projectRoot, manifest.legacyInterpreter);
    const executable = override || (fs.existsSync(managed) ? managed : fallback);
    if (!fs.existsSync(executable)) {
      throw new Error(`Runtime ${runtimeId} is unavailable at ${executable}. Run the corresponding setup command.`);
    }
    return executable;
  }

  async health(runtimeId) {
    try {
      const executable = this.resolve(runtimeId);
      return { id: runtimeId, ...(await inspectPython(executable)) };
    } catch (error) {
      return { id: runtimeId, ok: false, executable: null, version: '', error: error.message };
    }
  }

  async healthAll() {
    return Promise.all([...this.manifests.keys()].map((id) => this.health(id)));
  }
}

module.exports = { RuntimeResolver, inspectPython };
