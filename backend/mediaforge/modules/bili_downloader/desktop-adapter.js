'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseProtocolLine, redactSecrets, TERMINAL_STATES } = require('../../../../apps/desktop/shared/protocol');
const DownloadState = require('../../../../Bili-Downloader/electron-app/download-state');

const DEFAULT_SETTINGS = Object.freeze({
  video_quality: 'Maximum Accessible', audio_quality: 'Maximum Accessible',
  codec: 'Auto / Maximum Quality', container: 'Auto', download_subtitle: true,
  subtitle_format: 'srt', concurrent_fragments: 4, retry: 5,
  delete_temp: true, ratelimit: 0
});

class BiliAdapter extends EventEmitter {
  constructor(context) {
    super();
    Object.assign(this, context);
    this.worker = null;
    this.activeTaskId = null;
    this.auxiliaryBusy = false;
    this.cancelRequested = false;
    this.items = [];
    this.completedRows = new Set();
    this.snapshot = DownloadState.createSnapshot();
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
    this.worker.on('error', (error) => { this.auxiliaryBusy = false; this.failActive('BACKEND_START_FAILED', error.message); });
    this.worker.on('exit', ({ code, signal, intentional }) => {
      if (!intentional) this.failActive('BACKEND_EXITED', `Bili backend stopped (${signal || `exit ${code}`}).`);
      this.worker = null;
      this.auxiliaryBusy = false;
      this.emit('event', DownloadState.snapshotWithEvent(
        this.snapshot,
        { type: 'process_exit', code, signal },
      ));
    });
    return this.worker;
  }

  execute(action, payload) {
    const commandMap = {
      check_account: 'check_account', get_settings: 'get_settings', set_settings: 'save_settings',
      analyze: 'analyze', download: 'analyze', pause: 'pause', resume: 'resume', cancel: 'cancel'
    };
    if (action === 'get_state') return this.getState();
    if (['pause', 'resume', 'cancel'].includes(action)) return this[action](this.activeTaskId);
    const worker = this.ensureWorker();
    if (['check_account', 'get_settings', 'set_settings'].includes(action)) {
      if (action === 'check_account') this.auxiliaryBusy = true;
      try {
        worker.send({ command: commandMap[action], ...payload });
      } catch (error) {
        if (action === 'check_account') this.auxiliaryBusy = false;
        throw error;
      }
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
    DownloadState.begin(this.snapshot, payload, { retry: Boolean(retryIndices) });
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
    const event = DownloadState.snapshotWithEvent(this.snapshot, raw);
    if (raw.type === 'account') this.auxiliaryBusy = false;
    this.items = this.snapshot.items;
    this.emit('event', event);
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
    DownloadState.setControlState(this.snapshot, 'pause');
    return { paused: true };
  }

  resume(taskId) {
    if (!taskId) return { resumed: false };
    this.ensureWorker().send({ command: 'resume' });
    const task = this.taskManager.get(taskId);
    if (task.state === 'PAUSED') this.taskManager.transition(taskId, 'RUNNING', { stage: task.stage });
    DownloadState.setControlState(this.snapshot, 'resume');
    return { resumed: true };
  }

  cancel(taskId) {
    if (!taskId) return { cancelled: false };
    this.cancelRequested = true;
    const task = this.taskManager.get(taskId);
    if (['RUNNING', 'PAUSED'].includes(task.state)) this.taskManager.transition(taskId, 'CANCELLING', { stage: task.stage });
    DownloadState.setControlState(this.snapshot, 'cancel');
    this.ensureWorker().send({ command: 'cancel' });
    return { cancelled: true };
  }

  failActive(code, message) {
    if (!this.activeTaskId) return;
    const task = this.taskManager.get(this.activeTaskId);
    if (!TERMINAL_STATES.has(task.state)) this.taskManager.transition(task.id, 'FAILED', { error: { code, message, retryable: true } });
  }

  getState() {
    let task = null;
    if (this.activeTaskId) {
      try {
        task = structuredClone(this.taskManager.get(this.activeTaskId));
      } catch {
        task = null;
      }
    }
    return { snapshot: DownloadState.clone(this.snapshot), task };
  }

  isBusy() { return this.auxiliaryBusy; }

  async resetToDefaults() {
    const active = this.activeTaskId ? this.taskManager.get(this.activeTaskId) : null;
    if (active && !TERMINAL_STATES.has(active.state)) throw new Error('Cannot reset Bili Downloader while a download is active.');
    await this.worker?.terminate();
    this.worker = null;
    this.activeTaskId = null;
    this.auxiliaryBusy = false;
    this.cancelRequested = false;
    this.items = [];
    this.completedRows.clear();
    this.snapshot = DownloadState.createSnapshot();
    fs.rmSync(path.join(this.pathService.temp, 'bili-downloader'), { recursive: true, force: true });
    const directory = path.join(this.pathService.config, 'bili-downloader');
    const filePath = path.join(directory, 'settings.json');
    fs.mkdirSync(directory, { recursive: true });
    const partial = `${filePath}.part`;
    fs.writeFileSync(partial, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
    fs.renameSync(partial, filePath);
    return { reset: true };
  }

  shutdown() { return this.worker?.terminate(); }
}

function createAdapter(context) { return new BiliAdapter(context); }
async function cleanupSession() {}
module.exports = { BiliAdapter, cleanupSession, createAdapter, DEFAULT_SETTINGS };
