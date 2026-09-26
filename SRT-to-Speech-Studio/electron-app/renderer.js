const PLAY_ICON_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
const RETRY_ICON_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/></svg>';
const MOON_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
const SUN_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const THEME_KEY = 'srtts:theme';
const LIGHT_THEME = 'light';
const DARK_THEME = 'dark';
const THREADS_KEY = 'srtts:threads';
const TTS_MODEL_KEY = 'srtts:tts-model';
const PANEL_WIDTH_KEY = 'srtts:table-panel-width';
const MIN_PANEL_WIDTH = 320;
const PANEL_RESIZE_STEP = 24;
const DEFAULT_PAGE_SIZE = 10;
const FALLBACK_ROW_HEIGHT = 36; // matches the --row-h default in styles.css
const DEFAULT_TTS_MODEL = 'vieneu';
const MELOTTS_MODEL = 'melotts';
const MELO_SPEAKERS = {
  EN: ['EN-US', 'EN-BR', 'EN_INDIA', 'EN-AU', 'EN-Default'],
  ES: ['ES'], FR: ['FR'], ZH: ['ZH'], JP: ['JP'], KR: ['KR']
};

// Mirrors the constants in studio/pipeline.py: 4 is the default, not a limit.
const DEFAULT_PROCESSOR_COUNT = 4;
const MAX_CONTENT_ATTEMPTS = 3;
// handleStopped's cancel-path message below is unrelated to the duration/content
// distinction (it only ever fires from a manual Cancel), so its wording and the
// constants it uses are untouched by this plan.
const MAX_DURATION_RETRIES = 3;
const RETRY_STOPPED_REASON = 'processing stopped after final duration validation failure';

const STATUS_LABEL = {
  pending: '', processing: 'Processing…', success: 'Success', fail: 'Fail', skipped: 'Skipped'
};
const TIMING_BADGE_LABEL = {
  SPEED_ADJUST: 'Speed Adjust', TIMING_WARNING: 'Warning'
};
const FILTER_LABEL = { all: 'All', success: 'Success', fail: 'Fail' };

const state = {
  cues: [], currentPage: 1, pageSize: DEFAULT_PAGE_SIZE, subtitlePath: '', voicePath: '',
  outputPath: '', busy: false, failures: [], canRetry: false, cancelRequested: false,
  player: null, filter: 'all', retryingCueId: null, packaging: false, validating: false, startTime: null, elapsedTimer: null,
  // Post-synthesis content validation (ASR) has no progress event of its own;
  // this counter drives a "Validating X/Y" status once that stage starts, so
  // a run that's still legitimately working doesn't look frozen at 100%.
  total: 0, asrValidated: 0, validatingContent: false,
  // Auto mode: the row count grows/shrinks to exactly fill the table's
  // available height instead of a fixed count. Off once the user picks a
  // specific "Show X per page" value.
  autoPageSize: true
};

const elements = {
  subtitleInput: document.querySelector('#subtitle-input'),
  subtitlePath: document.querySelector('#subtitle-path'),
  voiceInput: document.querySelector('#voice-input'),
  voiceLabel: document.querySelector('#voice-label'),
  voicePath: document.querySelector('#voice-path'),
  outputInput: document.querySelector('#output-input'),
  outputPath: document.querySelector('#output-path'),
  createButton: document.querySelector('#create-button'),
  retryButton: document.querySelector('#retry-button'),
  saveButton: document.querySelector('#save-button'),
  validateButton: document.querySelector('#validate-button'),
  cancelButton: document.querySelector('#cancel-button'),
  status: document.querySelector('#status-text'),
  progressPercent: document.querySelector('#progress-percent'),
  progress: document.querySelector('#progress'),
  elapsedTime: document.querySelector('#elapsed-time'),
  rows: document.querySelector('#subtitle-rows'),
  emptyState: document.querySelector('#empty-state'),
  pagination: document.querySelector('#pagination'),
  tableTitle: document.querySelector('#table-title'),
  log: document.querySelector('#log-console'),
  clearLogButton: document.querySelector('#clear-log-button'),
  threadsSelect: document.querySelector('#threads-select'),
  ttsModelSelect: document.querySelector('#tts-model-select'),
  meloLanguageGroup: document.querySelector('#melo-language-group'),
  meloLanguageSelect: document.querySelector('#melo-language-select'),
  meloSpeakerGroup: document.querySelector('#melo-speaker-group'),
  meloSpeakerSelect: document.querySelector('#melo-speaker-select'),
  modelNote: document.querySelector('#model-note'),
  validateCheckbox: document.querySelector('#validate-checkbox'),
  statusFilter: document.querySelector('#status-filter'),
  pageSizeSelect: document.querySelector('#page-size-select'),
  gotoInput: document.querySelector('#goto-page-input'),
  gotoTotal: document.querySelector('#goto-page-total'),
  themeToggle: document.querySelector('#theme-toggle'),
  workspace: document.querySelector('#workspace'),
  tablePanel: document.querySelector('#table-panel'),
  processingPanel: document.querySelector('#processing-panel'),
  panelResizer: document.querySelector('#panel-resizer'),
  tableContainer: document.querySelector('#table-container'),
  tableHead: document.querySelector('#table-head')
};

function parseSrt(source) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized.split(/\n{2,}/).flatMap((block, fallbackIndex) => {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) return [];
    const numericId = Number.parseInt(lines[0].trim(), 10);
    return [{
      id: Number.isNaN(numericId) ? fallbackIndex + 1 : numericId,
      // Position in the file; the backend reports its own copy of this index
      // for every processed line, so a filtered view can never shift it.
      position: fallbackIndex,
      duration: lines[timingIndex].trim(), text: lines.slice(timingIndex + 1).join(' ').trim(),
      status: 'pending', attempts: 0
    }];
  });
}

function timestamp(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

const MAX_LOG_ROWS = 500;

function appendLog(message, type = 'info') {
  const row = document.createElement('div');
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = `[${time}]`;
  const messageSpan = document.createElement('span');
  messageSpan.className = message.includes('\n') ? `${type} detail` : type;
  messageSpan.textContent = message;
  row.append(timeSpan, ' — ', messageSpan);
  elements.log.append(row);
  while (elements.log.childElementCount > MAX_LOG_ROWS) {
    elements.log.firstElementChild.remove();
  }
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setProgress(value) {
  const clamped = Math.max(0, Math.min(100, value));
  elements.progress.value = clamped;
  elements.progressPercent.textContent = `${clamped.toFixed(1)}%`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
}

function startElapsedTimer() {
  state.startTime = Date.now();
  elements.elapsedTime.textContent = '00:00:00';
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = setInterval(() => {
    elements.elapsedTime.textContent = formatElapsed(Date.now() - state.startTime);
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : '?';
}

function formatSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(2)}x` : '—';
}

function cuesFor(index) {
  return state.cues.filter((cue) => cue.id === index);
}

function applyStatus(index, patch) {
  for (const cue of cuesFor(index)) {
    Object.assign(cue, patch);
  }
}

function visibleCues() {
  if (state.filter === 'all') return state.cues;
  return state.cues.filter((cue) => cue.status === state.filter);
}

function isLocked() {
  return state.busy || state.retryingCueId !== null || state.packaging || state.validating;
}

function currentTtsConfig() {
  return {
    ttsModel: elements.ttsModelSelect.value || DEFAULT_TTS_MODEL,
    meloLanguage: elements.meloLanguageSelect.value || 'EN',
    meloSpeaker: elements.meloSpeakerSelect.value || 'EN-US'
  };
}

function updateMeloSettings() {
  const isMelo = elements.ttsModelSelect.value === MELOTTS_MODEL;
  elements.meloLanguageGroup.hidden = !isMelo;
  elements.meloSpeakerGroup.hidden = !isMelo;
  elements.modelNote.hidden = !isMelo;
  elements.voiceLabel.textContent = isMelo ? 'Voice Profile (not used)' : 'Voice Profile';
  if (isMelo) {
    elements.voicePath.textContent = 'MeloTTS uses the selected built-in speaker';
    elements.voicePath.classList.remove('is-set');
  } else {
    elements.voicePath.textContent = state.voicePath || 'Choose a voice sample';
    if (state.voicePath) elements.voicePath.classList.add('is-set');
    else elements.voicePath.classList.remove('is-set');
  }
}

function resetGeneratedAudioForModelChange() {
  if (!state.cues.some((cue) => cue.audioFilename || cue.status !== 'pending')) return;
  state.failures = [];
  state.canRetry = false;
  state.cues = state.cues.map((cue) => ({
    ...cue, audioFilename: undefined, status: 'pending', attempts: 0,
    lastError: undefined, speed: undefined, contentStatus: undefined, similarity: undefined
  }));
  setProgress(0);
  elements.status.textContent = 'Ready';
  appendLog('TTS configuration changed; generated-row state was cleared to prevent model mixing.');
}

function populateMeloSpeakers() {
  const speakers = MELO_SPEAKERS[elements.meloLanguageSelect.value] || MELO_SPEAKERS.EN;
  elements.meloSpeakerSelect.replaceChildren();
  for (const speaker of speakers) {
    const option = document.createElement('option');
    option.value = speaker;
    option.textContent = speaker;
    elements.meloSpeakerSelect.append(option);
  }
  elements.meloSpeakerSelect.value = speakers[0];
}

function refreshControls() {
  const isMelo = elements.ttsModelSelect.value === MELOTTS_MODEL;
  const valid = state.subtitlePath && (isMelo || state.voicePath) && state.outputPath;
  const locked = isLocked();
  elements.createButton.disabled = locked || !valid;
  elements.retryButton.disabled = locked || !state.canRetry || !valid;
  elements.cancelButton.disabled = !state.busy;
  elements.subtitleInput.disabled = locked;
  elements.voiceInput.disabled = locked || isMelo;
  elements.outputInput.disabled = locked;
  elements.threadsSelect.disabled = locked;
  elements.ttsModelSelect.disabled = locked;
  elements.meloLanguageSelect.disabled = locked;
  elements.meloSpeakerSelect.disabled = locked;
  elements.validateCheckbox.disabled = locked;
  elements.statusFilter.disabled = false;
  const hasAudio = state.cues.some((cue) => Boolean(cue.audioFilename));
  elements.saveButton.disabled = locked || !hasAudio;
  elements.validateButton.disabled = locked || !hasAudio;
}

async function playPreview(filename) {
  try {
    if (state.player) state.player.pause();
    const url = await window.desktopAPI.previewAudio(filename);
    state.player = new Audio(url);
    await state.player.play();
    appendLog(`Playing ${filename}`);
  } catch (error) {
    appendLog(`Unable to play audio: ${error.message}`, 'error');
  }
}

function rowFor(cue) {
  const row = document.createElement('tr');
  const id = document.createElement('td');
  const duration = document.createElement('td');
  const content = document.createElement('td');
  const speed = document.createElement('td');
  const status = document.createElement('td');
  const action = document.createElement('td');
  const actions = document.createElement('div');
  const playButton = document.createElement('button');
  const retryButton = document.createElement('button');

  id.className = 'col-id';
  duration.className = 'col-duration';
  content.className = 'col-text';
  speed.className = 'col-speed';
  status.className = 'col-status';
  action.className = 'col-action';
  actions.className = 'actions-cell';

  id.textContent = cue.id;
  duration.textContent = cue.duration;
  content.textContent = cue.text;
  speed.textContent = formatSpeed(cue.speed);
  const label = STATUS_LABEL[cue.status] || '';
  const timingBadge = cue.status === 'success' ? TIMING_BADGE_LABEL[cue.timingStatus] : undefined;
  status.textContent = timingBadge || label;
  if (timingBadge) status.classList.add('status-timing');
  else if (label) status.classList.add(`status-${cue.status}`);
  status.dataset.status = cue.status;
  if (timingBadge) status.dataset.timingStatus = cue.timingStatus;

  playButton.className = 'btn-play';
  playButton.type = 'button';
  playButton.disabled = !cue.audioFilename;
  if (cue.audioFilename) {
    playButton.innerHTML = `${PLAY_ICON_SVG}<span>Play</span>`;
    playButton.addEventListener('click', () => playPreview(cue.audioFilename));
  } else {
    playButton.textContent = '—';
  }

  // Manual retry is offered for every row; retryCue() asks for confirmation
  // before redoing a line that already passed.
  const retryable = (cue.status === 'success' || cue.status === 'fail') && !isLocked();
  retryButton.className = 'btn-retry';
  retryButton.type = 'button';
  retryButton.disabled = !retryable;
  retryButton.innerHTML = `${RETRY_ICON_SVG}<span>Retry</span>`;
  retryButton.addEventListener('click', () => retryCue(cue));

  actions.append(playButton, retryButton);
  action.append(actions);
  row.append(id, duration, content, speed, status, action);
  return row;
}

function renderRows(visible) {
  const start = (state.currentPage - 1) * state.pageSize;
  const pageCues = visible.slice(start, start + state.pageSize);
  elements.rows.replaceChildren();
  for (const cue of pageCues) {
    elements.rows.append(rowFor(cue));
  }
}

function renderEmptyState(visible) {
  if (state.cues.length === 0) {
    elements.emptyState.textContent = 'Choose an SRT file to preview its content.';
    elements.emptyState.hidden = false;
    return;
  }
  if (visible.length === 0) {
    elements.emptyState.textContent =
      `No subtitle lines with Status "${FILTER_LABEL[state.filter]}".`;
    elements.emptyState.hidden = false;
    return;
  }
  elements.emptyState.hidden = true;
}

function pageButton(label, targetPage, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `page-btn${options.active ? ' active' : ''}`;
  button.textContent = label;
  button.disabled = Boolean(options.disabled);
  button.setAttribute('aria-label', options.ariaLabel || `Page ${label}`);
  if (options.active) button.setAttribute('aria-current', 'page');
  button.addEventListener('click', () => { state.currentPage = targetPage; render(); });
  return button;
}

function pageEllipsis() {
  const span = document.createElement('span');
  span.className = 'page-ellipsis';
  span.textContent = '…';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function renderPagination(visible) {
  const pageCount = Math.max(1, Math.ceil(visible.length / state.pageSize));
  state.currentPage = Math.min(state.currentPage, pageCount);
  elements.pagination.replaceChildren();
  elements.pagination.append(
    pageButton('«', 1, { disabled: state.currentPage === 1, ariaLabel: 'First page' }),
    pageButton('‹', Math.max(1, state.currentPage - 1), {
      disabled: state.currentPage === 1, ariaLabel: 'Previous page'
    })
  );
  const first = Math.max(1, Math.min(state.currentPage - 2, pageCount - 4));
  const last = Math.min(pageCount, first + 4);
  if (first > 1) {
    elements.pagination.append(pageButton('1', 1, {}));
    if (first > 2) elements.pagination.append(pageEllipsis());
  }
  for (let page = first; page <= last; page += 1) {
    elements.pagination.append(pageButton(String(page), page, { active: page === state.currentPage }));
  }
  if (last < pageCount) {
    if (last < pageCount - 1) elements.pagination.append(pageEllipsis());
    elements.pagination.append(pageButton(String(pageCount), pageCount, {}));
  }
  elements.pagination.append(
    pageButton('›', Math.min(pageCount, state.currentPage + 1), {
      disabled: state.currentPage === pageCount, ariaLabel: 'Next page'
    }),
    pageButton('»', pageCount, {
      disabled: state.currentPage === pageCount, ariaLabel: 'Last page'
    })
  );
  elements.gotoInput.max = String(pageCount);
  elements.gotoInput.value = String(state.currentPage);
  elements.gotoTotal.textContent = `/ ${pageCount}`;
}

function currentRowHeight() {
  if (typeof getComputedStyle !== 'function') return FALLBACK_ROW_HEIGHT;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_ROW_HEIGHT;
}

// How many rows fit the table's actual height right now, so Auto mode can
// grow or shrink the page size (11, 12, 13, ...) until the last row's
// bottom border touches the container's bottom edge - no leftover gap.
function computeAutoRowCount() {
  const container = elements.tableContainer;
  const head = elements.tableHead;
  if (!container || !head) return DEFAULT_PAGE_SIZE;
  const available = (container.clientHeight || 0) - (head.offsetHeight || 0);
  const count = Math.floor(available / currentRowHeight());
  return count > 0 ? count : DEFAULT_PAGE_SIZE;
}

function handleTableContainerResize() {
  if (!state.autoPageSize) return;
  const next = computeAutoRowCount();
  if (next === state.pageSize) return;
  state.pageSize = next;
  render();
}

function render() {
  const visible = visibleCues();
  elements.tableTitle.textContent = `Subtitle Segments (${state.cues.length} total)`;
  renderRows(visible);
  renderPagination(visible);
  renderEmptyState(visible);
  refreshControls();
}

async function retryCue(cue) {
  if (state.busy || state.retryingCueId !== null) return;
  if (cue.status === 'success' && !window.confirm(
    `Subtitle #${cue.id} already passed. Regenerate it anyway? The current audio will be replaced.`
  )) {
    return;
  }
  const previous = cue.status;
  state.retryingCueId = cue.id;
  applyStatus(cue.id, { status: 'processing', speed: undefined });
  render();
  appendLog(
    `Manual Retry:\nSubtitle #${cue.id}\nPrevious Status: ${STATUS_LABEL[previous] || previous}`
  );
  try {
    await window.desktopAPI.retrySegment({
      subtitlePath: state.subtitlePath, voicePath: state.voicePath,
      outputPath: state.outputPath, position: cue.position, index: cue.id,
      validateContent: elements.validateCheckbox.checked, ...currentTtsConfig()
    });
  } catch (error) {
    state.retryingCueId = null;
    applyStatus(cue.id, { status: previous });
    appendLog(`Manual Retry Failed\n${error.message}`, 'error');
    render();
  }
}

async function saveProject() {
  if (state.packaging) return;
  state.packaging = true;
  elements.status.textContent = 'Saving project…';
  appendLog('Save Project: packaging the current build…');
  render();
  try {
    await window.desktopAPI.saveProject({
      subtitlePath: state.subtitlePath, voicePath: state.voicePath, outputPath: state.outputPath,
      ...currentTtsConfig()
    });
  } catch (error) {
    state.packaging = false;
    appendLog(`Save Project failed to start: ${error.message}`, 'error');
    elements.status.textContent = 'Save failed';
    render();
  }
}

async function runValidation() {
  if (state.validating) return;
  state.validating = true;
  elements.status.textContent = 'Starting validation…';
  appendLog('Validate Now: checking existing audio against subtitle text…');
  render();
  try {
    await window.desktopAPI.validateContent({
      subtitlePath: state.subtitlePath, voicePath: state.voicePath, outputPath: state.outputPath,
      ...currentTtsConfig()
    });
  } catch (error) {
    state.validating = false;
    appendLog(`Validate failed to start: ${error.message}`, 'error');
    elements.status.textContent = 'Validate failed';
    render();
  }
}

async function runSynthesis(retry = false) {
  state.busy = true;
  state.cancelRequested = false;
  if (!retry) {
    state.failures = [];
    state.canRetry = false;
    state.cues = state.cues.map((cue) => ({
      ...cue, audioFilename: undefined, status: 'pending', attempts: 0,
      wavDuration: undefined, timelineDuration: undefined, overflow: undefined,
      lastError: undefined, speed: undefined
    }));
    setProgress(0);
  }
  elements.status.textContent = retry ? 'Retrying failed lines…' : 'Starting synthesis…';
  appendLog(retry ? 'Retry started for failed subtitle lines' : 'Synthesis started');
  startElapsedTimer();
  render();
  try {
    const result = await window.desktopAPI.startSynthesis({
      subtitlePath: state.subtitlePath, voicePath: state.voicePath,
      outputPath: state.outputPath, retry,
      workers: Number(elements.threadsSelect.value),
      validateContent: elements.validateCheckbox.checked, ...currentTtsConfig()
    });
    appendLog(`Output: ${result.destination}`);
  } catch (error) {
    state.busy = false;
    stopElapsedTimer();
    elements.status.textContent = 'Unable to start synthesis';
    appendLog(error.message, 'error');
    refreshControls();
  }
}

function contentFailureReport(event) {
  return [
    '[Content Validation Failed]',
    `Subtitle: #${event.index}`,
    `Timeline: ${timestamp(event.start)} --> ${timestamp(event.end)}`,
    `Reason: ${event.reason}`,
    `Attempt: ${event.attempts}`,
    `File: ${event.audio_filename || '(discarded)'}`,
    'Status: Fail'
  ].join('\n');
}

function handleSegmentResult(event) {
  // Any fresh result (a retry, or a normal run's own attempt) supersedes
  // whatever content-check verdict a prior Validate Now pass left on this
  // cue -- otherwise a row that just got new audio could still carry a
  // stale contentStatus/similarity from before.
  const patch = {
    status: event.status, attempts: event.attempts, contentStatus: undefined,
    similarity: undefined, speed: undefined
  };
  if (typeof event.position === 'number') patch.position = event.position;
  if (typeof event.timing_status === 'string') patch.timingStatus = event.timing_status;
  if (event.status === 'success' && event.audio_filename) {
    patch.audioFilename = event.audio_filename;
    if (Number.isFinite(Number(event.speed)) && Number(event.speed) > 0) {
      patch.speed = Number(event.speed);
    }
    patch.lastError = undefined;
  } else {
    patch.lastError = event.message || undefined;
  }
  applyStatus(event.index, patch);

  if (event.manual) {
    if (event.status === 'success') {
      appendLog(`Manual Retry Success\nSubtitle #${event.index}`);
    } else {
      appendLog(`Manual Retry Failed\n${event.message || ''}`, 'error');
    }
  } else if (event.status === 'fail') {
    if (event.reason && event.reason.startsWith('CONTENT_')) {
      appendLog(contentFailureReport(event), 'error');
    } else {
      appendLog(`Subtitle #${event.index} generation failed: ${event.message}`, 'error');
    }
  }
  render();
}

function handleStopped(event) {
  appendLog(
    `Processing stopped because subtitle #${event.index} failed duration validation ` +
    `after ${MAX_DURATION_RETRIES} retries.`,
    'error'
  );
  const skipped = Array.isArray(event.skipped) ? event.skipped : [];
  for (const item of skipped) {
    appendLog(
      `Subtitle #${item.index} (${timestamp(item.start)} --> ${timestamp(item.end)}) — ` +
      `Skipped: ${RETRY_STOPPED_REASON}`
    );
    applyStatus(item.index, { status: 'skipped', position: item.position });
  }
  appendLog(`${skipped.length} subtitle line(s) were not processed. Status remains "Skipped".`);
  render();
}

function handleBackendEvent(event) {
  switch (event.type) {
    case 'log':
      appendLog(event.message);
      break;
    case 'status':
      // The initial content-validation stage has no per-line progress event
      // of its own; track its start here so segment_asr_result (below) can
      // render a live "Validating X/Y" instead of the status text sitting
      // frozen at "Processing <total>/<total>" for however long it takes.
      // A content-retry pass gets its own status line (with its own, smaller
      // line count) and does not use this counter -- state.total would be
      // the wrong denominator for it.
      state.validatingContent = event.message === 'Validating audio content...';
      elements.status.textContent = event.message;
      appendLog(event.message);
      break;
    case 'started':
      state.total = event.total;
      state.asrValidated = 0;
      state.validatingContent = false;
      elements.status.textContent = `Processing 0/${event.total}`;
      appendLog(
        `Processing started\nSelected processors: ${event.processors ?? event.workers}\n` +
        `Total subtitles: ${event.total}`
      );
      break;
    case 'resumed':
      setProgress(event.completed * 100 / Math.max(1, event.total));
      elements.status.textContent = `Resuming ${event.completed}/${event.total}`;
      appendLog(`Resuming from saved progress (${event.completed}/${event.total})`);
      break;
    case 'segment_started':
      applyStatus(event.index, { status: 'processing', position: event.position, speed: undefined });
      render();
      break;
    case 'segment_retry':
      appendLog(
        `Subtitle #${event.index} generation failed once. ` +
        `Auto retry ${event.attempt}/${event.max_attempts}.`
      );
      break;
    case 'segment_result':
      handleSegmentResult(event);
      break;
    case 'segment_asr_result':
      applyStatus(event.index, { contentStatus: event.content_status, similarity: event.similarity });
      // Only the manual Validate Now flow (state.validating) flips status
      // here directly: a normal run's own content-retry loop resolves a
      // failing line through a later segment_result event instead, and must
      // not be short-circuited by this one.
      if (state.validating && event.content_status !== 'CONTENT_OK') {
        applyStatus(event.index, { status: 'fail' });
        appendLog(
          `Validate Now: Subtitle #${event.index} content mismatch (${event.content_status}, ` +
          `similarity ${event.similarity.toFixed(2)})${event.message ? `\n${event.message}` : ''}`,
          'error'
        );
      }
      if (state.validatingContent) {
        state.asrValidated += 1;
        elements.status.textContent = `Validating ${state.asrValidated}/${state.total}`;
      }
      render();
      break;
    case 'progress':
      setProgress(event.completed * 100 / Math.max(1, event.total));
      elements.status.textContent = `Processing ${event.completed}/${event.total}`;
      appendLog(`Line ${event.entry?.index ?? '?'} completed (${event.completed}/${event.total})`);
      break;
    case 'item_error':
      state.failures.push(event);
      appendLog(`Line ${event.index} failed: ${event.message}`, 'error');
      break;
    case 'stopped':
      handleStopped(event);
      break;
    case 'failed':
      state.failures = Array.isArray(event.failures) ? event.failures : state.failures;
      state.canRetry = true;
      elements.status.textContent = `Finished with ${state.failures.length} failed line(s)`;
      appendLog(`Failed subtitle lines: ${state.failures.map((item) => `#${item.index}`).join(', ')}`, 'error');
      break;
    case 'complete':
      state.cues = event.entries.map((entry) => ({
        id: entry.index,
        duration: `${timestamp(entry.start)} --> ${timestamp(entry.end)}`,
        text: String(entry.content).replace(/\n/g, ' '),
        audioFilename: entry.audio_filename,
        speed: entry.timing?.speed,
        status: 'success', attempts: 1
      }));
      state.failures = [];
      state.canRetry = false;
      state.currentPage = 1;
      setProgress(100);
      elements.status.textContent = 'Completed — ready to save';
      appendLog(`Completed in ${event.elapsed}. Save Project to export: ${event.destination}`);
      stopElapsedTimer();
      render();
      break;
    case 'retry_exit':
      if (state.retryingCueId !== null) {
        const cue = state.cues.find((item) => item.id === state.retryingCueId);
        if (cue && cue.status === 'processing') {
          applyStatus(cue.id, { status: 'fail' });
          appendLog('Manual Retry did not finish; the line is still marked Fail.', 'error');
        }
      }
      state.retryingCueId = null;
      render();
      break;
    case 'retry_error':
      appendLog(`ERROR: ${event.message}`, 'error');
      break;
    case 'packaged':
      appendLog(`Project saved: ${event.destination}`);
      elements.status.textContent = 'Project saved';
      break;
    case 'package_exit':
      state.packaging = false;
      render();
      break;
    case 'package_error':
      appendLog(`ERROR: ${event.message}`, 'error');
      break;
    case 'validation_started':
      state.total = event.total;
      state.asrValidated = 0;
      state.validatingContent = true;
      elements.status.textContent = `Validating 0/${event.total}`;
      appendLog(`Validating ${event.total} line(s) with existing audio…`);
      break;
    case 'validation_complete':
      state.validating = false;
      state.validatingContent = false;
      elements.status.textContent = `Validated ${event.total}/${event.total}`;
      appendLog('Validate Now finished.');
      render();
      break;
    case 'validate_exit':
      state.validating = false;
      state.validatingContent = false;
      render();
      break;
    case 'validate_error':
      appendLog(`ERROR: ${event.message}`, 'error');
      break;
    case 'error':
    case 'process_error':
      appendLog(`ERROR: ${event.message}`, 'error');
      break;
    case 'process_exit':
      state.busy = false;
      stopElapsedTimer();
      if (state.cancelRequested) {
        state.canRetry = true;
        elements.status.textContent = 'Canceled — progress saved for retry';
        appendLog('Synthesis canceled; completed lines were saved for retry');
      } else if (event.code !== 0 && state.failures.length === 0) {
        elements.status.textContent = 'Synthesis failed';
      }
      render();
      break;
    default:
      break;
  }
}

elements.subtitleInput.addEventListener('click', async () => {
  try {
    const selected = await window.desktopAPI.openSrt();
    if (!selected) return;
    const cues = parseSrt(selected.content);
    if (cues.length === 0) throw new Error('File does not contain valid SRT cues.');
    state.subtitlePath = selected.path;
    state.cues = cues;
    state.failures = [];
    state.canRetry = false;
    state.currentPage = 1;
    state.filter = 'all';
    elements.statusFilter.value = 'all';
    elements.subtitlePath.textContent = selected.path;
    elements.subtitlePath.classList.add('is-set');
    setProgress(0);
    render();
    appendLog(`Subtitle track loaded (${cues.length} lines): ${selected.path}`);
  } catch (error) {
    appendLog(`Unable to read SRT file: ${error.message}`, 'error');
  }
});

elements.voiceInput.addEventListener('click', async () => {
  const selectedPath = await window.desktopAPI.openVoice();
  if (!selectedPath) return;
  state.voicePath = selectedPath;
  elements.voicePath.textContent = selectedPath;
  elements.voicePath.classList.add('is-set');
  appendLog(`Voice sample selected: ${selectedPath}`);
  refreshControls();
});

elements.outputInput.addEventListener('click', async () => {
  const selectedPath = await window.desktopAPI.selectOutput();
  if (!selectedPath) return;
  state.outputPath = selectedPath;
  elements.outputPath.textContent = selectedPath;
  elements.outputPath.classList.add('is-set');
  appendLog(`Output folder: ${selectedPath}`);
  refreshControls();
});

elements.createButton.addEventListener('click', () => runSynthesis(false));
elements.retryButton.addEventListener('click', () => runSynthesis(true));
elements.saveButton.addEventListener('click', () => saveProject());
elements.validateButton.addEventListener('click', () => runValidation());
elements.cancelButton.addEventListener('click', async () => {
  state.cancelRequested = true;
  elements.status.textContent = 'Canceling…';
  elements.cancelButton.disabled = true;
  appendLog('Cancel requested; stopping worker…');
  await window.desktopAPI.cancelSynthesis();
});

elements.statusFilter.addEventListener('change', () => {
  // Filtering is a view concern: rows, queue and audio files are untouched.
  state.filter = elements.statusFilter.value;
  state.currentPage = 1;
  appendLog(`Status filter: ${FILTER_LABEL[state.filter]}`);
  render();
});

function normalizeTheme(theme) {
  return theme === DARK_THEME ? DARK_THEME : LIGHT_THEME;
}

function readThemePreference() {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY));
  } catch (_error) {
    return LIGHT_THEME;
  }
}

function saveThemePreference(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_error) {
    // The visual switch should still work when persistence is unavailable.
  }
}

function applyTheme(theme) {
  const normalizedTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalizedTheme;
  const dark = normalizedTheme === DARK_THEME;
  const actionLabel = dark ? 'Switch to light mode' : 'Switch to dark mode';
  elements.themeToggle.innerHTML = dark ? SUN_SVG : MOON_SVG;
  elements.themeToggle.setAttribute('aria-label', actionLabel);
  elements.themeToggle.setAttribute('title', actionLabel);
}

function initTheme() {
  applyTheme(readThemePreference());
}

elements.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
  applyTheme(next);
  saveThemePreference(next);
});

function initThreads() {
  const offered = [...elements.threadsSelect.options].map((option) => Number(option.value));
  const saved = Number(localStorage.getItem(THREADS_KEY));
  elements.threadsSelect.value = String(
    offered.includes(saved) ? saved : DEFAULT_PROCESSOR_COUNT
  );
}

function initModelSelector() {
  const saved = localStorage.getItem(TTS_MODEL_KEY);
  elements.ttsModelSelect.value = saved === MELOTTS_MODEL ? MELOTTS_MODEL : DEFAULT_TTS_MODEL;
  if (!elements.meloLanguageSelect.value) elements.meloLanguageSelect.value = 'EN';
  if (!elements.meloSpeakerSelect.value) elements.meloSpeakerSelect.value = 'EN-US';
  updateMeloSettings();
}

elements.threadsSelect.addEventListener('change', () => {
  localStorage.setItem(THREADS_KEY, elements.threadsSelect.value);
});

elements.ttsModelSelect.addEventListener('change', () => {
  localStorage.setItem(TTS_MODEL_KEY, elements.ttsModelSelect.value);
  resetGeneratedAudioForModelChange();
  updateMeloSettings();
  refreshControls();
  const label = elements.ttsModelSelect.selectedOptions?.[0]?.textContent;
  appendLog(`TTS model: ${label || elements.ttsModelSelect.value}`);
});

elements.meloLanguageSelect.addEventListener('change', () => {
  resetGeneratedAudioForModelChange();
  populateMeloSpeakers();
  refreshControls();
});

elements.meloSpeakerSelect.addEventListener('change', () => {
  resetGeneratedAudioForModelChange();
  refreshControls();
});

elements.pageSizeSelect.addEventListener('change', () => {
  const value = elements.pageSizeSelect.value;
  if (value === 'auto') {
    state.autoPageSize = true;
    state.pageSize = computeAutoRowCount();
  } else {
    state.autoPageSize = false;
    state.pageSize = Number(value);
  }
  state.currentPage = 1;
  render();
});

function applyGotoPage() {
  const pageCount = Number(elements.gotoInput.max) || 1;
  const requested = Math.round(Number(elements.gotoInput.value));
  const target = Math.min(pageCount, Math.max(1, Number.isFinite(requested) ? requested : 1));
  state.currentPage = target;
  render();
}

elements.gotoInput.addEventListener('change', applyGotoPage);
elements.gotoInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') applyGotoPage();
});

elements.clearLogButton.addEventListener('click', () => {
  elements.log.replaceChildren();
  appendLog('Log cleared');
});

// ---- Panel resizer: drag the divider to re-balance the table/processing
// widths. Persisted so the split survives a restart.
function clampPanelWidth(px) {
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  const resizerWidth = elements.panelResizer.getBoundingClientRect().width || 16;
  const max = Math.max(MIN_PANEL_WIDTH, workspaceWidth - resizerWidth - MIN_PANEL_WIDTH);
  return Math.min(max, Math.max(MIN_PANEL_WIDTH, Math.round(px)));
}

function applyPanelWidth(px) {
  elements.tablePanel.style.flex = `0 0 ${px}px`;
  elements.processingPanel.style.flex = '1 1 auto';
}

function savePanelWidth(px) {
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  const ratio = workspaceWidth > 0 ? px / workspaceWidth : 0;
  localStorage.setItem(PANEL_WIDTH_KEY, String(ratio));
}

function applyPanelRatio(ratio) {
  const workspaceWidth = elements.workspace.getBoundingClientRect().width;
  applyPanelWidth(clampPanelWidth(ratio * workspaceWidth));
}

// A ratio is always in (0, 1); anything outside that is a stale value saved
// as raw pixels by an older build and must be discarded, not applied.
function readSavedPanelRatio() {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : null;
}

function initPanelWidth() {
  const saved = readSavedPanelRatio();
  if (saved !== null) applyPanelRatio(saved);
  else localStorage.removeItem(PANEL_WIDTH_KEY);
}

let panelDrag = null;

elements.panelResizer.addEventListener('mousedown', (event) => {
  panelDrag = { startX: event.clientX, startWidth: elements.tablePanel.getBoundingClientRect().width };
  elements.panelResizer.classList.add('is-dragging');
  event.preventDefault();
});

document.addEventListener('mousemove', (event) => {
  if (!panelDrag) return;
  applyPanelWidth(clampPanelWidth(panelDrag.startWidth + (event.clientX - panelDrag.startX)));
});

document.addEventListener('mouseup', () => {
  if (!panelDrag) return;
  panelDrag = null;
  elements.panelResizer.classList.remove('is-dragging');
  savePanelWidth(Math.round(elements.tablePanel.getBoundingClientRect().width));
});

elements.panelResizer.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const delta = event.key === 'ArrowLeft' ? -PANEL_RESIZE_STEP : PANEL_RESIZE_STEP;
  const next = clampPanelWidth(elements.tablePanel.getBoundingClientRect().width + delta);
  applyPanelWidth(next);
  savePanelWidth(next);
});

window.addEventListener('resize', () => {
  const saved = readSavedPanelRatio();
  if (saved !== null) applyPanelRatio(saved);
});

initTheme();
initThreads();
initModelSelector();
initPanelWidth();

// Keep Auto page size in sync with the table's real height: window resizes,
// the panel-resizer drag, and the short-screen media query all change it.
if (typeof ResizeObserver === 'function' && elements.tableContainer) {
  new ResizeObserver(handleTableContainerResize).observe(elements.tableContainer);
}

window.desktopAPI.onBackendEvent(handleBackendEvent);
render();
