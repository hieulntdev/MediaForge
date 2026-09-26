'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

function pathCandidates(name, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name));
}

function locate(name, env = process.env) {
  const fs = require('node:fs');
  return pathCandidates(name, env).find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

function health(name, env = process.env) {
  const executable = locate(name, env);
  if (!executable) return Promise.resolve({ name, ok: false, executable: null, version: '', error: `${name} was not found on PATH.` });
  return new Promise((resolve) => {
    execFile(executable, ['-version'], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({
        name,
        ok: !error,
        executable,
        version: `${stdout || ''}${stderr || ''}`.trim().split(/\r?\n/)[0] || '',
        error: error ? error.message : null
      });
    });
  });
}

class FFmpegLocator {
  constructor(env = process.env) { this.env = env; }
  resolve() { const value = locate('ffmpeg', this.env); if (!value) throw new Error('ffmpeg was not found on PATH.'); return value; }
  health() { return health('ffmpeg', this.env); }
}

class FFprobeLocator {
  constructor(env = process.env) { this.env = env; }
  resolve() { const value = locate('ffprobe', this.env); if (!value) throw new Error('ffprobe was not found on PATH.'); return value; }
  health() { return health('ffprobe', this.env); }
}

module.exports = { FFmpegLocator, FFprobeLocator, locate, health };
