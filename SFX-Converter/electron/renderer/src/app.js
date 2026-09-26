'use strict';

const state = {
  inputPath: '',
  outputPath: '',
  outputOverridden: false,
  isRunning: false,
  isCancelling: false,
  progress: 0,
  status: 'idle',
  statusDetail: '',
  theme: window.sfxApi.initialTheme === 'dark' ? 'dark' : 'light',
  logs: []
};

const elements = {
  videoPath: document.querySelector('#video-path'),
  outputPath: document.querySelector('#output-path'),
  browseVideo: document.querySelector('#browse-video'),
  browseOutput: document.querySelector('#browse-output'),
  runButton: document.querySelector('#run-button'),
  cancelButton: document.querySelector('#cancel-button'),
  themeToggle: document.querySelector('#theme-toggle'),
  themeSun: document.querySelector('#theme-sun'),
  themeMoon: document.querySelector('#theme-moon'),
  statusLabel: document.querySelector('#status-label'),
  progressValue: document.querySelector('#progress-value'),
  progressTrack: document.querySelector('#progress-track'),
  progressBar: document.querySelector('#progress-bar'),
  clearLog: document.querySelector('#clear-log'),
  logView: document.querySelector('#log-view'),
  errorDialog: document.querySelector('#error-dialog'),
  errorMessage: document.querySelector('#error-message')
};

const STATE_LABELS = Object.freeze({
  idle: 'Ready',
  validating: 'Validating video...',
  extracting_audio: 'Extracting audio...',
  loading_model: 'Preparing SFC-Locoformer...',
  separating: 'Separating SFX...',
  exporting: 'Writing output file...',
  completed: 'Completed',
  error: 'An error occurred',
  cancelled: 'Cancelled',
  cancelling: 'Cancelling and cleaning up temporary files...'
});

const INDETERMINATE_STATES = new Set(['validating', 'extracting_audio', 'loading_model', 'exporting']);
const STATUS_CLASS = Object.freeze({ completed: 'status-success', cancelled: 'status-warning', error: 'status-danger' });
const MAX_LOG_ROWS = 500;
let themeRevision = 0;

function render() {
  elements.videoPath.textContent = state.inputPath || 'No video selected';
  elements.videoPath.title = state.inputPath;
  elements.videoPath.classList.toggle('placeholder', !state.inputPath);
  elements.outputPath.textContent = state.outputPath || 'No folder selected';
  elements.outputPath.title = state.outputPath;
  elements.outputPath.classList.toggle('placeholder', !state.outputPath);
  elements.browseVideo.disabled = state.isRunning;
  elements.browseOutput.disabled = state.isRunning;
  elements.browseVideo.setAttribute('aria-label', `Select video. ${state.inputPath || 'No video selected'}`);
  elements.browseOutput.setAttribute('aria-label', `Select output folder. ${state.outputPath || 'No folder selected'}`);
  elements.runButton.disabled = state.isRunning || !state.inputPath || !state.outputPath;
  elements.cancelButton.hidden = !state.isRunning;
  elements.cancelButton.disabled = state.isCancelling;
  elements.statusLabel.textContent = state.statusDetail || STATE_LABELS[state.status] || state.status;
  elements.statusLabel.className = STATUS_CLASS[state.status] || '';
  elements.progressValue.textContent = `${state.progress.toFixed(1)}%`;
  const isIndeterminate = state.isRunning && INDETERMINATE_STATES.has(state.status);
  elements.progressTrack.classList.toggle('indeterminate', isIndeterminate);
  elements.progressBar.style.width = isIndeterminate ? '34%' : `${state.progress}%`;
  elements.progressTrack.setAttribute('aria-valuenow', String(state.progress));
  elements.progressTrack.setAttribute('aria-valuetext', `${state.progress.toFixed(1)}%, ${elements.statusLabel.textContent}`);
  document.documentElement.dataset.theme = state.theme;
  const themeAction = state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  elements.themeToggle.setAttribute('aria-label', themeAction);
  elements.themeToggle.title = themeAction;
  elements.themeToggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
}

function appendLog(message, level = 'INFO') {
  const normalized = String(message);
  const normalizedLevel = String(level).toUpperCase();
  state.logs.push({ message: normalized, level: normalizedLevel });
  elements.logView.querySelector('.log-empty')?.remove();
  if (state.logs.length > MAX_LOG_ROWS) {
    state.logs.splice(0, state.logs.length - MAX_LOG_ROWS);
    while (elements.logView.querySelectorAll('.log-line').length >= MAX_LOG_ROWS) {
      elements.logView.querySelector('.log-line')?.remove();
    }
  }

  const line = document.createElement('div');
  line.className = `log-line log-${normalizedLevel.toLowerCase()}`;
  const structured = normalized.match(/^(\[[^\]]+\])\s+(\[[^\]]+\])\s*([\s\S]*)$/);
  if (structured) {
    const time = document.createElement('span');
    const severity = document.createElement('span');
    const content = document.createElement('span');
    time.className = 'log-time';
    severity.className = 'log-level';
    content.className = 'log-message';
    time.textContent = `${structured[1]} `;
    severity.textContent = `${structured[2]} `;
    content.textContent = structured[3];
    line.append(time, severity, content);
  } else {
    const content = document.createElement('span');
    content.className = 'log-message';
    content.textContent = normalized;
    line.append(content);
  }
  elements.logView.append(line);
  elements.logView.scrollTop = elements.logView.scrollHeight;
}

function localLog(message) {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  appendLog(`[${time}] [INFO] ${message}`);
}

function showError(message) {
  elements.errorMessage.textContent = message;
  if (!elements.errorDialog.open) elements.errorDialog.showModal();
}

function finishTask(status) {
  state.isRunning = false;
  state.isCancelling = false;
  state.status = status;
  state.statusDetail = '';
  render();
}

elements.browseVideo.addEventListener('click', async () => {
  try {
    const selected = await window.sfxApi.selectVideo();
    if (!selected) return;
    state.inputPath = selected.path;
    if (!state.outputOverridden) state.outputPath = selected.defaultOutputDir;
    localLog(`Selected video: ${state.inputPath}`);
    localLog(`Output directory: ${state.outputPath}`);
    render();
  } catch (error) {
    showError(error.message);
  }
});

elements.browseOutput.addEventListener('click', async () => {
  try {
    const selected = await window.sfxApi.selectOutput(state.outputPath);
    if (!selected) return;
    state.outputPath = selected;
    state.outputOverridden = true;
    localLog(`Output directory overridden: ${selected}`);
    render();
  } catch (error) {
    showError(error.message);
  }
});

elements.runButton.addEventListener('click', async () => {
  if (state.isRunning) return;
  state.isRunning = true;
  state.isCancelling = false;
  state.status = 'validating';
  state.statusDetail = '';
  state.progress = 0;
  render();
  try {
    await window.sfxApi.startTask(state.inputPath, state.outputPath);
  } catch (error) {
    finishTask('error');
    appendLog(`[ERROR] ${error.message}`, 'ERROR');
    showError(error.message);
  }
});

elements.cancelButton.addEventListener('click', async () => {
  if (!state.isRunning || state.isCancelling) return;
  state.isCancelling = true;
  state.status = 'cancelling';
  state.statusDetail = '';
  render();
  try {
    await window.sfxApi.cancelTask();
  } catch (error) {
    state.isCancelling = false;
    state.status = 'error';
    render();
    appendLog(`[ERROR] ${error.message}`, 'ERROR');
    showError(error.message);
  }
});

elements.clearLog.addEventListener('click', () => {
  state.logs = [];
  elements.logView.replaceChildren();
  localLog('Activity log cleared.');
});

elements.themeToggle.addEventListener('click', async () => {
  themeRevision += 1;
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  render();
  try {
    await window.sfxApi.setSettings({ theme: state.theme });
  } catch (error) {
    appendLog(`[WARNING] Could not save theme preference: ${error.message}`, 'WARNING');
  }
});

window.sfxApi.onTaskEvent((event) => {
  switch (event.type) {
    case 'task:state':
      if (state.isCancelling) break;
      state.status = event.state;
      state.statusDetail = '';
      if (event.state === 'completed') state.progress = 100;
      render();
      break;
    case 'task:progress':
      state.progress = Math.max(0, Math.min(100, Number(event.value) || 0));
      render();
      break;
    case 'task:log':
      appendLog(event.message, event.level);
      break;
    case 'task:completed':
      state.progress = 100;
      finishTask('completed');
      state.statusDetail = `Completed: ${event.outputPath.split(/[\\/]/).pop()}`;
      render();
      break;
    case 'task:cancelled':
      finishTask('cancelled');
      break;
    case 'task:error':
    case 'backend:error':
      finishTask('error');
      appendLog(`[ERROR] ${event.message}`, 'ERROR');
      showError(event.message);
      break;
    case 'task:closing':
      state.isCancelling = true;
      state.status = 'cancelling';
      state.statusDetail = '';
      render();
      break;
  }
});

const settingsRequestRevision = themeRevision;
window.sfxApi.getSettings()
  .then((settings) => {
    if (themeRevision !== settingsRequestRevision) return;
    state.theme = settings.theme === 'dark' ? 'dark' : 'light';
    render();
  })
  .catch((error) => appendLog(`[WARNING] Could not read settings: ${error.message}`, 'WARNING'));

render();
