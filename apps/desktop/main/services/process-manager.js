'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

class ManagedProcess extends EventEmitter {
  constructor(key, launch) {
    super();
    this.key = key;
    this.launch = launch;
    this.child = null;
    this.intentionalShutdown = false;
  }

  start() {
    if (this.child) return this;
    this.intentionalShutdown = false;
    const child = spawn(this.launch.executable, this.launch.args || [], {
      cwd: this.launch.cwd,
      env: { ...process.env, ...(this.launch.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    const consume = (stream, source) => readline.createInterface({ input: stream }).on('line', (line) => {
      this.emit('line', { line, source });
    });
    consume(child.stdout, 'stdout');
    consume(child.stderr, 'stderr');
    child.once('error', (error) => this.emit('error', error));
    child.once('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', { code, signal, intentional: this.intentionalShutdown });
    });
    return this;
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error(`Process ${this.key} is not ready.`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async terminate({ gracefulMessage = null, timeoutMs = 3000 } = {}) {
    const child = this.child;
    if (!child) return;
    this.intentionalShutdown = true;
    if (gracefulMessage && child.stdin.writable) this.send(gracefulMessage);
    const waitForExit = (duration) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, duration);
      child.once('exit', onExit);
    });
    if (await waitForExit(timeoutMs)) return;
    child.kill('SIGTERM');
    if (await waitForExit(2000)) return;
    child.kill('SIGKILL');
    await waitForExit(1000);
  }
}

class ProcessManager {
  constructor() { this.persistent = new Map(); this.oneShot = new Set(); }

  persistentProcess(key, launch) {
    if (!this.persistent.has(key)) this.persistent.set(key, new ManagedProcess(key, launch));
    return this.persistent.get(key).start();
  }

  runOneShot(key, launch) {
    const process = new ManagedProcess(key, launch).start();
    this.oneShot.add(process);
    process.once('exit', () => this.oneShot.delete(process));
    return process;
  }

  async shutdown() {
    await Promise.all([
      ...[...this.persistent.values()].map((process) => process.terminate()),
      ...[...this.oneShot].map((process) => process.terminate())
    ]);
    this.persistent.clear();
    this.oneShot.clear();
  }
}

module.exports = { ManagedProcess, ProcessManager };
