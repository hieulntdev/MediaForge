'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(require('electron'), [path.join(__dirname, 'layout-smoke.js')], {
  env: environment,
  stdio: 'inherit'
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
