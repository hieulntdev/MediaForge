'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { redactSecrets, TERMINAL_STATES } = require('../../../../apps/desktop/shared/protocol');
const { DownloadManager } = require('./download-manager');
const { HongguoStore } = require('./persistence');
const { HongguoSiteAdapter, normalizeHongguoUrl } = require('./site-adapter');

const JOB_TERMINAL = new Set(['Completed', 'Failed', 'Cancelled']);

function clone(value) { return structuredClone(value); }
function timestamp() { return new Date().toISOString(); }
function safeMessage(value) {
  return redactSecrets(value).replace(/(https:\/\/[^\s?]+)\?[^\s]+/gi, '$1?***');
}

class HongguoAdapter extends EventEmitter {
  constructor(context) {
    super();
    Object.assign(this, context);
    this.site = new HongguoSiteAdapter();
    this.store = new HongguoStore(this.pathService);
    this.state = this.store.load();
    if (!this.state.settings.outputDir) this.state.settings.outputDir = this.pathService.outputs;
    this.activeTaskId = null;
    this.manager = null;
    this.analysisController = null;
    this.lastProgressEmission = 0;
  }

  snapshot() { return clone(this.state); }

  persist() {
    try { this.store.save(this.state); } catch (error) { console.warn('Could not save Hongguo state:', error.message); }
  }

  publish(type = 'state', payload = {}, { persist = true } = {}) {
    this.state.revision += 1;
    if (persist) this.persist();
    this.emit('event', { type, ...payload, snapshot: this.snapshot() });
  }

  log(level, message, { publish = true } = {}) {
    const value = { timestamp: timestamp(), level: String(level || 'INFO'), message: safeMessage(message) };
    this.state.logs.push(value);
    if (this.state.logs.length > 500) this.state.logs.splice(0, this.state.logs.length - 500);
    if (this.activeTaskId) {
      try { this.taskManager.addLog(this.activeTaskId, value.level, value.message); } catch { /* A terminal task may already be detached. */ }
    }
    if (publish) this.publish('log', { log: value });
  }

  currentTask() {
    if (!this.activeTaskId) return null;
    try { return this.taskManager.get(this.activeTaskId); } catch { return null; }
  }

  ensureIdle() {
    const task = this.currentTask();
    if (task && !TERMINAL_STATES.has(task.state)) throw new Error('A Hongguo operation is already active.');
  }

  isBusy() { return this.state.phase !== 'idle' || Boolean(this.analysisController || this.manager); }

  createTask(action, input) {
    const task = this.taskManager.create({
      module: this.manifest.id, action, input,
      capabilities: this.manifest.capabilities, resourceClass: this.manifest.resourceClass
    });
    this.activeTaskId = task.id;
    this.taskManager.transition(task.id, 'RUNNING', { stage: action === 'analyze' ? 'analyzing' : 'downloading' });
    return task;
  }

  execute(action, payload = {}) {
    switch (action) {
      case 'get_state': return { snapshot: this.snapshot(), task: this.currentTask() ? clone(this.currentTask()) : null };
      case 'get_settings': return clone(this.state.settings);
      case 'set_settings': return this.setSettings(payload.settings || payload);
      case 'analyze': return this.analyze(payload);
      case 'add_to_queue': return this.addToQueue(payload);
      case 'start': return this.start(payload);
      case 'pause': return this.pause(this.activeTaskId);
      case 'resume': return this.resume(this.activeTaskId);
      case 'cancel': return this.cancel(this.activeTaskId);
      case 'retry_failed': return this.retryFailed();
      case 'remove_completed': return this.removeCompleted();
      case 'clear_queue': return this.clearQueue();
      case 'clear_log': this.state.logs = []; this.publish('state'); return { cleared: true };
      default: throw new Error(`Unsupported Hongguo action: ${action}`);
    }
  }

  setSettings(values) {
    if (values.outputDir !== undefined) {
      if (typeof values.outputDir !== 'string' || !path.isAbsolute(values.outputDir)) throw new Error('Choose an absolute output folder.');
      this.state.settings.outputDir = path.resolve(values.outputDir);
    }
    if (values.quality !== undefined) {
      const quality = String(values.quality);
      if (!['best', '2160p', '1440p', '1080p', '720p', '480p'].includes(quality)) throw new Error('Invalid quality preference.');
      this.state.settings.quality = quality;
    }
    if (values.concurrentDownloads !== undefined) this.state.settings.concurrentDownloads = Math.max(1, Math.min(6, Number(values.concurrentDownloads) || 3));
    if (values.segmentConcurrency !== undefined) this.state.settings.segmentConcurrency = Math.max(1, Math.min(16, Number(values.segmentConcurrency) || 8));
    if (values.duplicateHandling !== undefined) {
      if (!['skip', 'rename', 'replace'].includes(values.duplicateHandling)) throw new Error('Invalid duplicate handling setting.');
      this.state.settings.duplicateHandling = values.duplicateHandling;
    }
    this.publish('settings');
    return clone(this.state.settings);
  }

  analyze(payload) {
    this.ensureIdle();
    const values = Array.isArray(payload.urls) ? payload.urls : String(payload.urls || '').split(/\r?\n/);
    const urls = [...new Set(values.map((value) => value.trim()).filter(Boolean).map(normalizeHongguoUrl))];
    if (!urls.length) throw new Error('Paste at least one supported Hongguo URL.');
    if (urls.length > 100) throw new Error('Analyze at most 100 URLs at a time.');
    const task = this.createTask('analyze', { urls });
    this.analysisController = new AbortController();
    this.state.phase = 'analyzing'; this.state.discovered = [];
    this.log('INFO', `Analyzing ${urls.length} Hongguo URL${urls.length === 1 ? '' : 's'}.`);
    void this.runAnalysis(task.id, urls);
    return { taskId: task.id, accepted: true };
  }

  async runAnalysis(taskId, urls) {
    const seriesById = new Map();
    const episodesById = new Map();
    let inspected = 0;
    try {
      for (const url of urls) {
        const result = await this.site.getSeriesInfo(url, { signal: this.analysisController.signal });
        seriesById.set(result.series.id, result.series);
        for (const episode of result.episodes) episodesById.set(episode.id, episode);
        this.log('INFO', `Found ${result.episodes.length} episode${result.episodes.length === 1 ? '' : 's'} for ${result.series.title}.`);
      }
      const episodes = [...episodesById.values()];
      this.state.discovered = episodes;
      const concurrency = Math.min(3, episodes.length || 1);
      let cursor = 0;
      const worker = async () => {
        while (cursor < episodes.length) {
          const episode = episodes[cursor++];
          try {
            episode.status = 'Analyzing'; this.publish('episode', { episode: clone(episode) }, { persist: false });
            const sources = await this.site.getMediaSources(episode, { signal: this.analysisController.signal });
            episode.qualities = [...new Set(sources.map((source) => source.quality).filter(Boolean))];
            const best = sources.sort((a, b) => Math.min(b.width || 0, b.height || 0) - Math.min(a.width || 0, a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
            episode.resolution = best.resolution || best.quality || 'Unknown';
            episode.status = 'Ready'; episode.detail = `${best.type.toUpperCase()} source detected`;
          } catch (error) {
            if (this.analysisController?.signal.aborted) throw error;
            episode.status = 'Failed'; episode.detail = safeMessage(error.message);
          }
          inspected += 1;
          this.taskManager.setProgress(taskId, { current: inspected, total: episodes.length, percent: episodes.length ? inspected * 100 / episodes.length : 100 });
          this.publish('episode', { episode: clone(episode) }, { persist: false });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      this.state.series = [...seriesById.values()];
      this.state.discovered = episodes;
      this.state.phase = 'idle';
      this.taskManager.transition(taskId, 'COMPLETED', { stage: 'analyzed' });
      this.log('SUCCESS', `Analysis completed: ${episodes.filter((episode) => episode.status === 'Ready').length}/${episodes.length} episodes ready.`);
      this.publish('analysis_done');
    } catch (error) {
      this.state.phase = 'idle';
      const cancelled = this.analysisController?.signal.aborted;
      this.taskManager.transition(taskId, cancelled ? 'CANCELLED' : 'FAILED', {
        stage: cancelled ? 'cancelled' : 'analyzing',
        error: cancelled ? undefined : { code: 'ANALYZE_FAILED', message: error.message, retryable: true }
      });
      this.log(cancelled ? 'WARNING' : 'ERROR', cancelled ? 'Analysis cancelled.' : `Analysis failed: ${error.message}`);
      this.publish('analysis_done');
    } finally { this.analysisController = null; }
  }

  addToQueue(payload) {
    const hasIds = Array.isArray(payload.ids);
    const ids = new Set(hasIds ? payload.ids.map(String) : []);
    const selected = this.state.discovered.filter((episode) => (!hasIds || ids.has(episode.id)) && episode.status === 'Ready');
    const existing = new Set(this.state.jobs.map((job) => job.id));
    let added = 0;
    for (const episode of selected) {
      const id = `hongguo-${episode.id}`;
      if (existing.has(id)) continue;
      this.state.jobs.push({
        id, episode: clone(episode), selected: true, status: 'Queued', detail: '',
        progress: 0, speed: 0, eta: '', outputPath: '', attempts: 0
      });
      existing.add(id); added += 1;
    }
    this.log('INFO', `Added ${added} episode${added === 1 ? '' : 's'} to the queue.`);
    this.publish('queue');
    return { added, total: this.state.jobs.length };
  }

  start(payload = {}) {
    this.ensureIdle();
    if (payload.settings) this.setSettings(payload.settings);
    const requestedIds = Array.isArray(payload.ids) ? new Set(payload.ids.map(String)) : null;
    if (requestedIds) for (const job of this.state.jobs) job.selected = requestedIds.has(job.id);
    const runnable = this.state.jobs.filter((job) => job.selected !== false && ['Queued', 'Ready', 'Paused', 'Failed', 'Cancelled'].includes(job.status));
    if (!runnable.length) throw new Error('The queue has no selected episodes to download.');
    if (!this.state.settings.outputDir) throw new Error('Choose an output folder first.');
    const task = this.createTask('start', { jobIds: runnable.map((job) => job.id), outputDir: this.state.settings.outputDir });
    for (const job of runnable) { job.status = 'Queued'; job.detail = ''; job.speed = 0; job.eta = ''; }
    this.state.phase = 'downloading'; this.state.paused = false;
    this.manager = new DownloadManager({
      adapter: this.site, processManager: this.processManager,
      ffmpeg: this.ffmpegLocator.resolve(), ffprobe: this.ffprobeLocator.resolve(),
      partialsDirectory: this.store.partials
    });
    this.bindManager(this.manager, task.id);
    this.log('INFO', `Starting ${runnable.length} download${runnable.length === 1 ? '' : 's'} with concurrency ${this.state.settings.concurrentDownloads}.`);
    void this.runQueue(task.id, runnable);
    return { taskId: task.id, accepted: true };
  }

  bindManager(manager, taskId) {
    manager.on('retry', (job, attempt, delay, status) => {
      job.attempts = attempt;
      this.log('WARNING', `${job.episode.title}: retry ${attempt} in ${Math.ceil(delay / 1000)}s${status ? ` after HTTP ${status}` : ''}.`);
    });
    manager.on('source', (job, source, sources) => {
      job.episode.resolution = source.resolution || source.quality || 'Unknown';
      const unavailable = job.settings.quality !== 'best' && source.quality !== job.settings.quality;
      this.log(unavailable ? 'WARNING' : 'INFO', `${job.episode.title}: selected ${source.type.toUpperCase()} ${source.quality || 'source'} from ${sources.length} option${sources.length === 1 ? '' : 's'}${unavailable ? `; ${job.settings.quality} was unavailable` : ''}.`);
      this.publish('job', { job: clone(job) });
    });
    manager.on('status', (job, status, detail) => {
      job.status = status; job.detail = detail; job.speed = 0; job.eta = '';
      this.log('INFO', `${job.episode.title}: ${detail}`);
      this.publish('job', { job: clone(job) });
      this.taskManager.setStage(taskId, status.toLowerCase());
    });
    manager.on('progress', (job, progress) => {
      Object.assign(job, progress, { status: this.manager?.paused ? 'Paused' : 'Downloading' });
      const now = Date.now();
      if (now - this.lastProgressEmission >= 250 || progress.progress >= 100) {
        this.lastProgressEmission = now;
        this.publish('progress', { job: clone(job) }, { persist: false });
      }
    });
  }

  async runQueue(taskId, jobs) {
    let cursor = 0; let finished = 0;
    const concurrency = Math.min(Math.max(1, Number(this.state.settings.concurrentDownloads) || 3), jobs.length);
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        if (this.manager.cancelled) break;
        job.settings = clone(this.state.settings);
        job.status = 'Downloading'; job.detail = 'Resolving public media source…'; job.attempts += 1;
        this.log('INFO', `Download started: ${job.episode.seriesTitle} / ${job.episode.title}.`);
        this.publish('job', { job: clone(job) });
        try {
          const outputPath = await this.manager.runJob(job);
          job.outputPath = outputPath; job.status = 'Completed'; job.progress = 100; job.speed = 0; job.eta = ''; job.detail = 'Verified';
          this.taskManager.addOutput(taskId, {
            id: `artifact-${job.id}`, type: 'media.video', uri: pathToFileURL(outputPath).href,
            mimeType: outputPath.toLowerCase().endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
            metadata: { title: job.episode.title, series: job.episode.seriesTitle, sourceUrl: job.episode.url },
            producer: { taskId, module: this.manifest.id, action: 'start' }, ownership: 'user-output'
          });
          this.log('SUCCESS', `Completed: ${job.episode.title}.`);
        } catch (error) {
          job.speed = 0; job.eta = '';
          if (this.manager.cancelled) { job.status = 'Cancelled'; job.detail = 'Cancelled by user.'; }
          else { job.status = 'Failed'; job.detail = safeMessage(error.message); this.log('ERROR', `${job.episode.title}: ${error.message}`); }
        }
        delete job.settings;
        finished += 1;
        this.taskManager.setProgress(taskId, { current: finished, total: jobs.length, percent: finished * 100 / jobs.length });
        this.publish('job', { job: clone(job) });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const task = this.taskManager.get(taskId);
    const cancelled = this.manager.cancelled;
    this.manager = null; this.state.phase = 'idle'; this.state.paused = false;
    if (!TERMINAL_STATES.has(task.state)) {
      const failures = jobs.filter((job) => job.status === 'Failed').length;
      if (cancelled) this.taskManager.transition(taskId, 'CANCELLED', { stage: 'cancelled' });
      else if (failures === jobs.length) this.taskManager.transition(taskId, 'FAILED', { stage: 'failed', error: { code: 'DOWNLOAD_FAILED', message: 'All selected downloads failed.', retryable: true } });
      else this.taskManager.transition(taskId, 'COMPLETED', { stage: failures ? 'completed_with_errors' : 'completed' });
    }
    this.log(cancelled ? 'WARNING' : 'INFO', cancelled ? 'Queue cancelled.' : 'Queue processing finished.');
    this.publish('queue_done');
  }

  pause(taskId) {
    if (!this.manager || !taskId) return { paused: false };
    this.manager.pause(); this.state.paused = true;
    for (const job of this.state.jobs) if (job.status === 'Downloading') { job.status = 'Paused'; job.speed = 0; job.eta = ''; }
    const task = this.taskManager.get(taskId);
    if (task.state === 'RUNNING') this.taskManager.transition(taskId, 'PAUSED', { stage: task.stage });
    this.log('INFO', 'Downloads paused. Active network chunks will stop at a safe boundary.');
    this.publish('pause'); return { paused: true };
  }

  resume(taskId) {
    if (!this.manager || !taskId) return this.start();
    this.manager.resume(); this.state.paused = false;
    for (const job of this.state.jobs) if (job.status === 'Paused') job.status = 'Downloading';
    const task = this.taskManager.get(taskId);
    if (task.state === 'PAUSED') this.taskManager.transition(taskId, 'RUNNING', { stage: task.stage });
    this.log('INFO', 'Downloads resumed.'); this.publish('resume'); return { resumed: true };
  }

  async cancel(taskId) {
    if (this.analysisController) {
      this.analysisController.abort(new Error('Cancelled.'));
      return { cancelled: true };
    }
    if (!this.manager || !taskId) return { cancelled: false };
    const task = this.taskManager.get(taskId);
    if (['RUNNING', 'PAUSED'].includes(task.state)) this.taskManager.transition(taskId, 'CANCELLING', { stage: task.stage });
    await this.manager.cancel();
    return { cancelled: true };
  }

  retryFailed() {
    for (const job of this.state.jobs) if (job.status === 'Failed') { job.status = 'Queued'; job.detail = ''; job.selected = true; }
    this.publish('queue');
    return this.start();
  }

  removeCompleted() {
    this.ensureIdle();
    const before = this.state.jobs.length;
    this.state.jobs = this.state.jobs.filter((job) => job.status !== 'Completed');
    this.publish('queue'); return { removed: before - this.state.jobs.length };
  }

  clearQueue() {
    this.ensureIdle();
    for (const job of this.state.jobs) this.store.removePartial(job.id);
    this.state.jobs = []; this.publish('queue'); return { cleared: true };
  }

  resetToDefaults() {
    this.ensureIdle();
    const settings = this.store.resetToDefaults(this.pathService.outputs);
    this.state = {
      revision: 0, phase: 'idle', paused: false, settings,
      series: [], discovered: [], jobs: [], logs: []
    };
    this.activeTaskId = null;
    this.manager = null;
    this.analysisController = null;
    this.lastProgressEmission = 0;
    this.persist();
    return { reset: true };
  }

  async shutdown() {
    this.analysisController?.abort(new Error('Application is closing.'));
    if (this.manager) await this.manager.cancel();
    this.persist();
  }
}

function createAdapter(context) { return new HongguoAdapter(context); }
function cleanupSession({ pathService }) { new HongguoStore(pathService).cleanupSession(); }
module.exports = { HongguoAdapter, cleanupSession, createAdapter, JOB_TERMINAL };
