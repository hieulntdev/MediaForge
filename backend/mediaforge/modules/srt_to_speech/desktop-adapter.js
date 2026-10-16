'use strict';

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseProtocolLine, TERMINAL_STATES } = require('../../../../apps/desktop/shared/protocol');

const DEFAULT_TTS_MODEL = 'vieneu';
const MELOTTS_MODEL = 'melotts';
const MELO_SPEAKERS = Object.freeze({
  EN: new Set(['EN-US', 'EN-BR', 'EN_INDIA', 'EN-AU', 'EN-Default']),
  ES: new Set(['ES']), FR: new Set(['FR']), ZH: new Set(['ZH']),
  JP: new Set(['JP']), KR: new Set(['KR'])
});
const RETRY_STATE_CLEANUP_POLICY = 'session-scoped';

function normalizeTtsConfig(job) {
  const ttsModel = String(job.ttsModel || DEFAULT_TTS_MODEL).trim().toLowerCase();
  if (![DEFAULT_TTS_MODEL, MELOTTS_MODEL].includes(ttsModel)) throw new Error('TTS Model must be VieNeu-TTS v3 Turbo or MeloTTS.');
  if (ttsModel === DEFAULT_TTS_MODEL) return { ttsModel, meloLanguage: 'EN', meloSpeaker: 'EN-US' };
  const meloLanguage = String(job.meloLanguage || 'EN').trim().toUpperCase();
  const meloSpeaker = String(job.meloSpeaker || '').trim();
  if (!MELO_SPEAKERS[meloLanguage]?.has(meloSpeaker)) throw new Error(`Unsupported MeloTTS speaker for ${meloLanguage}.`);
  return { ttsModel, meloLanguage, meloSpeaker };
}

class SrtAdapter extends EventEmitter {
  constructor(context) {
    super();
    Object.assign(this, context);
    this.active = null;
    this.currentArchive = '';
    this.currentStateAudioDir = '';
    this.allowedPreviewFiles = new Set();
    this.allowedStateFiles = new Set();
  }

  workerRoot() { return path.join(this.manifest.moduleDirectory, 'worker'); }
  backendEntry() { return path.join(this.workerRoot(), 'backend_entry.py'); }
  runtimeId(ttsModel) { return ttsModel === MELOTTS_MODEL ? 'tts-melotts' : 'tts-vieneu'; }

  resourceClassFor(action) {
    return ['synthesize', 'retry_cue', 'validate_content'].includes(action) ? 'heavy' : 'light';
  }

  isBusy() {
    if (!this.active) return false;
    try { return !TERMINAL_STATES.has(this.taskManager.get(this.active.taskId).state); } catch { return false; }
  }

  stateDirectoryFor(job, destination = null) {
    const subtitleName = path.basename(job.subtitlePath, path.extname(job.subtitlePath));
    const archive = destination || path.join(job.outputPath, `${subtitleName}.zsp`);
    const identity = JSON.stringify([
      path.resolve(job.subtitlePath), path.resolve(archive), job.ttsModel,
      job.meloLanguage || '', job.meloSpeaker || ''
    ]);
    const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    return path.join(this.pathService.cache, 'srt-to-speech', `${key}.retry`);
  }

  ttsArguments(job) {
    const args = ['--tts-model', job.ttsModel];
    if (job.ttsModel === MELOTTS_MODEL) args.push('--melo-language', job.meloLanguage, '--melo-speaker', job.meloSpeaker);
    return args;
  }

  async validateJob(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid job data.');
    const config = normalizeTtsConfig(raw);
    const subtitlePath = path.resolve(String(raw.subtitlePath || ''));
    const voicePath = path.resolve(String(raw.voicePath || ''));
    const outputPath = path.resolve(String(raw.outputPath || ''));
    if (path.extname(subtitlePath).toLowerCase() !== '.srt') throw new Error('Subtitle Input must be a .srt file.');
    if (config.ttsModel === DEFAULT_TTS_MODEL && path.extname(voicePath).toLowerCase() !== '.mp3') throw new Error('Voice Profile must be an .mp3 file.');
    const subtitle = await fsp.stat(subtitlePath).catch(() => null);
    const output = await fsp.stat(outputPath).catch(() => null);
    const voice = config.ttsModel === DEFAULT_TTS_MODEL ? await fsp.stat(voicePath).catch(() => null) : null;
    if (!subtitle?.isFile() || !output?.isDirectory() || (config.ttsModel === DEFAULT_TTS_MODEL && !voice?.isFile())) {
      throw new Error('One or more input paths no longer exist.');
    }
    return { ...raw, subtitlePath, voicePath, outputPath, ...config };
  }

  async execute(action, payload) {
    if (action === 'cancel') return this.cancel(this.active?.taskId);
    if (action === 'preview_audio') return this.previewAudio(payload.filename);
    if (action === 'clear_retry_state') return this.clearRetryState(payload);
    if (this.active) {
      const task = this.taskManager.get(this.active.taskId);
      if (!TERMINAL_STATES.has(task.state)) throw new Error('Wait for the running SRT task to finish.');
    }
    const job = await this.validateJob(payload);
    const destination = path.join(job.outputPath, `${path.basename(job.subtitlePath, path.extname(job.subtitlePath))}.zsp`);
    const stateDirectory = this.stateDirectoryFor(job, destination);
    let args;
    let stage;
    if (action === 'synthesize') {
      args = ['--subtitle', job.subtitlePath, '--voice', job.voicePath, '--output', destination,
        '--state-dir', stateDirectory, '--json-events', '--workers', String(job.workers || ''), ...this.ttsArguments(job)];
      if (job.validateContent) args.push('--validate-content');
      stage = 'synthesizing';
      // Retry state is reusable only inside this application session. The
      // shared startup cleanup removes this app-owned cache after any exit.
      this.allowedStateFiles.clear(); this.allowedPreviewFiles.clear(); this.currentArchive = '';
    } else if (action === 'retry_cue') {
      const position = Number(payload.position);
      if (!Number.isInteger(position) || position < 0) throw new Error('Invalid subtitle position.');
      args = ['--regenerate', '--position', String(position), '--subtitle', job.subtitlePath,
        '--voice', job.voicePath, '--state-dir', stateDirectory, '--json-events', ...this.ttsArguments(job)];
      if (job.validateContent) args.push('--validate-content');
      stage = 'retrying_cue';
    } else if (action === 'package_project') {
      args = ['--package-only', '--state-dir', stateDirectory, '--output', destination, '--json-events'];
      stage = 'packaging';
    } else if (action === 'validate_content') {
      args = ['--validate-only', '--subtitle', job.subtitlePath, '--state-dir', stateDirectory, '--json-events'];
      stage = 'validating_content';
    } else {
      throw new Error(`Unsupported SRT action: ${action}`);
    }
    this.currentStateAudioDir = path.join(stateDirectory, 'audio_cache');
    const task = this.taskManager.create({
      module: this.manifest.id, action, input: { ...job, stateDirectory, destination },
      capabilities: this.manifest.capabilities, resourceClass: this.manifest.resourceClass
    });
    this.taskManager.transition(task.id, 'RUNNING', { stage });
    const runtime = action === 'package_project' || action === 'validate_content'
      ? 'tts-vieneu' : this.runtimeId(job.ttsModel);
    const process = this.processManager.runOneShot(`${this.manifest.id}:${task.id}`, {
      executable: this.runtimeResolver.resolve(runtime),
      args: ['-u', this.backendEntry(), ...args], cwd: this.workerRoot(),
      env: {
        PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        MEDIAFORGE_FFMPEG: this.ffmpegLocator.resolve(),
        MEDIAFORGE_FFPROBE: this.ffprobeLocator.resolve()
      }
    });
    this.active = { taskId: task.id, process, action, stateDirectory, destination, terminalEvent: false };
    process.on('line', ({ line, source }) => this.handleLine(line, source));
    process.on('error', (error) => {
      this.emit('event', { type: action === 'retry_cue' ? 'retry_error' : 'process_error', message: error.message });
      this.fail(task.id, 'PROCESS_START_FAILED', error.message);
    });
    process.once('exit', ({ code, signal }) => this.handleExit(task.id, action, code, signal));
    return { taskId: task.id, destination, stateDirectory, task: structuredClone(task) };
  }

  handleLine(line, source) {
    const parsed = parseProtocolLine(line, 'SRT_STUDIO_EVENT ');
    const raw = parsed?.kind === 'event'
      ? parsed.payload
      : { type: 'log', message: parsed?.message || line, level: source === 'stderr' ? 'ERROR' : 'INFO' };
    this.emit('event', raw);
    if (!this.active) return;
    const { taskId, action } = this.active;
    const task = this.taskManager.get(taskId);
    if (TERMINAL_STATES.has(task.state)) return;
    if (raw.type === 'log') this.taskManager.addLog(taskId, raw.level || 'INFO', raw.message);
    else if (raw.type === 'started') this.taskManager.setProgress(taskId, { current: 0, total: raw.total, percent: 0 });
    else if (raw.type === 'progress') this.taskManager.setProgress(taskId, { current: raw.completed, total: raw.total });
    else if (raw.type === 'status') this.taskManager.setStage(taskId, /validat/i.test(raw.message) ? 'validating_content' : task.stage);
    else if (raw.type === 'segment_result' && raw.status === 'success' && raw.audio_filename) {
      this.allowedStateFiles.add(String(raw.audio_filename));
    } else if (raw.type === 'complete' && Array.isArray(raw.entries)) {
      this.currentArchive = String(raw.destination || this.active.destination);
      this.allowedPreviewFiles = new Set(raw.entries.map((entry) => entry.audio_filename).filter(Boolean).map(String));
      for (const [position, entry] of raw.entries.entries()) {
        const audioPath = path.join(this.currentStateAudioDir, String(entry.audio_filename));
        if (!fs.existsSync(audioPath)) continue;
        this.taskManager.addOutput(taskId, {
          id: `artifact-${taskId}-${position}`, type: 'media.audio.speech', uri: pathToFileURL(audioPath).href,
          mimeType: 'audio/wav', size: fs.statSync(audioPath).size,
          metadata: { subtitleIndex: entry.index, start: entry.start, end: entry.end, text: entry.content },
          producer: { taskId, module: this.manifest.id, action }, ownership: 'task-state'
        });
      }
      this.active.terminalEvent = true;
    } else if (raw.type === 'packaged') {
      const outputPath = path.resolve(raw.destination || this.active.destination);
      this.currentArchive = outputPath;
      this.taskManager.addOutput(taskId, {
        id: `artifact-${taskId}`, type: 'project.zsp', uri: pathToFileURL(outputPath).href,
        mimeType: 'application/zip', size: fs.statSync(outputPath, { throwIfNoEntry: false })?.size,
        metadata: {}, producer: { taskId, module: this.manifest.id, action }, ownership: 'user-output'
      });
      this.active.terminalEvent = true;
    } else if (['failed', 'error'].includes(raw.type)) {
      this.active.terminalEvent = true;
      this.fail(taskId, 'SRT_TASK_FAILED', raw.message || `${raw.failures?.length || 1} subtitle line(s) failed.`);
    } else if (raw.type === 'validation_started') this.taskManager.setProgress(taskId, { current: 0, total: raw.total });
    else if (raw.type === 'validation_complete') { this.taskManager.setProgress(taskId, { current: raw.total, total: raw.total, percent: 100 }); this.active.terminalEvent = true; }
  }

  handleExit(taskId, action, code, signal) {
    const eventType = action === 'retry_cue' ? 'retry_exit'
      : action === 'package_project' ? 'package_exit'
        : action === 'validate_content' ? 'validate_exit' : 'process_exit';
    this.emit('event', { type: eventType, code, signal, retry: action === 'retry_cue' });
    const task = this.taskManager.get(taskId);
    if (!TERMINAL_STATES.has(task.state)) {
      if (task.state === 'CANCELLING' || signal) this.taskManager.transition(taskId, 'CANCELLED', { stage: 'cancelled' });
      else if (code === 0) {
        this.taskManager.setProgress(taskId, { percent: 100, indeterminate: false });
        this.taskManager.transition(taskId, 'COMPLETED', { stage: 'completed' });
      } else this.fail(taskId, 'SRT_PROCESS_EXIT', `SRT worker exited with code ${code}.`);
    }
    if (this.active?.taskId === taskId) this.active = null;
  }

  fail(taskId, code, message) {
    const task = this.taskManager.get(taskId);
    if (!TERMINAL_STATES.has(task.state)) this.taskManager.transition(taskId, 'FAILED', { stage: 'error', error: { code, message, retryable: true } });
  }

  async cancel(taskId) {
    if (!taskId || this.active?.taskId !== taskId) return { cancelled: false };
    const task = this.taskManager.get(taskId);
    if (task.state === 'RUNNING') this.taskManager.transition(taskId, 'CANCELLING', { stage: task.stage });
    await this.active.process.terminate({ timeoutMs: 5000 });
    return { cancelled: true };
  }

  async previewAudio(filename) {
    const safeName = String(filename || '');
    if (path.basename(safeName) !== safeName || !safeName.toLowerCase().endsWith('.wav')) throw new Error('Invalid audio preview.');
    const cached = path.join(this.currentStateAudioDir, safeName);
    if (this.allowedStateFiles.has(safeName) && fs.existsSync(cached)) return pathToFileURL(cached).href;
    if (!this.currentArchive || !this.allowedPreviewFiles.has(safeName)) throw new Error('Invalid audio preview.');
    const outputDir = path.join(this.pathService.temp, 'srt-to-speech-preview');
    const destination = path.join(outputDir, safeName);
    await fsp.mkdir(outputDir, { recursive: true });
    if (!fs.existsSync(destination)) {
      await new Promise((resolve, reject) => {
        execFile(this.runtimeResolver.resolve('tts-vieneu'), [this.backendEntry(), '--extract-preview', '--archive', this.currentArchive,
          '--filename', safeName, '--preview-dir', outputDir], { cwd: this.projectRoot() }, (error) => error ? reject(error) : resolve());
      });
    }
    return pathToFileURL(destination).href;
  }

  async clearRetryState(payload) {
    const job = await this.validateJob(payload);
    const stateDirectory = this.stateDirectoryFor(job);
    await fsp.rm(stateDirectory, { recursive: true, force: true });
    return { cleared: true, stateDirectory };
  }

  async resetToDefaults() {
    const active = this.active ? this.taskManager.get(this.active.taskId) : null;
    if (active && !TERMINAL_STATES.has(active.state)) throw new Error('Cannot reset SRT-to-Speech while processing is active.');
    this.active = null;
    this.currentArchive = '';
    this.currentStateAudioDir = '';
    this.allowedPreviewFiles.clear();
    this.allowedStateFiles.clear();
    await fsp.rm(path.join(this.pathService.cache, 'srt-to-speech'), { recursive: true, force: true });
    await fsp.rm(path.join(this.pathService.temp, 'srt-to-speech-preview'), { recursive: true, force: true });
    return { reset: true };
  }

  async shutdown() {
    if (this.active) await this.active.process.terminate({ timeoutMs: 5000 });
    await fsp.rm(path.join(this.pathService.temp, 'srt-to-speech-preview'), { recursive: true, force: true });
    // Retry journals remain available until this process exits; startup cleanup
    // removes the app-owned cache before the next session is created.
  }
}

function createAdapter(context) { return new SrtAdapter(context); }
async function cleanupSession({ pathService }) {
  await fsp.rm(path.join(pathService.cache, 'srt-to-speech'), { recursive: true, force: true });
  await fsp.rm(path.join(pathService.temp, 'srt-to-speech-preview'), { recursive: true, force: true });
}
module.exports = { cleanupSession, DEFAULT_TTS_MODEL, MELOTTS_MODEL, RETRY_STATE_CLEANUP_POLICY, SrtAdapter, createAdapter, normalizeTtsConfig };
