'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseProtocolLine, redactSecrets, TERMINAL_STATES } = require('../../../../apps/desktop/shared/protocol');

class BiliAdapter extends EventEmitter {
  constructor(context) {
    super();
    Object.assign(this, context);
    this.worker = null;
    this.activeTaskId = null;
    this.cancelRequested = false;
    this.items = [];
    this.completedRows = new Set();
  }

  ensureWorker() {
    if (this.worker?.child) return this.worker;
    const project = path.join(this.pathService.projectRoot, 'Bili-Downloader');
    const executable = this.runtimeResolver.resolve(this.manifest.runtime);
    this.worker = this.processManager.persistentProcess(this.manifest.id, {
      executable,
      args: ['-u', path.join(project, 'backend_entry.py')],
      cwd: project,
      env: {
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        MEDIAFORGE_DATA_DIR: this.pathService.userData,
        MEDIAFORGE_FFMPEG: this.ffmpegLocator.resolve(),
        MEDIAFORGE_FFPROBE: this.ffprobeLocator.resolve()
      }
    });
    this.worker.on('line', ({ line }) => this.handleLine(line));
    this.worker.on('error', (error) => this.failActive('BACKEND_START_FAILED', error.message));
    this.worker.on('exit', ({ code, signal, intentional }) => {
      if (!intentional) this.failActive('BACKEND_EXITED', `Bili backend stopped (${signal || `exit ${code}`}).`);
      this.worker = null;
      this.emit('event', { type: 'process_exit', code, signal });
    });
    return this.worker;
  }

  execute(action, payload) {
    const commandMap = {
      check_account: 'check_account', get_settings: 'get_settings', set_settings: 'save_settings',
      analyze: 'analyze', download: 'analyze', pause: 'pause', resume: 'resume', cancel: 'cancel'
    };
    if (['pause', 'resume', 'cancel'].includes(action)) return this[action](this.activeTaskId);
    const worker = this.ensureWorker();
    if (['check_account', 'get_settings', 'set_settings'].includes(action)) {
      worker.send({ command: commandMap[action], ...payload });
      return { accepted: true };
    }
    if (this.activeTaskId) {
      const active = this.taskManager.get(this.activeTaskId);
      if (!TERMINAL_STATES.has(active.state)) throw new Error('A Bili task is already active.');
    }
    const retryIndices = Array.isArray(payload.indices) ? payload.indices.map(Number) : null;
    const task = this.taskManager.create({
      module: this.manifest.id, action, input: payload,
      capabilities: this.manifest.capabilities, resourceClass: this.manifest.resourceClass
    });
    this.activeTaskId = task.id;
    this.cancelRequested = false;
    if (!retryIndices) this.items = [];
    this.completedRows.clear();
    this.taskManager.transition(task.id, 'RUNNING', { stage: retryIndices ? 'downloading' : 'analyzing' });
    if (retryIndices) worker.send({ command: 'download', indices: retryIndices });
    else worker.send({ command: commandMap[action], ...payload, auto_download: action === 'download' });
    return { taskId: task.id, task: structuredClone(task) };
  }

  handleLine(line) {
    const parsed = parseProtocolLine(line, 'BILI_EVENT ');
    if (!parsed) return;
    const raw = parsed.kind === 'event'
      ? parsed.payload
      : { type: 'log', level: 'INFO', message: parsed.message };
    if (raw.type === 'log') raw.message = redactSecrets(raw.message);
    this.emit('event', raw);
    const taskId = this.activeTaskId;
    if (!taskId) return;
    const task = this.taskManager.get(taskId);
    if (TERMINAL_STATES.has(task.state)) return;
    if (raw.type === 'log') this.taskManager.addLog(taskId, raw.level, raw.message);
    if (raw.type === 'analyze_progress') {
      this.taskManager.setStage(taskId, 'analyzing');
      this.taskManager.setProgress(taskId, { current: raw.index, total: raw.total, percent: 0, indeterminate: true });
    } else if (raw.type === 'analyze_done') {
      this.items = raw.items || [];
      this.taskManager.setStage(taskId, task.action === 'download' ? 'downloading' : 'analyzed');
      this.taskManager.setProgress(taskId, { current: 0, total: raw.total, percent: 0, indeterminate: false });
      if (task.action === 'analyze') this.taskManager.transition(taskId, 'COMPLETED', { stage: 'analyzed' });
    } else if (raw.type === 'analyze_failed') {
      this.taskManager.transition(taskId, 'FAILED', { stage: 'analyzing', error: { code: 'ANALYZE_FAILED', message: raw.message, retryable: true } });
    } else if (raw.type === 'row_update' && ['Done', 'Completed'].includes(raw.status)) {
      this.completedRows.add(Number(raw.row));
      const total = this.items.length;
      this.taskManager.setProgress(taskId, { current: this.completedRows.size, total, percent: total ? this.completedRows.size * 100 / total : 0 });
      const item = this.items.find((value) => Number(value.row) === Number(raw.row));
      if (item?.output_path) {
        this.taskManager.addOutput(taskId, {
          id: `artifact-${taskId}-${raw.row}`,
          type: 'media.video', uri: pathToFileURL(item.output_path).href,
          mimeType: item.output_path.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
          metadata: { title: item.title, sourceUrl: item.url },
          producer: { taskId, module: this.manifest.id, action: task.action },
          ownership: 'user-output'
        });
      }
    } else if (raw.type === 'progress') {
      const total = this.items.length;
      const percent = total ? (this.completedRows.size + Number(raw.fraction || 0)) * 100 / total : 0;
      this.taskManager.setProgress(taskId, { current: this.completedRows.size, total, percent });
    } else if (raw.type === 'download_done') {
      if (this.cancelRequested) this.taskManager.transition(taskId, 'CANCELLED', { stage: 'cancelled' });
      else this.taskManager.transition(taskId, 'COMPLETED', { stage: 'completed' });
    }
  }

  pause(taskId) {
    if (!taskId) return { paused: false };
    this.ensureWorker().send({ command: 'pause' });
    const task = this.taskManager.get(taskId);
    if (task.state === 'RUNNING') this.taskManager.transition(taskId, 'PAUSED', { stage: task.stage });
    return { paused: true };
  }

  resume(taskId) {
    if (!taskId) return { resumed: false };
    this.ensureWorker().send({ command: 'resume' });
    const task = this.taskManager.get(taskId);
    if (task.state === 'PAUSED') this.taskManager.transition(taskId, 'RUNNING', { stage: task.stage });
    return { resumed: true };
  }

  cancel(taskId) {
    if (!taskId) return { cancelled: false };
    this.cancelRequested = true;
    const task = this.taskManager.get(taskId);
    if (['RUNNING', 'PAUSED'].includes(task.state)) this.taskManager.transition(taskId, 'CANCELLING', { stage: task.stage });
    this.ensureWorker().send({ command: 'cancel' });
    return { cancelled: true };
  }

  failActive(code, message) {
    if (!this.activeTaskId) return;
    const task = this.taskManager.get(this.activeTaskId);
    if (!TERMINAL_STATES.has(task.state)) this.taskManager.transition(task.id, 'FAILED', { error: { code, message, retryable: true } });
  }

  shutdown() { return this.worker?.terminate(); }
}

function createAdapter(context) { return new BiliAdapter(context); }
module.exports = { BiliAdapter, createAdapter };
