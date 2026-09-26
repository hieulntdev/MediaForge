'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

function electronBinary() {
  try {
    return require('electron');
  } catch {
    return path.join(__dirname, '..', 'SFX-Converter', 'node_modules', '.bin', 'electron');
  }
}

const electronEnvironment = { ...process.env };
// IDE-hosted terminals can export this for Electron's utility processes. It
// must never leak into the desktop launcher or Electron behaves like plain Node.
delete electronEnvironment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary(), [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: electronEnvironment
});
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
