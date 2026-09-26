const MAX_LOG_ROWS = 500;
const AUTO_PAGE_SIZE = 'auto';
const THEME_STORAGE_KEY = 'bilibili-downloader:theme';
const SPLIT_STORAGE_KEY = 'bilibili-downloader:activity-panel-ratio';

const state = {
  items: [],
  rowState: new Map(),      // row -> {status, detail}
  page: 1,
  pageSize: AUTO_PAGE_SIZE,
  autoPageSize: 1,
  linksFile: '',
  outputDir: '',
  cookiesFile: '',
  phase: 'idle',            // idle | resolving | downloading
  paused: false,
  cancelRequested: false,
  activeRow: null,
  activeFraction: 0,
  accountStatus: 'none',    // none | checking | valid | invalid | expired | error
  accountUsername: '',
  accountMessage: '',
};

const elements = {
  linksInput: document.querySelector('#links-input'),
  linksPath: document.querySelector('#links-path'),
  outputInput: document.querySelector('#output-input'),
  outputPath: document.querySelector('#output-path'),
  cookiesInput: document.querySelector('#cookies-input'),
  cookiesPath: document.querySelector('#cookies-path'),
  startButton: document.querySelector('#start-button'),
  progressCount: document.querySelector('#progress-count'),
  progressBar: document.querySelector('#progress-bar'),
  etaLabel: document.querySelector('#eta-label'),
  pauseButton: document.querySelector('#pause-button'),
  cancelButton: document.querySelector('#cancel-button'),
  tableBody: document.querySelector('#table-body'),
  emptyState: document.querySelector('#empty-state'),
  pagination: document.querySelector('#pagination'),
  pageSizeSelect: document.querySelector('#page-size-select'),
  gotoInput: document.querySelector('#goto-input'),
  pageTotal: document.querySelector('#page-total'),
  mainSplit: document.querySelector('#main-split'),
  splitDivider: document.querySelector('#split-divider'),
  accountStatus: document.querySelector('#account-status'),
  checkAccountButton: document.querySelector('#check-account-button'),
  log: document.querySelector('#log'),
  clearLogButton: document.querySelector('#clear-log-button'),
  themeToggle: document.querySelector('#theme-toggle'),
  tableScroll: document.querySelector('.table-scroll'),
  progressStatus: document.querySelector('#progress-status'),
};

/* ---- theme ---- */
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, { persist = false } = {}) {
  const nextTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = nextTheme;
  const actionLabel = nextTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  elements.themeToggle.setAttribute('aria-label', actionLabel);
  elements.themeToggle.title = actionLabel;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch (_) {
      /* Theme switching still works when preference storage is unavailable. */
    }
  }
}

/* ---- formatting (mirrors legacy main_window.py) ---- */
function fmtDuration(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  if (total >= 3600) {
    return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function fmtBytes(size) {
  if (size == null) return '—';
  let value = Number(size);
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (value < 1000 || unit === 'TB') {
      return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1000;
  }
  return String(size);
}

function fmtViews(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M views`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K views`;
  return `${count} views`;
}

/* ---- log ---- */
function appendLog(level, message) {
  const empty = elements.log.querySelector('.log-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'log-row';
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = `[${time}]`;
  const msgSpan = document.createElement('span');
  msgSpan.className = `log-${(level || 'INFO').toLowerCase()}`;
  msgSpan.textContent = message;
  row.append(timeSpan, msgSpan);
  elements.log.append(row);
  while (elements.log.childElementCount > MAX_LOG_ROWS) {
    elements.log.firstElementChild.remove();
  }
  elements.log.scrollTop = elements.log.scrollHeight;
}

/* ---- progress ---- */
function setProgress(value) {
  elements.progressBar.value = Math.max(0, Math.min(100, value));
}

function updateOverall() {
  const total = state.items.length;
  let done = 0;
  for (const s of state.rowState.values()) {
    if (['Done', 'Completed'].includes(s.status)) done += 1;
  }
  const inFlight = state.activeRow !== null ? state.activeFraction : 0;
  const fraction = total ? Math.min(1, (done + inFlight) / total) : 0;
  const percent = Math.round(fraction * 100);
  elements.progressCount.textContent = `${done} / ${total} (${percent}%)`;
  if (state.phase === 'resolving') {
    elements.progressStatus.textContent = 'Resolving video details…';
  } else if (state.phase === 'downloading') {
    elements.progressStatus.textContent = state.paused ? 'Download paused' : 'Downloading';
  } else if (total > 0 && done === total) {
    elements.progressStatus.textContent = 'Download complete';
  } else {
    elements.progressStatus.textContent = 'Overall Progress';
  }
  setProgress(percent);
}

/* ---- table ---- */
function metaLine(item) {
  const parts = [];
  if (item.uploader) parts.push(`Uploader: ${item.uploader}`);
  parts.push(fmtDuration(item.duration));
  if (item.views) parts.push(fmtViews(item.views));
  if (item.date) parts.push(item.date);
  return parts.join(' · ');
}

function rowFor(item) {
  const tr = document.createElement('tr');
  tr.dataset.row = String(item.row);

  const idCell = document.createElement('td');
  idCell.className = 'col-id';
  idCell.textContent = String(item.id);

  const linkCell = document.createElement('td');
  linkCell.className = 'col-link';
  linkCell.textContent = item.url;
  linkCell.title = item.url;

  const detailCell = document.createElement('td');
  detailCell.className = 'col-detail';
  const title = document.createElement('div');
  title.className = 'detail-title';
  title.textContent = item.title;
  title.title = item.title;
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  meta.textContent = metaLine(item);
  detailCell.append(title, meta);

  const statusCell = document.createElement('td');
  statusCell.className = 'col-status';
  const label = document.createElement('span');
  label.className = 'status-label';
  const detail = document.createElement('span');
  detail.className = 'status-detail';
  statusCell.append(label, detail);

  const actionCell = document.createElement('td');
  actionCell.className = 'col-action';
  const actions = document.createElement('div');
  actions.className = 'actions-cell';
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'button button-ghost';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => openFolder(item.output_path));
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn-retry';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', () => retryRow(item.row));
  actions.append(openBtn, retryBtn);
  actionCell.append(actions);

  tr.append(idCell, linkCell, detailCell, statusCell, actionCell);
  return tr;
}

function applyRowStatus(tr, row) {
  const s = state.rowState.get(row) || { status: 'Queued', detail: '' };
  const label = tr.querySelector('.status-label');
  const detail = tr.querySelector('.status-detail');
  label.textContent = s.status || 'Queued';
  label.dataset.status = (s.status || 'Queued').toLowerCase();
  detail.textContent = s.detail || '';
  const retryBtn = tr.querySelector('.btn-retry');
  retryBtn.disabled = s.status !== 'Failed' || state.phase !== 'idle';
}

function effectivePageSize() {
  return state.pageSize === AUTO_PAGE_SIZE
    ? Math.max(1, state.autoPageSize)
    : state.pageSize;
}

function pageCount() {
  return Math.max(1, Math.ceil(state.items.length / effectivePageSize()));
}

function renderRows() {
  const size = effectivePageSize();
  const start = (state.page - 1) * size;
  const pageItems = state.items.slice(start, start + size);
  elements.tableBody.replaceChildren();
  for (const item of pageItems) {
    const tr = rowFor(item);
    applyRowStatus(tr, item.row);
    elements.tableBody.append(tr);
  }
}

function renderRow(row) {
  const tr = elements.tableBody.querySelector(`tr[data-row="${row}"]`);
  if (tr) applyRowStatus(tr, row);
}

function renderEmptyState() {
  elements.emptyState.hidden = state.items.length !== 0;
}

function pageButton(label, target, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `page-btn${options.active ? ' active' : ''}`;
  button.textContent = label;
  button.disabled = Boolean(options.disabled);
  if (options.ariaLabel) button.setAttribute('aria-label', options.ariaLabel);
  if (options.active) button.setAttribute('aria-current', 'page');
  button.addEventListener('click', () => { state.page = target; render(); });
  return button;
}

function renderPagination() {
  const count = pageCount();
  state.page = Math.min(Math.max(1, state.page), count);
  elements.pagination.replaceChildren();
  elements.pagination.append(
    pageButton('«', 1, { disabled: state.page === 1, ariaLabel: 'First page' }),
    pageButton('‹', state.page - 1, { disabled: state.page === 1, ariaLabel: 'Previous page' }),
  );
  const first = Math.max(1, Math.min(state.page - 2, count - 4));
  for (let p = first; p <= Math.min(count, first + 4); p += 1) {
    elements.pagination.append(pageButton(String(p), p, {
      active: p === state.page,
      ariaLabel: p === state.page ? `Page ${p}, current page` : `Go to page ${p}`,
    }));
  }
  elements.pagination.append(
    pageButton('›', state.page + 1, { disabled: state.page === count, ariaLabel: 'Next page' }),
    pageButton('»', count, { disabled: state.page === count, ariaLabel: 'Last page' }),
  );
  elements.pageSizeSelect.value = String(state.pageSize);
  elements.gotoInput.max = String(count);
  elements.pageTotal.textContent = `/ ${count}`;
  if (document.activeElement !== elements.gotoInput) {
    elements.gotoInput.value = String(state.page);
  }
}

function updateAutoPageSize() {
  if (state.pageSize !== AUTO_PAGE_SIZE) return;
  const header = elements.tableScroll.querySelector('thead');
  const firstRow = elements.tableBody.querySelector('tr');
  const headerHeight = header ? header.getBoundingClientRect().height : 36;
  const rowHeight = firstRow
    ? firstRow.getBoundingClientRect().height
    : (window.matchMedia('(max-height: 700px)').matches ? 30 : 36);
  const nextSize = Math.max(1, Math.floor((elements.tableScroll.clientHeight - headerHeight) / rowHeight));
  if (nextSize === state.autoPageSize) return;
  state.autoPageSize = nextSize;
  state.page = Math.min(state.page, pageCount());
  renderRows();
  renderPagination();
}

/* ---- splitter (table <-> activity log) ---- */
const DEFAULT_SIDE_RATIO = 0.25;
const PANEL_MIN_WIDTH = 320;
const SPLITTER_WIDTH = 16;

function savedSideRatio() {
  try {
    const value = Number.parseFloat(localStorage.getItem(SPLIT_STORAGE_KEY));
    return Number.isFinite(value) ? value : DEFAULT_SIDE_RATIO;
  } catch (_) {
    return DEFAULT_SIDE_RATIO;
  }
}

let sideRatio = savedSideRatio();

function applySideRatio({ persist = false } = {}) {
  if (window.matchMedia('(max-width: 1040px)').matches) return;
  const available = elements.mainSplit.clientWidth - SPLITTER_WIDTH;
  if (available <= 0) return;
  const minimum = Math.min(0.5, PANEL_MIN_WIDTH / available);
  const maximum = Math.max(0.5, 1 - (PANEL_MIN_WIDTH / available));
  const appliedRatio = Math.min(Math.max(sideRatio, minimum), maximum);
  document.documentElement.style.setProperty('--side-width', `${Math.round(available * appliedRatio)}px`);
  elements.splitDivider.setAttribute('aria-valuenow', String(Math.round(appliedRatio * 100)));
  if (persist) {
    sideRatio = appliedRatio;
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(sideRatio));
    } catch (_) {
      /* Resizing still works when preference storage is unavailable. */
    }
  }
}

function setSideWidth(width, { persist = false } = {}) {
  const available = elements.mainSplit.clientWidth - SPLITTER_WIDTH;
  if (available <= 0) return;
  sideRatio = width / available;
  applySideRatio({ persist });
}

let splitDragging = false;

elements.splitDivider.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  splitDragging = true;
  elements.splitDivider.classList.add('is-dragging');
  try {
    elements.splitDivider.setPointerCapture(event.pointerId);
  } catch {
    /* The pointer is already gone; pointermove on the divider still drives the drag. */
  }
  event.preventDefault();
});

elements.splitDivider.addEventListener('pointermove', (event) => {
  if (!splitDragging) return;
  const rect = elements.mainSplit.getBoundingClientRect();
  setSideWidth(rect.right - event.clientX, { persist: true });
});

function endSplitDrag(event) {
  if (!splitDragging) return;
  splitDragging = false;
  elements.splitDivider.classList.remove('is-dragging');
  try {
    if (elements.splitDivider.hasPointerCapture(event.pointerId)) {
      elements.splitDivider.releasePointerCapture(event.pointerId);
    }
  } catch {
    /* Capture was never taken. */
  }
}

elements.splitDivider.addEventListener('pointerup', endSplitDrag);
elements.splitDivider.addEventListener('pointercancel', endSplitDrag);

elements.splitDivider.addEventListener('keydown', (event) => {
  const currentWidth = (elements.mainSplit.clientWidth - SPLITTER_WIDTH) * sideRatio;
  if (event.key === 'ArrowLeft') {
    setSideWidth(currentWidth + 24, { persist: true });
  } else if (event.key === 'ArrowRight') {
    setSideWidth(currentWidth - 24, { persist: true });
  } else {
    return;
  }
  event.preventDefault();
});

/* Double-click restores the proportional default. */
elements.splitDivider.addEventListener('dblclick', () => {
  sideRatio = DEFAULT_SIDE_RATIO;
  try {
    localStorage.removeItem(SPLIT_STORAGE_KEY);
  } catch (_) {
    /* The in-memory default still applies when storage is unavailable. */
  }
  applySideRatio();
});

/* Keep the panel inside its bounds when the window itself is resized. */
window.addEventListener('resize', applySideRatio);

/* ---- account ---- */
function accountStatusLabel() {
  switch (state.accountStatus) {
    case 'checking': return 'Checking account…';
    case 'valid': return state.accountUsername
      ? `Logged in as: ${state.accountUsername}`
      : 'Account valid';
    case 'invalid': return 'Invalid cookies';
    case 'expired': return 'Cookies expired';
    case 'error': return 'Check Account failed';
    default: return 'No Cookies';
  }
}

function renderAccount() {
  const checking = state.accountStatus === 'checking';
  elements.accountStatus.textContent = accountStatusLabel();
  elements.accountStatus.dataset.status = state.accountStatus;
  elements.checkAccountButton.disabled = checking || !state.cookiesFile;
  setButtonLabel(elements.checkAccountButton, checking ? 'none' : 'check', checking ? 'Checking…' : 'Check Account');
}

/* ---- controls ---- */
function setButtonLabel(button, icon, label) {
  button.dataset.icon = icon;
  button.querySelector('.button-label').textContent = label;
}

function renderPauseButton() {
  setButtonLabel(elements.pauseButton, state.paused ? 'play' : 'pause', state.paused ? 'Resume' : 'Pause');
}

function refreshControls() {
  const busy = state.phase !== 'idle';
  elements.startButton.disabled = busy || !state.linksFile;
  elements.linksInput.disabled = busy;
  elements.pauseButton.disabled = state.phase !== 'downloading';
  elements.cancelButton.disabled = state.phase !== 'downloading';
}

function render() {
  renderRows();
  renderPagination();
  renderEmptyState();
  updateOverall();
  refreshControls();
  renderPauseButton();
  renderAccount();
}

/* ---- actions ---- */
async function openFolder(outputPath) {
  try {
    const error = await window.desktopAPI.openFolder(outputPath);
    if (error) appendLog('ERROR', `Unable to open folder: ${error}`);
  } catch (e) {
    appendLog('ERROR', `Unable to open folder: ${e.message}`);
  }
}

function retryRow(row) {
  if (state.phase !== 'idle') return;
  state.rowState.set(row, { status: 'Queued', detail: '' });
  state.phase = 'downloading';
  render();
  appendLog('INFO', `[${row + 1}/${state.items.length}] Retry: ${state.items[row].title}`);
  window.desktopAPI.download([row]);
}

/* ---- backend events ---- */
function onProgress(event) {
  const row = event.row;
  if (state.activeRow !== row) {
    state.activeRow = row;
    state.activeFraction = 0;
  }
  if (event.status === 'downloading') {
    state.activeFraction = event.fraction || 0;
    const detail = `${fmtBytes(event.received)} / ${fmtBytes(event.total)} (${Math.round((event.fraction || 0) * 100)}%)`;
    state.rowState.set(row, { status: 'Downloading', detail });
    if (event.eta) elements.etaLabel.textContent = `ETA: ${event.eta}`;
  } else if (event.status === 'finished') {
    state.activeFraction = 1;
    state.rowState.set(row, { status: 'Downloading', detail: 'Muxing…' });
  }
  renderRow(row);
  updateOverall();
}

function logRow(row, status, detail) {
  const total = state.items.length;
  const item = state.items.find((it) => it.row === row) || null;
  const title = item ? item.title : '';
  const prefix = `[${row + 1}/${total}]`;
  const key = (status || '').toLowerCase();
  if (key === 'downloading') {
    appendLog('INFO', `${prefix} Start: ${title}`);
  } else if (key === 'done' || key === 'completed') {
    appendLog('SUCCESS', `${prefix} Completed: ${title}`);
  } else if (key === 'failed') {
    appendLog('ERROR', `${prefix} Error: ${detail} - ${item ? item.url : ''}`);
  }
}

function onRowUpdate(event) {
  const row = event.row;
  state.rowState.set(row, { status: event.status, detail: event.detail || '' });
  if (row === state.activeRow && ['Done', 'Completed', 'Failed'].includes(event.status)) {
    state.activeRow = null;
    state.activeFraction = 0;
  }
  logRow(row, event.status, event.detail);
  renderRow(row);
  updateOverall();
}

function handleBackendEvent(event) {
  switch (event.type) {
    case 'log':
      appendLog(event.level || 'INFO', event.message);
      break;
    case 'account':
      state.accountStatus = event.status;
      state.accountUsername = event.username || '';
      state.accountMessage = event.message || '';
      renderAccount();
      break;
    case 'settings':
      state.settings = event.settings || {};
      break;
    case 'settings_saved':
      appendLog('INFO', 'Settings saved.');
      break;
    case 'analyze_progress':
      appendLog('INFO', `Resolving ${event.index}/${event.total}: ${event.url}`);
      break;
    case 'analyze_done':
      state.items = event.items || [];
      state.rowState = new Map(state.items.map((it) => [it.row, { status: 'Queued', detail: '' }]));
      state.page = 1;
      state.activeRow = null;
      state.activeFraction = 0;
      elements.etaLabel.textContent = '';
      updateOverall();
      state.phase = 'downloading';
      render();
      break;
    case 'analyze_failed':
      appendLog('ERROR', event.message);
      state.phase = 'idle';
      refreshControls();
      break;
    case 'progress':
      onProgress(event);
      break;
    case 'row_update':
      onRowUpdate(event);
      break;
    case 'download_done':
      state.phase = 'idle';
      state.activeRow = null;
      state.activeFraction = 0;
      elements.etaLabel.textContent = '';
      render();
      appendLog('INFO', state.cancelRequested ? 'Download cancelled.' : 'All downloads finished.');
      state.cancelRequested = false;
      break;
    case 'process_exit':
      appendLog('ERROR', 'Backend process exited unexpectedly.');
      state.phase = 'idle';
      refreshControls();
      break;
    default:
      break;
  }
}

/* ---- listeners ---- */
elements.linksInput.addEventListener('click', async () => {
  const path = await window.desktopAPI.selectLinks();
  if (!path) return;
  state.linksFile = path;
  elements.linksPath.textContent = path;
  elements.linksPath.classList.add('is-set');
  appendLog('INFO', `Link list selected: ${path}`);
  refreshControls();
});

elements.outputInput.addEventListener('click', async () => {
  const path = await window.desktopAPI.selectOutput();
  if (!path) return;
  state.outputDir = path;
  elements.outputPath.textContent = path;
  elements.outputPath.classList.add('is-set');
  appendLog('INFO', `Output folder: ${path}`);
});

elements.cookiesInput.addEventListener('click', async () => {
  const path = await window.desktopAPI.selectCookies();
  if (!path) return;
  state.cookiesFile = path;
  state.accountStatus = 'none';
  state.accountUsername = '';
  state.accountMessage = '';
  elements.cookiesPath.textContent = path;
  elements.cookiesPath.classList.add('is-set');
  appendLog('INFO', 'Cookies file selected');
  renderAccount();
});

elements.startButton.addEventListener('click', () => {
  if (state.phase !== 'idle') return;
  if (!state.linksFile) { appendLog('WARN', 'Select a link list file first.'); return; }
  state.items = [];
  state.rowState = new Map();
  state.page = 1;
  state.activeRow = null;
  state.activeFraction = 0;
  state.cancelRequested = false;
  elements.etaLabel.textContent = '';
  updateOverall();
  state.phase = 'resolving';
  render();
  appendLog('INFO', `Starting: ${state.linksFile}`);
  window.desktopAPI.startDownload({
    links_file: state.linksFile,
    output_dir: state.outputDir || null,
    cookies_file: state.cookiesFile || null,
  });
});

elements.checkAccountButton.addEventListener('click', () => {
  if (!state.cookiesFile || state.accountStatus === 'checking') return;
  state.accountStatus = 'checking';
  state.accountUsername = '';
  state.accountMessage = '';
  appendLog('INFO', 'Checking account...');
  renderAccount();
  window.desktopAPI.checkAccount(state.cookiesFile);
});

elements.pauseButton.addEventListener('click', () => {
  if (state.phase !== 'downloading') return;
  if (state.paused) {
    state.paused = false;
    window.desktopAPI.resume();
    appendLog('INFO', 'Resumed.');
  } else {
    state.paused = true;
    window.desktopAPI.pause();
    appendLog('INFO', 'Paused.');
  }
  renderPauseButton();
  updateOverall();
});

elements.cancelButton.addEventListener('click', () => {
  if (state.phase !== 'downloading') return;
  state.cancelRequested = true;
  window.desktopAPI.cancel();
  appendLog('WARN', 'Cancelling…');
});

elements.pageSizeSelect.addEventListener('change', () => {
  const value = elements.pageSizeSelect.value;
  state.pageSize = value === AUTO_PAGE_SIZE ? AUTO_PAGE_SIZE : Number(value);
  state.page = 1;
  render();
  updateAutoPageSize();
});

function commitGotoPage() {
  const count = pageCount();
  const requested = Number.parseInt(elements.gotoInput.value, 10);
  state.page = Number.isFinite(requested)
    ? Math.min(Math.max(1, requested), count)
    : state.page;
  render();
}

elements.gotoInput.addEventListener('change', commitGotoPage);
elements.gotoInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitGotoPage();
  }
});

elements.clearLogButton.addEventListener('click', () => {
  elements.log.replaceChildren();
  appendLog('INFO', 'Log cleared');
});

elements.themeToggle.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { persist: true });
});

/* ---- init ---- */
window.desktopAPI.onBackendEvent(handleBackendEvent);
window.desktopAPI.getSettings();
applyTheme(currentTheme());
applySideRatio();
render();
updateAutoPageSize();

const tableResizeObserver = new ResizeObserver(updateAutoPageSize);
tableResizeObserver.observe(elements.tableScroll);
