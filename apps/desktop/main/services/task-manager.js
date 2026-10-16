'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { TASK_STATES, TERMINAL_STATES, redactSecrets } = require('../../shared/protocol');

const TRANSITIONS = Object.freeze({
  PENDING: new Set(['RUNNING', 'CANCELLED', 'FAILED']),
  RUNNING: new Set(['PAUSED', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  PAUSED: new Set(['RUNNING', 'CANCELLING', 'FAILED', 'CANCELLED']),
  CANCELLING: new Set(['CANCELLED', 'FAILED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set()
});

function now() { return new Date().toISOString(); }

class TaskManager extends EventEmitter {
  constructor({ pathService, maxLogs = 500 }) {
    super();
    this.pathService = pathService;
    this.maxLogs = maxLogs;
    this.tasks = new Map();
  }

  create({ module, action, input = {}, capabilities = {}, resourceClass = 'light' }) {
    const id = crypto.randomUUID();
    const task = {
      id, module, action, state: 'PENDING', stage: 'pending',
      progress: { current: 0, total: 0, percent: 0, indeterminate: true },
      input, outputs: [], logs: [], error: null,
      createdAt: now(), startedAt: null, finishedAt: null,
      capabilities: {
        cancel: Boolean(capabilities.cancel),
        pause: Boolean(capabilities.pause),
        resume: Boolean(capabilities.pause),
        retry: true
      },
      resourceClass,
      workspace: this.pathService.taskWorkspace(id)
    };
    this.tasks.set(id, task);
    this._emit('task.created', task);
    return task;
  }

  get(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  list() { return [...this.tasks.values()].map((task) => structuredClone(task)); }
  active() { return [...this.tasks.values()].filter((task) => !TERMINAL_STATES.has(task.state)); }
  activeForModule(moduleId) { return this.active().filter((task) => task.module === moduleId); }
  hasActiveResource(resourceClass) { return this.active().some((task) => task.resourceClass === resourceClass); }

  clearModule(moduleId) {
    if (this.activeForModule(moduleId).length) throw new Error('Cannot clear tasks while the module is processing.');
    let cleared = 0;
    for (const [taskId, task] of this.tasks) {
      if (task.module !== moduleId) continue;
      const workspace = this.pathService.taskWorkspace(taskId);
      fs.rmSync(workspace, { recursive: true, force: true });
      this.tasks.delete(taskId);
      cleared += 1;
    }
    return cleared;
  }

  transition(taskId, state, { stage, error } = {}) {
    if (!TASK_STATES.includes(state)) throw new TypeError(`Invalid task state: ${state}`);
    const task = this.get(taskId);
    if (task.state === state) return task;
    if (!TRANSITIONS[task.state].has(state)) {
      throw new Error(`Invalid task transition: ${task.state} -> ${state}`);
    }
    task.state = state;
    if (stage !== undefined) task.stage = stage;
    if (state === 'RUNNING' && !task.startedAt) task.startedAt = now();
    if (TERMINAL_STATES.has(state)) task.finishedAt = now();
    if (error) task.error = {
      code: String(error.code || 'TASK_FAILED'),
      message: redactSecrets(error.message || 'The task failed.'),
      detail: redactSecrets(error.detail || ''),
      retryable: Boolean(error.retryable)
    };
    this._emit('task.state', task);
    return task;
  }

  setStage(taskId, stage) {
    const task = this.get(taskId);
    if (TERMINAL_STATES.has(task.state)) return task;
    task.stage = String(stage || 'running');
    this._emit('task.stage', task);
    return task;
  }

  setProgress(taskId, progress) {
    const task = this.get(taskId);
    if (TERMINAL_STATES.has(task.state)) return task;
    const current = Number(progress.current || 0);
    const total = Number(progress.total || 0);
    const explicit = Number(progress.percent);
    const percent = Number.isFinite(explicit) ? explicit : (total > 0 ? (current / total) * 100 : task.progress.percent);
    task.progress = {
      current: Number.isFinite(current) ? current : 0,
      total: Number.isFinite(total) ? total : 0,
      percent: Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)),
      indeterminate: Boolean(progress.indeterminate ?? total <= 0)
    };
    this._emit('task.progress', task);
    return task;
  }

  addLog(taskId, level, message) {
    const task = this.get(taskId);
    task.logs.push({ timestamp: now(), level: String(level || 'INFO'), message: redactSecrets(message) });
    if (task.logs.length > this.maxLogs) task.logs.splice(0, task.logs.length - this.maxLogs);
    this._emit('task.log', task, { log: task.logs.at(-1) });
  }

  addOutput(taskId, artifact) {
    const task = this.get(taskId);
    task.outputs.push(structuredClone(artifact));
    this._emit('task.output', task, { artifact });
  }

  _emit(event, task, extra = {}) {
    this.emit('event', {
      schemaVersion: 1,
      event,
      taskId: task.id,
      module: task.module,
      action: task.action,
      timestamp: now(),
      payload: { task: structuredClone(task), ...extra }
    });
  }
}

module.exports = { TaskManager, TRANSITIONS };
