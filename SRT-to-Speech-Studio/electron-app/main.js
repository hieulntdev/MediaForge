const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');

const logDirectory = path.join(app.getPath('userData'), 'logs');
const mainLogPath = path.join(logDirectory, 'main.log');
const chromiumLogPath = path.join(logDirectory, 'chromium.log');
fs.mkdirSync(logDirectory, { recursive: true });
fs.writeFileSync(chromiumLogPath, '', 'utf8');
app.commandLine.appendSwitch('enable-logging', 'file');
app.commandLine.appendSwitch('log-file', chromiumLogPath);

let mainWindow = null;
let workerProcess = null;
let retryProcess = null;
let packagingProcess = null;
let validationProcess = null;
let currentArchive = '';
let allowedPreviewFiles = new Set();
// WAVs written by the retry cache. They exist before a .zsp archive does, which
// is what keeps Play working for rows a stopped run already finished.
let currentStateAudioDir = '';
let allowedStateFiles = new Set();
// Every model/configuration gets its own retry directory. These directories are
// durable recovery state and must survive application restart.
const BACKEND_EVENT_PREFIX = 'SRT_STUDIO_EVENT ';
const DEFAULT_TTS_MODEL = 'vieneu';
const MELOTTS_MODEL = 'melotts';
const MELO_SPEAKERS = {
  EN: new Set(['EN-US', 'EN-BR', 'EN_INDIA', 'EN-AU', 'EN-Default']),
  ES: new Set(['ES']), FR: new Set(['FR']), ZH: new Set(['ZH']),
  JP: new Set(['JP']), KR: new Set(['KR'])
};

// The Threads selector decides concurrency and the value is forwarded as it is:
// studio/pipeline.py owns the policy (validate, fall back, log the reason).
function resolveProcessorCount(value) {
  const count = Number(value);
  if (Number.isInteger(count) && count >= 1) return String(count);
  writeDiagnostic('processor count is not a positive integer', { value: String(value) });
  return value === undefined || value === null ? '' : String(value);
}

function writeDiagnostic(message, details = null) {
  const suffix = details === null ? '' : ` ${JSON.stringify(details)}`;
  fs.appendFileSync(mainLogPath, `${new Date().toISOString()} ${message}${suffix}\n`, 'utf8');
}

process.on('uncaughtException', (error) => {
  writeDiagnostic('uncaughtException', { message: error.message, stack: error.stack });
  dialog.showErrorBox(
    'SRT-to-Speech Studio could not start',
    `${error.message}\n\nDiagnostic log: ${mainLogPath}`
  );
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeDiagnostic('unhandledRejection', { reason: String(reason) });
});

// Each TTS implementation runs in its own dependency environment. This keeps
// MeloTTS's old transformers stack from changing the existing VieNeu runtime.
function pythonExecutable(ttsModel = DEFAULT_TTS_MODEL) {
  if (ttsModel === MELOTTS_MODEL) {
    if (process.env.SRT_STUDIO_MELOTTS_PYTHON) {
      return process.env.SRT_STUDIO_MELOTTS_PYTHON;
    }
    if (!app.isPackaged) {
      return path.join(__dirname, '..', '.venv-melotts', 'bin', 'python3');
    }
  }
  if (process.env.SRT_STUDIO_PYTHON) return process.env.SRT_STUDIO_PYTHON;
  if (!app.isPackaged) {
    const venv = path.join(__dirname, '..', '.venv', 'bin', 'python3');
    if (fs.existsSync(venv)) return venv;
  }
  return 'python3';
}

function backendCommand(ttsModel = DEFAULT_TTS_MODEL) {
  const entry = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'backend_entry.py')
    : path.join(__dirname, '..', 'backend_entry.py');
  return { command: pythonExecutable(ttsModel), prefix: [entry] };
}

function spawnFailureHint(command, ttsModel = DEFAULT_TTS_MODEL) {
  if (ttsModel === MELOTTS_MODEL) {
    return ` (${command} could not be started — run ./studio.sh setup melotts, ` +
      'or set SRT_STUDIO_MELOTTS_PYTHON to a compatible interpreter)';
  }
  return ` (${command} could not be started — run ./studio.sh setup vieneu to create the ` +
    'virtual environment, or set SRT_STUDIO_PYTHON to a Python 3.12 interpreter)';
}

function backendProblem(ttsModel = DEFAULT_TTS_MODEL) {
  const backend = backendCommand(ttsModel);
  if (!fs.existsSync(backend.prefix[0])) {
    return `Backend entry point not found: ${backend.prefix[0]}`;
  }
  if (path.isAbsolute(backend.command) && !fs.existsSync(backend.command)) {
    return `Python interpreter not found: ${backend.command}`;
  }
  return null;
}

function previewDirectory() {
  return path.join(app.getPath('temp'), 'srt-to-speech-preview');
}

// A WAV the backend reported for this run, served from the retry cache. Only
// names the backend published are accepted, and the file must still exist.
function cachedPreviewPath(filename) {
  if (!currentStateAudioDir || !allowedStateFiles.has(filename)) return null;
  const candidate = path.join(currentStateAudioDir, filename);
  return fs.existsSync(candidate) ? candidate : null;
}

function sendBackendEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:event', event);
  }
}

async function clearPreviews() {
  await fsp.rm(previewDirectory(), { recursive: true, force: true });
}

function normalizeTtsConfig(job) {
  const ttsModel = String(job.ttsModel || DEFAULT_TTS_MODEL).trim().toLowerCase();
  if (![DEFAULT_TTS_MODEL, MELOTTS_MODEL].includes(ttsModel)) {
    throw new Error('TTS Model must be VieNeu-TTS v3 Turbo or MeloTTS.');
  }
  if (ttsModel === DEFAULT_TTS_MODEL) {
    return { ttsModel, meloLanguage: 'EN', meloSpeaker: 'EN-US' };
  }
  const meloLanguage = String(job.meloLanguage || 'EN').trim().toUpperCase();
  const meloSpeaker = String(job.meloSpeaker || '').trim();
  const speakers = MELO_SPEAKERS[meloLanguage];
  if (!speakers) throw new Error('Unsupported MeloTTS language.');
  if (!speakers.has(meloSpeaker)) {
    throw new Error(`Unsupported MeloTTS speaker for ${meloLanguage}.`);
  }
  return { ttsModel, meloLanguage, meloSpeaker };
}

function stateDirectoryFor(job, destination = null) {
  const subtitleName = path.basename(job.subtitlePath, path.extname(job.subtitlePath));
  const archive = destination || path.join(job.outputPath, `${subtitleName}.zsp`);
  if (job.ttsModel === MELOTTS_MODEL) {
    return `${archive}.melotts.${job.meloLanguage}.${job.meloSpeaker}.retry`;
  }
  // Preserve the historical VieNeu path for full backwards compatibility.
  return `${archive}.retry`;
}

function ttsArguments(job) {
  const args = ['--tts-model', job.ttsModel];
  if (job.ttsModel === MELOTTS_MODEL) {
    args.push('--melo-language', job.meloLanguage, '--melo-speaker', job.meloSpeaker);
  }
  return args;
}

async function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job data.');
  const ttsConfig = normalizeTtsConfig(job);
  const subtitlePath = path.resolve(String(job.subtitlePath || ''));
  const voicePath = path.resolve(String(job.voicePath || ''));
  const outputPath = path.resolve(String(job.outputPath || ''));
  if (path.extname(subtitlePath).toLowerCase() !== '.srt') {
    throw new Error('Subtitle Input must be a .srt file.');
  }
  if (ttsConfig.ttsModel === DEFAULT_TTS_MODEL && path.extname(voicePath).toLowerCase() !== '.mp3') {
    throw new Error('Voice Profile must be an .mp3 file.');
  }
  const [subtitle, output] = await Promise.all([fsp.stat(subtitlePath), fsp.stat(outputPath)]);
  const voice = ttsConfig.ttsModel === DEFAULT_TTS_MODEL ? await fsp.stat(voicePath) : null;
  if (!subtitle.isFile() || (voice && !voice.isFile()) || !output.isDirectory()) {
    throw new Error('One or more input paths no longer exist.');
  }
  return { subtitlePath, voicePath, outputPath, ...ttsConfig };
}

function consumeWorkerLine(line) {
  const value = line.trim();
  if (!value) return;
  if (value.startsWith(BACKEND_EVENT_PREFIX)) {
    try {
      const event = JSON.parse(value.slice(BACKEND_EVENT_PREFIX.length));
      if (event.type === 'complete' && Array.isArray(event.entries)) {
        currentArchive = String(event.destination || '');
        allowedPreviewFiles = new Set(
          event.entries.map((entry) => entry.audio_filename).filter(Boolean).map(String)
        );
      } else if (event.type === 'segment_result' && event.status === 'success' && event.audio_filename) {
        allowedStateFiles.add(String(event.audio_filename));
      }
      sendBackendEvent(event);
      return;
    } catch (error) {
      sendBackendEvent({ type: 'log', message: `Invalid backend event: ${error.message}` });
      return;
    }
  }
  sendBackendEvent({ type: 'log', message: value.replace(/^\r+/, '') });
}

function startWorker(job, retry) {
  const subtitleName = path.basename(job.subtitlePath, path.extname(job.subtitlePath));
  const destination = path.join(job.outputPath, `${subtitleName}.zsp`);
  const stateDirectory = stateDirectoryFor(job, destination);
  const args = [
    '--subtitle', job.subtitlePath, '--voice', job.voicePath,
    '--output', destination, '--state-dir', stateDirectory, '--json-events',
    '--workers', String(job.workers), ...ttsArguments(job)
  ];
  if (job.validateContent) args.push('--validate-content');
  const backend = backendCommand(job.ttsModel);
  currentStateAudioDir = path.join(stateDirectory, 'audio_cache');
  workerProcess = spawn(backend.command, [...backend.prefix, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  readline.createInterface({ input: workerProcess.stdout }).on('line', consumeWorkerLine);
  readline.createInterface({ input: workerProcess.stderr }).on('line', consumeWorkerLine);
  // 'close' waits for stdout to drain, so the last event line is always handled
  // before the run is declared finished; a child that never spawned emits no
  // 'close' at all, so the error path reports completion too. Either way the
  // GUI is released exactly once.
  let finished = false;
  const reportFinished = (code, signal) => {
    if (finished) return;
    finished = true;
    workerProcess = null;
    sendBackendEvent({ type: 'process_exit', code, signal, retry });
  };
  workerProcess.once('error', (error) => {
    const hint = error.code === 'ENOENT'
      ? spawnFailureHint(backend.command, job.ttsModel) : '';
    sendBackendEvent({ type: 'process_error', message: `${error.message}${hint}` });
    reportFinished(null, null);
  });
  workerProcess.once('close', reportFinished);
  return { destination, stateDirectory };
}

// One subtitle is regenerated on its own, through the same backend entry point
// batch processing uses. Only one such job may run at a time, so two clicks can
// never write the same WAV.
function startSegmentRetry(job, position) {
  const stateDirectory = stateDirectoryFor(job);
  const args = [
    '--regenerate', '--position', String(position),
    '--subtitle', job.subtitlePath, '--voice', job.voicePath,
    '--state-dir', stateDirectory, '--json-events', ...ttsArguments(job)
  ];
  if (job.validateContent) args.push('--validate-content');
  const backend = backendCommand(job.ttsModel);
  currentStateAudioDir = path.join(stateDirectory, 'audio_cache');
  retryProcess = spawn(backend.command, [...backend.prefix, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  readline.createInterface({ input: retryProcess.stdout }).on('line', consumeWorkerLine);
  readline.createInterface({ input: retryProcess.stderr }).on('line', consumeWorkerLine);
  // As in startWorker: the row is released on 'close' (after stdout drained) or
  // on a spawn failure, never twice.
  let finished = false;
  const reportFinished = (code, signal) => {
    if (finished) return;
    finished = true;
    retryProcess = null;
    sendBackendEvent({ type: 'retry_exit', code, signal });
  };
  retryProcess.once('error', (error) => {
    const hint = error.code === 'ENOENT'
      ? spawnFailureHint(backend.command, job.ttsModel) : '';
    sendBackendEvent({ type: 'retry_error', message: `${error.message}${hint}` });
    reportFinished(null, null);
  });
  retryProcess.once('close', reportFinished);
  return { stateDirectory };
}

// Packaging reads state_dir's journal and audio_cache read-only, through the
// same backend entry point; it never touches TTS, so it needs no --voice.
function startPackaging(job) {
  const subtitleName = path.basename(job.subtitlePath, path.extname(job.subtitlePath));
  const destination = path.join(job.outputPath, `${subtitleName}.zsp`);
  const stateDirectory = stateDirectoryFor(job, destination);
  const args = [
    '--package-only', '--state-dir', stateDirectory, '--output', destination, '--json-events'
  ];
  const backend = backendCommand();
  packagingProcess = spawn(backend.command, [...backend.prefix, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  readline.createInterface({ input: packagingProcess.stdout }).on('line', consumeWorkerLine);
  readline.createInterface({ input: packagingProcess.stderr }).on('line', consumeWorkerLine);
  let finished = false;
  const reportFinished = (code, signal) => {
    if (finished) return;
    finished = true;
    packagingProcess = null;
    sendBackendEvent({ type: 'package_exit', code, signal });
  };
  packagingProcess.once('error', (error) => {
    const hint = error.code === 'ENOENT' ? spawnFailureHint(backend.command) : '';
    sendBackendEvent({ type: 'package_error', message: `${error.message}${hint}` });
    reportFinished(null, null);
  });
  packagingProcess.once('close', reportFinished);
  return { destination, stateDirectory };
}

// A single ASR pass over the current build's audio, no TTS involved -- so,
// unlike startWorker/startSegmentRetry, no --voice and no state audio dir
// tracking for previews (nothing new is generated).
function startValidation(job) {
  const stateDirectory = stateDirectoryFor(job);
  const args = [
    '--validate-only', '--subtitle', job.subtitlePath, '--state-dir', stateDirectory, '--json-events'
  ];
  const backend = backendCommand();
  validationProcess = spawn(backend.command, [...backend.prefix, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  readline.createInterface({ input: validationProcess.stdout }).on('line', consumeWorkerLine);
  readline.createInterface({ input: validationProcess.stderr }).on('line', consumeWorkerLine);
  let finished = false;
  const reportFinished = (code, signal) => {
    if (finished) return;
    finished = true;
    validationProcess = null;
    sendBackendEvent({ type: 'validate_exit', code, signal });
  };
  validationProcess.once('error', (error) => {
    const hint = error.code === 'ENOENT' ? spawnFailureHint(backend.command) : '';
    sendBackendEvent({ type: 'validate_error', message: `${error.message}${hint}` });
    reportFinished(null, null);
  });
  validationProcess.once('close', reportFinished);
  return { stateDirectory };
}

async function terminateWorker() {
  const child = workerProcess || retryProcess;
  if (!child || child.exitCode !== null) return false;
  child.kill('SIGTERM');
  // A synthesis step in flight does not stop instantly, so escalate only if the
  // worker is still alive after a short grace period.
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return true;
}

function createWindow() {
  writeDiagnostic('createWindow', {
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    executable: process.execPath,
    backend: backendCommand()
  });
  mainWindow = new BrowserWindow({
    title: 'SRT-to-Speech Studio', width: 1180, height: 780,
    minWidth: 900, minHeight: 650, show: false,
    backgroundColor: '#f5f5f7', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    writeDiagnostic('ready-to-show');
    mainWindow.show();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    writeDiagnostic('did-fail-load', { code, description });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeDiagnostic('render-process-gone', details);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.on('close', async (event) => {
    if (!workerProcess && !retryProcess) return;
    event.preventDefault();
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning', buttons: ['Keep processing', 'Exit and stop'],
      defaultId: 0, cancelId: 0, title: 'Creating audio',
      message: 'Audio is still being generated. Are you sure you want to exit?'
    });
    if (answer.response === 1) {
      await terminateWorker();
      mainWindow.destroy();
    }
  });
}

ipcMain.handle('dialog:open-srt', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select SRT subtitle file', properties: ['openFile'],
    filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, content: await fsp.readFile(filePath, 'utf8') };
});

ipcMain.handle('dialog:open-voice', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select MP3 voice sample', properties: ['openFile'],
    filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:select-output', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select output project folder', properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('synthesis:start', async (_event, rawJob) => {
  if (workerProcess || retryProcess || packagingProcess || validationProcess) {
    throw new Error('A synthesis process is already running.');
  }
  const job = await validateJob(rawJob);
  const problem = backendProblem(job.ttsModel);
  if (problem) throw new Error(problem);
  const retry = Boolean(rawJob.retry);
  // The renderer's selection is honoured as-is; studio/pipeline.py owns the fallback.
  job.workers = resolveProcessorCount(rawJob.workers);
  job.validateContent = Boolean(rawJob.validateContent);
  const stateDirectory = stateDirectoryFor(job);
  // A normal launch resumes valid journal/audio entries left by an interrupted
  // session. Retry state is cleared only by an explicit user action or a future
  // validated retention policy.
  await clearPreviews();
  currentArchive = '';
  allowedPreviewFiles = new Set();
  allowedStateFiles = new Set();
  return startWorker(job, retry);
});

ipcMain.handle('synthesis:retry-segment', async (_event, rawJob) => {
  if (workerProcess || retryProcess || packagingProcess || validationProcess) {
    throw new Error('Wait for the running task to finish before retrying a line.');
  }
  const job = await validateJob(rawJob);
  const problem = backendProblem(job.ttsModel);
  if (problem) throw new Error(problem);
  job.validateContent = Boolean(rawJob.validateContent);
  const position = Number(rawJob.position);
  if (!Number.isInteger(position) || position < 0) {
    throw new Error('Invalid subtitle position.');
  }
  return startSegmentRetry(job, position);
});

ipcMain.handle('project:save', async (_event, rawJob) => {
  if (workerProcess || retryProcess || packagingProcess || validationProcess) {
    throw new Error('Wait for the running task to finish before saving the project.');
  }
  const problem = backendProblem();
  if (problem) throw new Error(problem);
  const job = await validateJob(rawJob);
  return startPackaging(job);
});

ipcMain.handle('synthesis:validate-content', async (_event, rawJob) => {
  if (workerProcess || retryProcess || packagingProcess || validationProcess) {
    throw new Error('Wait for the running task to finish before validating.');
  }
  const problem = backendProblem();
  if (problem) throw new Error(problem);
  const job = await validateJob(rawJob);
  return startValidation(job);
});

ipcMain.handle('synthesis:cancel', () => terminateWorker());

ipcMain.handle('audio:preview', async (_event, filename) => {
  const safeName = String(filename || '');
  if (path.basename(safeName) !== safeName) throw new Error('Invalid audio preview.');
  // The retry cache comes first: it holds WAVs from a run that stopped early,
  // and no archive contains those yet.
  const cached = cachedPreviewPath(safeName);
  if (cached) return pathToFileURL(cached).href;
  if (!currentArchive || !allowedPreviewFiles.has(safeName)) {
    throw new Error('Invalid audio preview.');
  }
  const outputDir = previewDirectory();
  const destination = path.join(outputDir, safeName);
  await fsp.mkdir(outputDir, { recursive: true });
  if (!fs.existsSync(destination)) {
    const backend = backendCommand();
    await new Promise((resolve, reject) => {
      execFile(backend.command, [
        ...backend.prefix, '--extract-preview', '--archive', currentArchive,
        '--filename', safeName, '--preview-dir', outputDir
      ], (error) => error ? reject(error) : resolve());
    });
  }
  return pathToFileURL(destination).href;
});

app.whenReady().then(() => {
  writeDiagnostic('app-ready');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('child-process-gone', (_event, details) => {
  writeDiagnostic('child-process-gone', details);
});

app.on('before-quit', () => {
  if (workerProcess) workerProcess.kill();
  if (retryProcess) retryProcess.kill();
  if (packagingProcess) packagingProcess.kill();
  if (validationProcess) validationProcess.kill();
  clearPreviews().catch(() => {});
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
