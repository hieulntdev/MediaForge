const MAX_LOG_ROWS = 500;
const AUTO_PAGE_SIZE = 'auto';
const THEME_STORAGE_KEY = 'bilibili-downloader:theme';
const SPLIT_STORAGE_KEY = 'bilibili-downloader:activity-panel-ratio';
const COLUMN_STORAGE_KEY = 'bilibili-downloader:column-widths';
const UI_STATE_STORAGE_KEY = 'bilibili-downloader:ui-state-v2';
const COLUMN_DEFINITIONS = Object.freeze({
  id: { width: 64, min: 56 },
  link: { width: 280, min: 160 },
  detail: { width: 290, min: 180 },
  status: { width: 120, min: 104 },
  speed: { width: 120, min: 104 },
  action: { width: 160, min: 144 },
});

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
  eta: '',
  accountStatus: 'none',    // none | checking | standardized cookie status
  accountUsername: '',
  accountMessage: '',
  logs: [],
  revision: 0,
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
  checkAccountButton: document.querySelector('#check-account-button'),
  log: document.querySelector('#log'),
  clearLogButton: document.querySelector('#clear-log-button'),
  themeToggle: document.querySelector('#theme-toggle'),
  tableScroll: document.querySelector('.table-scroll'),
  progressStatus: document.querySelector('#progress-status'),
  downloadTable: document.querySelector('.download-table'),
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

function fmtSpeed(bytesPerSecond) {
  let value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value < 0) return '—';
  for (const unit of ['B/s', 'KB/s', 'MB/s', 'GB/s']) {
    if (value < 1000 || unit === 'GB/s') {
      if (unit === 'B/s') return `${Math.round(value)} B/s`;
      if (value >= 100) return `${Math.round(value)} ${unit}`;
      return `${value.toFixed(2)} ${unit}`;
    }
    value /= 1000;
  }
  return '—';
}

function fmtViews(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M views`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K views`;
  return `${count} views`;
}

/* ---- log ---- */
function appendLogElement({ level, message, timestamp }) {
  const empty = elements.log.querySelector('.log-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'log-row';
  const time = new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });
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

function appendLog(level, message, { timestamp = Date.now(), persist = true } = {}) {
  const entry = { level: level || 'INFO', message: String(message || ''), timestamp };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOG_ROWS) state.logs.splice(0, state.logs.length - MAX_LOG_ROWS);
  appendLogElement(entry);
  if (persist) persistUIState();
}

function renderLogs() {
  elements.log.replaceChildren();
  if (state.logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'No activity yet.';
    elements.log.append(empty);
    return;
  }
  for (const entry of state.logs) appendLogElement(entry);
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
    elements.progressStatus.textContent = state.cancelRequested
      ? 'Cancelling…'
      : (state.paused ? 'Download paused' : 'Downloading');
  } else if (total > 0 && done === total) {
    elements.progressStatus.textContent = 'Download complete';
  } else {
    elements.progressStatus.textContent = 'Overall Progress';
  }
  setProgress(percent);
  elements.etaLabel.textContent = state.eta ? `ETA: ${state.eta}` : '';
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

  const speedCell = document.createElement('td');
  speedCell.className = 'col-speed';

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

  tr.append(idCell, linkCell, detailCell, statusCell, speedCell, actionCell);
  return tr;
}

function applyRowStatus(tr, row) {
  const s = state.rowState.get(row) || { status: 'Queued', detail: '' };
  const label = tr.querySelector('.status-label');
  const detail = tr.querySelector('.status-detail');
  const speed = tr.querySelector('.col-speed');
  label.textContent = s.status || 'Queued';
  label.dataset.status = (s.status || 'Queued').toLowerCase();
  detail.textContent = s.detail || '';
  const statusKey = String(s.status || '').toLowerCase();
  if (state.paused && statusKey === 'downloading') speed.textContent = 'Paused';
  else if (statusKey === 'downloading') speed.textContent = fmtSpeed(s.speed);
  else speed.textContent = '—';
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

/* ---- resizable download columns ---- */
function loadColumnWidths() {
  const widths = Object.fromEntries(
    Object.entries(COLUMN_DEFINITIONS).map(([key, definition]) => [key, definition.width]),
  );
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) || '{}');
    for (const [key, definition] of Object.entries(COLUMN_DEFINITIONS)) {
      const width = Number(saved[key]);
      if (Number.isFinite(width)) widths[key] = Math.max(definition.min, Math.round(width));
    }
  } catch (_) {
    /* Default widths remain available when preference storage is unavailable. */
  }
  return widths;
}

const columnWidths = loadColumnWidths();

function applyColumnWidths({ persist = false } = {}) {
  let total = 0;
  for (const [key, definition] of Object.entries(COLUMN_DEFINITIONS)) {
    columnWidths[key] = Math.max(definition.min, Math.round(columnWidths[key]));
    document.documentElement.style.setProperty(`--column-${key}-width`, `${columnWidths[key]}px`);
    const handle = elements.downloadTable.querySelector(`th[data-column="${key}"] .column-resizer`);
    if (handle) handle.setAttribute('aria-valuenow', String(columnWidths[key]));
    total += columnWidths[key];
  }
  document.documentElement.style.setProperty('--download-table-width', `${total}px`);
  if (persist) {
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columnWidths));
    } catch (_) {
      /* The current resize still works if preference storage is unavailable. */
    }
  }
}

function installColumnResizers() {
  for (const header of elements.downloadTable.querySelectorAll('th[data-column]')) {
    const key = header.dataset.column;
    const handle = document.createElement('span');
    handle.className = 'column-resizer';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${header.textContent.trim()} column`);
    handle.setAttribute('aria-valuemin', String(COLUMN_DEFINITIONS[key].min));
    handle.title = 'Drag or use arrow keys to resize';
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, width: columnWidths[key] };
      handle.classList.add('is-dragging');
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      columnWidths[key] = Math.max(COLUMN_DEFINITIONS[key].min, drag.width + event.clientX - drag.x);
      applyColumnWidths();
    });
    const finish = (event) => {
      if (!drag) return;
      drag = null;
      handle.classList.remove('is-dragging');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      applyColumnWidths({ persist: true });
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const delta = event.key === 'ArrowLeft' ? -8 : 8;
      columnWidths[key] = Math.max(COLUMN_DEFINITIONS[key].min, columnWidths[key] + delta);
      applyColumnWidths({ persist: true });
      event.preventDefault();
    });
    handle.addEventListener('dblclick', () => {
      columnWidths[key] = COLUMN_DEFINITIONS[key].width;
      applyColumnWidths({ persist: true });
    });
    header.append(handle);
  }
  applyColumnWidths();
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
  return window.BiliAccountStatus.label(
    state.accountStatus,
    state.accountUsername,
    state.accountMessage,
  );
}

function renderAccount() {
  const checking = state.accountStatus === 'checking';
  elements.checkAccountButton.disabled = checking || !state.cookiesFile;
  elements.checkAccountButton.setAttribute('aria-busy', String(checking));
  setButtonLabel(elements.checkAccountButton, checking ? 'none' : 'check', checking ? 'Checking…' : 'Check Account');
}

/* ---- renderer persistence and backend hydration ---- */
function persistUIState() {
  try {
    localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify({
      items: state.items,
      rowState: [...state.rowState.entries()],
      page: state.page,
      pageSize: state.pageSize,
      linksFile: state.linksFile,
      outputDir: state.outputDir,
      cookiesFile: state.cookiesFile,
      phase: state.phase,
      paused: state.paused,
      cancelRequested: state.cancelRequested,
      activeRow: state.activeRow,
      activeFraction: state.activeFraction,
      eta: state.eta,
      accountStatus: state.accountStatus,
      accountUsername: state.accountUsername,
      accountMessage: state.accountMessage,
      logs: state.logs.slice(-MAX_LOG_ROWS),
      revision: state.revision,
    }));
  } catch (_) {
    /* Backend hydration remains authoritative when local storage is unavailable. */
  }
}

function restoreCachedUI() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    state.items = Array.isArray(saved.items) ? saved.items : [];
    state.rowState = new Map(Array.isArray(saved.rowState) ? saved.rowState : []);
    state.page = Math.max(1, Number(saved.page) || 1);
    state.pageSize = saved.pageSize === AUTO_PAGE_SIZE
      ? AUTO_PAGE_SIZE : (Number(saved.pageSize) || AUTO_PAGE_SIZE);
    state.linksFile = saved.linksFile || '';
    state.outputDir = saved.outputDir || '';
    state.cookiesFile = saved.cookiesFile || '';
    // A cached busy flag is never authoritative after a full application restart.
    state.phase = 'idle';
    state.paused = false;
    state.cancelRequested = false;
    state.activeRow = null;
    state.activeFraction = 0;
    state.eta = saved.eta || '';
    state.accountStatus = saved.accountStatus || 'none';
    state.accountUsername = saved.accountUsername || '';
    state.accountMessage = saved.accountMessage || '';
    state.logs = Array.isArray(saved.logs) ? saved.logs.slice(-MAX_LOG_ROWS) : [];
    state.revision = 0;
  } catch (_) {
    /* Ignore invalid or inaccessible cached UI state. */
  }
}

function renderSelectedPaths() {
  const values = [
    [elements.linksPath, state.linksFile, 'Choose a file'],
    [elements.outputPath, state.outputDir, 'Choose an output folder'],
    [elements.cookiesPath, state.cookiesFile, 'Choose a file'],
  ];
  for (const [element, value, fallback] of values) {
    element.textContent = value || fallback;
    element.classList.toggle('is-set', Boolean(value));
  }
}

function mergeLogs(backendLogs) {
  const combined = [...state.logs, ...(Array.isArray(backendLogs) ? backendLogs : [])];
  const seen = new Set();
  state.logs = combined.filter((entry) => {
    const key = `${entry.timestamp}|${entry.level}|${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).slice(-MAX_LOG_ROWS);
}

function applyBackendSnapshot(response) {
  const snapshot = response?.snapshot;
  if (!snapshot || Number(snapshot.revision) <= 0) return 0;
  state.revision = Number(snapshot.revision) || 0;
  const input = snapshot.input || {};
  const hasDownloadState = snapshot.phase !== 'idle'
    || (Array.isArray(snapshot.items) && snapshot.items.length > 0)
    || Boolean(input.links_file || input.output_dir || input.cookies_file);
  if (hasDownloadState) {
    state.phase = snapshot.phase || 'idle';
    state.paused = Boolean(snapshot.paused);
    state.cancelRequested = Boolean(snapshot.cancelRequested);
    state.items = Array.isArray(snapshot.items) ? snapshot.items : [];
    state.rowState = new Map(Object.entries(snapshot.rowStates || {}).map(([row, value]) => {
      const next = { ...value };
      if (!next.detail && next.status === 'Downloading') {
        next.detail = `${fmtBytes(next.received)} / ${fmtBytes(next.total)}`;
      }
      return [Number(row), next];
    }));
    state.activeRow = snapshot.activeRow;
    state.activeFraction = Number(snapshot.activeFraction) || 0;
    state.eta = snapshot.eta || '';
    state.linksFile = input.links_file || state.linksFile;
    state.outputDir = input.output_dir || state.outputDir;
    state.cookiesFile = input.cookies_file || state.cookiesFile;
  }
  state.accountStatus = snapshot.account?.status || state.accountStatus;
  state.accountUsername = snapshot.account?.username || '';
  state.accountMessage = snapshot.account?.message || '';
  state.settings = snapshot.settings || {};
  mergeLogs(snapshot.logs);
  return state.revision;
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
  elements.pauseButton.disabled = state.phase !== 'downloading' || state.cancelRequested;
  elements.cancelButton.disabled = state.phase !== 'downloading' || state.cancelRequested;
}

function render() {
  renderRows();
  renderPagination();
  renderEmptyState();
  updateOverall();
  refreshControls();
  renderPauseButton();
  renderAccount();
  persistUIState();
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
  state.rowState.set(row, { status: 'Queued', detail: '', speed: 0 });
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
    state.rowState.set(row, { status: 'Downloading', detail, speed: Number(event.speed) || 0 });
    state.eta = event.eta || '';
  } else if (event.status === 'finished') {
    state.activeFraction = 1;
    state.eta = '';
    state.rowState.set(row, { status: 'Processing', detail: 'Processing…', speed: 0 });
  }
  renderRow(row);
  updateOverall();
}

function logRow(row, status, detail, timestamp = Date.now()) {
  const total = state.items.length;
  const item = state.items.find((it) => it.row === row) || null;
  const title = item ? item.title : '';
  const prefix = `[${row + 1}/${total}]`;
  const key = (status || '').toLowerCase();
  if (key === 'downloading') {
    appendLog('INFO', `${prefix} Start: ${title}`, { timestamp });
  } else if (key === 'done' || key === 'completed') {
    appendLog('SUCCESS', `${prefix} Completed: ${title}`, { timestamp });
  } else if (key === 'failed') {
    appendLog('ERROR', `${prefix} Error: ${detail} - ${item ? item.url : ''}`, { timestamp });
  }
}

function onRowUpdate(event) {
  const row = event.row;
  state.rowState.set(row, { status: event.status, detail: event.detail || '', speed: 0 });
  if (row === state.activeRow && ['Done', 'Completed', 'Failed', 'Cancelled'].includes(event.status)) {
    state.activeRow = null;
    state.activeFraction = 0;
  }
  logRow(row, event.status, event.detail, event.snapshotTimestamp || Date.now());
  renderRow(row);
  updateOverall();
}

function applyBackendEvent(event) {
  if (Number.isFinite(Number(event.revision))) {
    if (Number(event.revision) <= state.revision) return;
    state.revision = Number(event.revision);
  }
  switch (event.type) {
    case 'log':
      appendLog(event.level || 'INFO', event.message, { timestamp: event.snapshotTimestamp || Date.now() });
      break;
    case 'account':
      state.accountStatus = window.BiliAccountStatus.normalize(event.status);
      state.accountUsername = event.username || '';
      state.accountMessage = event.message || '';
      const accountLevel = window.BiliAccountStatus.logLevel(state.accountStatus);
      appendLog(
        accountLevel,
        `[${accountLevel}] ${state.accountMessage || accountStatusLabel()}`,
        { timestamp: event.snapshotTimestamp || Date.now() },
      );
      renderAccount();
      break;
    case 'settings':
      state.settings = event.settings || {};
      break;
    case 'settings_saved':
      appendLog('INFO', 'Settings saved.');
      break;
    case 'analyze_progress':
      appendLog('INFO', `Resolving ${event.index}/${event.total}: ${event.url}`, {
        timestamp: event.snapshotTimestamp || Date.now(),
      });
      break;
    case 'analyze_done':
      state.items = event.items || [];
      state.rowState = new Map(state.items.map((it) => [it.row, { status: 'Queued', detail: '', speed: 0 }]));
      state.page = 1;
      state.activeRow = null;
      state.activeFraction = 0;
      state.eta = '';
      updateOverall();
      state.phase = 'downloading';
      render();
      break;
    case 'analyze_failed':
      appendLog('ERROR', event.message, { timestamp: event.snapshotTimestamp || Date.now() });
      state.phase = 'idle';
      state.eta = '';
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
      state.eta = '';
      render();
      appendLog('INFO', state.cancelRequested ? 'Download cancelled.' : 'All downloads finished.', {
        timestamp: event.snapshotTimestamp || Date.now(),
      });
      state.cancelRequested = false;
      break;
    case 'process_exit':
      if (state.accountStatus === 'checking') {
        state.accountStatus = 'unknown';
        state.accountMessage = 'Unable to verify account because the backend process stopped.';
        appendLog('ERROR', `[ERROR] ${state.accountMessage}`);
        renderAccount();
      } else {
        appendLog('ERROR', 'Backend process exited unexpectedly.');
      }
      state.phase = 'idle';
      state.eta = '';
      refreshControls();
      break;
    default:
      break;
  }
  persistUIState();
}

let snapshotPending = true;
const pendingBackendEvents = [];

function handleBackendEvent(event) {
  if (snapshotPending) {
    pendingBackendEvents.push(event);
    return;
  }
  applyBackendEvent(event);
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
  state.eta = '';
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

elements.checkAccountButton.addEventListener('click', async () => {
  if (!state.cookiesFile || state.accountStatus === 'checking') return;
  state.accountStatus = 'checking';
  state.accountUsername = '';
  state.accountMessage = '';
  appendLog('INFO', '[ACCOUNT] Checking Bilibili account...');
  renderAccount();
  try {
    await window.desktopAPI.checkAccount(state.cookiesFile);
  } catch (error) {
    state.accountStatus = 'unknown';
    state.accountMessage = error?.message || 'Unable to start account verification.';
    appendLog('ERROR', `[ERROR] ${state.accountMessage}`);
    renderAccount();
  }
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
  state.logs = [];
  elements.log.replaceChildren();
  appendLog('INFO', 'Log cleared');
});

elements.themeToggle.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { persist: true });
});

/* ---- init ---- */
let unsubscribeBackend = null;

async function initialize() {
  unsubscribeBackend = window.desktopAPI.onBackendEvent(handleBackendEvent);
  restoreCachedUI();
  renderSelectedPaths();
  renderLogs();
  applyTheme(currentTheme());
  applySideRatio();
  installColumnResizers();
  render();
  updateAutoPageSize();

  try {
    if (typeof window.desktopAPI.getState === 'function') {
      const response = await window.desktopAPI.getState();
      applyBackendSnapshot(response);
      renderSelectedPaths();
      renderLogs();
      render();
    }
  } catch (error) {
    appendLog('WARN', `Unable to restore current download state: ${error.message}`);
  } finally {
    snapshotPending = false;
    const queued = pendingBackendEvents.splice(0);
    for (const event of queued) applyBackendEvent(event);
  }
  window.desktopAPI.getSettings();
}

void initialize();

const tableResizeObserver = new ResizeObserver(updateAutoPageSize);
tableResizeObserver.observe(elements.tableScroll);

window.addEventListener('pagehide', () => {
  unsubscribeBackend?.();
  unsubscribeBackend = null;
  tableResizeObserver.disconnect();
}, { once: true });
