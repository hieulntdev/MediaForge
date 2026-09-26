'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseProtocolLine, TERMINAL_STATES } = require('../../../../apps/desktop/shared/protocol');

const MODEL = Object.freeze({
  dataset: 'dnr',
  name: 'locoformer-medium.enc-crossattn96dim.dec-crossattn96dim.musical64.learnable-query',
  revision: '0827e70a9e0c6f21b9b46cb9dfe4f7e4ebd307c5',
  checkpointSha256: 'b878ea0ffe29c67401727d51cdaab8db0394178d8e0eafa9d2ca5e241fd472e2',
  configSha256: '4d0d1ffc3ff80f162f288d31477d6a0699578bbf00f11b8fd091580668c12adb'
});

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => digest.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(digest.digest('hex')));
  });
}

class SfxAdapter extends EventEmitter {
  constructor(context) {
    super();
    Object.assign(this, context);
    this.worker = null;
    this.activeTaskId = null;
    this.ready = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.prefetchProcess = null;
  }

  modelDirectory() { return path.join(this.pathService.models, 'sfx'); }

  resourceClassFor(action) {
    return ['extract_sfx', 'prefetch_model'].includes(action) ? 'heavy' : 'light';
  }

  launch() {
    const project = path.join(this.pathService.projectRoot, 'SFX-Converter');
    return {
      executable: this.runtimeResolver.resolve(this.manifest.runtime),
      args: ['-u', '-m', 'app.backend'], cwd: project,
      env: {
        PYTHONUNBUFFERED: '1',
        SFX_CONVERTER_DATA_DIR: this.pathService.userData,
        SFX_CONVERTER_MODEL_DIR: this.modelDirectory(),
        SFX_CONVERTER_LOG_DIR: this.pathService.logs,
        MEDIAFORGE_FFMPEG: this.ffmpegLocator.resolve(),
        MEDIAFORGE_FFPROBE: this.ffprobeLocator.resolve()
      }
    };
  }

  async ensureWorker() {
    if (this.worker?.child && this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.worker = this.processManager.persistentProcess(this.manifest.id, this.launch());
    this.worker.on('line', ({ line, source }) => this.handleLine(line, source));
    this.worker.on('error', (error) => { this.readyReject?.(error); this.failActive('BACKEND_START_FAILED', error.message); });
    this.worker.on('exit', ({ code, signal, intentional }) => {
      if (!intentional) this.failActive('BACKEND_EXITED', `SFX backend stopped (${signal || `exit ${code}`}).`);
      this.worker = null; this.ready = null;
    });
    const timer = setTimeout(() => this.readyReject?.(new Error('The SFX backend timed out during startup.')), 30000);
    this.ready.finally(() => clearTimeout(timer)).catch(() => {});
    return this.ready;
  }

  async execute(action, payload) {
    if (action === 'cancel') return this.cancel(this.activeTaskId);
    if (action === 'model_status') return this.modelStatus();
    if (action === 'prefetch_model') return this.prefetchModel();
    if (this.activeTaskId) {
      const active = this.taskManager.get(this.activeTaskId);
      if (!TERMINAL_STATES.has(active.state)) throw new Error('An SFX task is already active.');
    }
    const inputPath = path.resolve(String(payload.inputPath || ''));
    const outputDir = path.resolve(String(payload.outputDir || ''));
    if (!fs.statSync(inputPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Video file does not exist: ${inputPath}`);
    if (!fs.statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Output folder does not exist: ${outputDir}`);
    const task = this.taskManager.create({
      module: this.manifest.id, action, input: { inputPath, outputDir },
      capabilities: this.manifest.capabilities, resourceClass: this.manifest.resourceClass
    });
    this.activeTaskId = task.id;
    this.taskManager.transition(task.id, 'RUNNING', { stage: 'validating' });
    await this.ensureWorker();
    this.worker.send({ type: 'task:start', jobId: task.id, inputPath, outputDir });
    return { taskId: task.id, jobId: task.id, task: structuredClone(task) };
  }

  handleLine(line, source) {
    const parsed = parseProtocolLine(line);
    const raw = parsed?.kind === 'event'
      ? parsed.payload
      : { type: 'task:log', level: source === 'stderr' ? 'ERROR' : 'INFO', message: parsed?.message || line };
    if (raw.type === 'backend:ready') {
      this.readyResolve?.(raw); this.readyResolve = null; this.readyReject = null; return;
    }
    this.emit('event', raw);
    const taskId = raw.jobId || this.activeTaskId;
    if (!taskId || !this.taskManager.tasks.has(taskId)) return;
    const task = this.taskManager.get(taskId);
    if (TERMINAL_STATES.has(task.state)) return;
    if (raw.type === 'task:state') this.taskManager.setStage(taskId, raw.state);
    else if (raw.type === 'task:progress') this.taskManager.setProgress(taskId, { percent: raw.value, indeterminate: false });
    else if (raw.type === 'task:log') this.taskManager.addLog(taskId, raw.level, raw.message);
    else if (raw.type === 'task:completed') {
      const outputPath = path.resolve(raw.outputPath);
      const stat = fs.statSync(outputPath, { throwIfNoEntry: false });
      this.taskManager.addOutput(taskId, {
        id: `artifact-${taskId}`, type: 'media.audio.sfx', uri: pathToFileURL(outputPath).href,
        mimeType: 'audio/wav', size: stat?.size,
        metadata: { sampleRate: 44100, channels: 1, sampleFormat: 'PCM_24' },
        producer: { taskId, module: this.manifest.id, action: task.action }, ownership: 'user-output'
      });
      this.taskManager.setProgress(taskId, { percent: 100, indeterminate: false });
      this.taskManager.transition(taskId, 'COMPLETED', { stage: 'completed' });
    } else if (raw.type === 'task:cancelled') this.taskManager.transition(taskId, 'CANCELLED', { stage: 'cancelled' });
    else if (raw.type === 'task:error') this.taskManager.transition(taskId, 'FAILED', { stage: 'error', error: { code: 'SFX_FAILED', message: raw.message, detail: raw.detail, retryable: true } });
  }

  async modelStatus() {
    const root = path.join(this.modelDirectory(), MODEL.dataset, MODEL.name);
    const checkpoint = path.join(root, 'checkpoints', 'model.pth');
    const config = path.join(root, 'merged_config.yaml');
    if (!fs.existsSync(checkpoint) || !fs.existsSync(config)) return { status: 'missing', installed: false, revision: MODEL.revision };
    const [checkpointHash, configHash] = await Promise.all([sha256(checkpoint), sha256(config)]);
    const valid = checkpointHash === MODEL.checkpointSha256 && configHash === MODEL.configSha256;
    return { status: valid ? 'ready' : 'corrupted', installed: true, valid, revision: MODEL.revision, directory: root };
  }

  async prefetchModel() {
    const project = path.join(this.pathService.projectRoot, 'SFX-Converter');
    const task = this.taskManager.create({ module: this.manifest.id, action: 'prefetch_model', input: {}, capabilities: { cancel: true, pause: false }, resourceClass: 'heavy' });
    this.activeTaskId = task.id;
    this.taskManager.transition(task.id, 'RUNNING', { stage: 'downloading_model' });
    const child = this.processManager.runOneShot(`${this.manifest.id}:${task.id}`, {
      executable: this.runtimeResolver.resolve(this.manifest.runtime),
      args: ['-u', '-m', 'scripts.download_model', 'prefetch'], cwd: project,
      env: { SFX_CONVERTER_MODEL_DIR: this.modelDirectory(), PYTHONUNBUFFERED: '1' }
    });
    this.prefetchProcess = child;
    child.on('line', ({ line, source }) => { this.taskManager.addLog(task.id, source === 'stderr' ? 'ERROR' : 'INFO', line); this.emit('event', { type: 'task:log', level: source === 'stderr' ? 'ERROR' : 'INFO', message: line }); });
    child.once('exit', ({ code, signal }) => {
      const current = this.taskManager.get(task.id);
      if (!TERMINAL_STATES.has(current.state)) {
        if (current.state === 'CANCELLING' || signal) this.taskManager.transition(task.id, 'CANCELLED', { stage: 'cancelled' });
        else this.taskManager.transition(task.id, code === 0 ? 'COMPLETED' : 'FAILED', code === 0 ? { stage: 'model_ready' } : { stage: 'model_error', error: { code: 'MODEL_DOWNLOAD_FAILED', message: 'Model download failed. Check the activity log and network connection.', retryable: true } });
      }
      if (this.prefetchProcess === child) this.prefetchProcess = null;
    });
    return { taskId: task.id, task: structuredClone(task) };
  }

  async cancel(taskId) {
    if (!taskId) return { cancelled: false };
    const task = this.taskManager.get(taskId);
    const isPrefetch = task.action === 'prefetch_model';
    if ((isPrefetch && !this.prefetchProcess) || (!isPrefetch && !this.worker?.child)) return { cancelled: false };
    if (task.state === 'RUNNING') this.taskManager.transition(taskId, 'CANCELLING', { stage: task.stage });
    if (isPrefetch) {
      await this.prefetchProcess.terminate({ timeoutMs: 5000 });
      return { cancelled: true };
    }
    this.worker.send({ type: 'task:cancel', jobId: taskId });
    return { cancelled: true };
  }

  failActive(code, message) {
    if (!this.activeTaskId || !this.taskManager.tasks.has(this.activeTaskId)) return;
    const task = this.taskManager.get(this.activeTaskId);
    if (!TERMINAL_STATES.has(task.state)) this.taskManager.transition(task.id, 'FAILED', { error: { code, message, retryable: true } });
  }

  async shutdown() {
    await this.prefetchProcess?.terminate({ timeoutMs: 5000 });
    await this.worker?.terminate({ gracefulMessage: { type: 'backend:shutdown' } });
  }
}

function createAdapter(context) { return new SfxAdapter(context); }
module.exports = { MODEL, SfxAdapter, createAdapter };
