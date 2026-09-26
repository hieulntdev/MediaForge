'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { resolveBackendLaunch } = require('./python-resolver');

class BackendProcess extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.child = null;
    this.currentJobId = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.intentionalShutdown = false;
    this.startupStderr = [];
  }

  get isRunning() {
    return this.currentJobId !== null;
  }

  async ensureStarted() {
    if (this.child && this.readyPromise) return this.readyPromise;
    const launch = resolveBackendLaunch(this.options);
    this.intentionalShutdown = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stdout = readline.createInterface({ input: this.child.stdout });
    const stderr = readline.createInterface({ input: this.child.stderr });
    stdout.on('line', (line) => this.handleLine(line));
    stderr.on('line', (line) => {
      if (this.readyReject) {
        this.startupStderr.push(line);
        if (this.startupStderr.length > 20) this.startupStderr.shift();
      }
      this.emit('event', { type: 'task:log', level: 'ERROR', message: line });
    });
    this.child.once('error', (error) => this.handleProcessFailure(error));
    this.child.once('exit', (code, signal) => this.handleExit(code, signal));

    const timeout = setTimeout(() => {
      if (this.readyReject) this.readyReject(new Error('The Python backend timed out during startup.'));
    }, 30000);
    this.readyPromise.finally(() => clearTimeout(timeout)).catch(() => {});
    return this.readyPromise;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('event', { type: 'task:log', level: 'INFO', message: line });
      return;
    }
    if (message.type === 'backend:ready') {
      this.readyResolve?.(message);
      this.readyResolve = null;
      this.readyReject = null;
      this.startupStderr = [];
      return;
    }
    if (['task:completed', 'task:error', 'task:cancelled'].includes(message.type)) {
      this.currentJobId = null;
    }
    this.emit('event', message);
    if (!this.isRunning) this.emit('idle');
  }

  handleProcessFailure(error) {
    this.readyReject?.(error);
    this.emit('event', { type: 'task:error', message: `Could not start the Python backend: ${error.message}` });
  }

  handleExit(code, signal) {
    const wasRunning = this.isRunning;
    const startupReject = this.readyReject;
    const startupDetail = this.startupStderr.at(-1);
    this.child = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.startupStderr = [];
    this.currentJobId = null;
    if (!this.intentionalShutdown && startupReject) {
      const reason = signal || `exit code ${code}`;
      const detail = startupDetail ? ` Last error: ${startupDetail}` : '';
      startupReject(new Error(`The Python backend exited before it was ready (${reason}).${detail}`));
    }
    if (!this.intentionalShutdown && wasRunning) {
      this.emit('event', {
        type: 'task:error',
        message: `The Python backend stopped unexpectedly (${signal || `exit code ${code}`}).`
      });
    }
    this.emit('idle');
  }

  send(command) {
    if (!this.child || !this.child.stdin.writable) throw new Error('The Python backend is not ready.');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async start(inputPath, outputDir) {
    if (this.isRunning) throw new Error('Another task is already running.');
    await this.ensureStarted();
    const jobId = crypto.randomUUID();
    this.currentJobId = jobId;
    this.send({ type: 'task:start', jobId, inputPath, outputDir });
    return { jobId };
  }

  cancel() {
    if (!this.isRunning) return false;
    this.send({ type: 'task:cancel', jobId: this.currentJobId });
    return true;
  }

  async shutdown(timeoutMs = 3000) {
    if (!this.child) return;
    this.intentionalShutdown = true;
    const child = this.child;
    try {
      this.send({ type: 'backend:shutdown' });
    } catch {}
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM');
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

module.exports = { BackendProcess };
