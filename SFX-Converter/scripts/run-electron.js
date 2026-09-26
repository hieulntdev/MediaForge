'use strict';

const { spawn } = require('node:child_process');
const electron = require('electron');

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const entryPoint = process.argv[2] || '.';
const child = spawn(electron, [entryPoint], {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`Could not start Electron: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
