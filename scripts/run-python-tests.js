'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RuntimeResolver } = require('../apps/desktop/main/services/runtime-resolver');

const projectRoot = path.resolve(__dirname, '..');
const python = new RuntimeResolver({ projectRoot }).resolve('base');
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests/python', '-v'], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
