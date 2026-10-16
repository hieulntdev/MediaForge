'use strict';

const api = window.hongguoAPI;
const AUTO_PAGE_SIZE = 'auto';
const STATUS_FILTER_LABELS = Object.freeze({
  all: 'All', ready: 'Ready', analyzing: 'Analyzing', queued: 'Queued',
  downloading: 'Downloading', paused: 'Paused', completed: 'Completed',
  failed: 'Failed', cancelled: 'Cancelled',
});

const state = {
  snapshot: null,
  rows: new Map(),
  sort: { key: 'number', direction: 1 },
  selected: new Set(),
  active: false,
  view: 'queue',
  logKey: '',
  statusFilter: 'all',
  page: 1,
  pageSize: AUTO_PAGE_SIZE,
  autoPageSize: 1,
};

const elements = Object.fromEntries([
  'urls', 'analyze', 'add-queue', 'output', 'output-path', 'quality', 'concurrency', 'duplicates',
  'select-all', 'deselect-all', 'range', 'apply-range', 'summary', 'start', 'pause', 'cancel', 'retry', 'remove',
  'clear-queue', 'overall-progress', 'overall-label', 'phase', 'header-check', 'episodes-title', 'episodes-body',
  'empty', 'status-filter', 'page-size-select', 'pagination', 'goto-input', 'page-total', 'clear-log', 'log',
].map((id) => [id.replace(/-([a-z])/g, (_match, value) => value.toUpperCase()), document.querySelector(`#${id}`)]));
elements.tableScroll = document.querySelector('.table-scroll');

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** power)).toFixed(power ? 1 : 0)} ${units[power]}`;
}

function formatSpeed(value) {
  return Number(value) > 0 ? `${formatBytes(value)}/s` : '—';
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function currentItems() {
  return state.view === 'discovered' ? (state.snapshot?.discovered || []) : (state.snapshot?.jobs || []);
}

function rowData(item) {
  return item.episode ? { ...item.episode, ...item, id: item.id, selected: item.selected } : item;
}

function selectedIds() {
  return currentItems().filter((item) => state.selected.has(rowData(item).id)).map((item) => rowData(item).id);
}

function normalizedStatus(item) {
  return String(rowData(item).status || 'Ready').toLowerCase();
}

function compareRows(a, b) {
  const key = state.sort.key;
  const aData = rowData(a);
  const bData = rowData(b);
  const numeric = ['size', 'progress', 'speed', 'number'].includes(key);
  const left = numeric ? Number(aData[key] ?? 0) : String(aData[key] ?? '').toLowerCase();
  const right = numeric ? Number(bData[key] ?? 0) : String(bData[key] ?? '').toLowerCase();
  return (left < right ? -1 : left > right ? 1 : 0) * state.sort.direction;
}

function filteredAndSortedItems() {
  const filtered = state.statusFilter === 'all'
    ? currentItems()
    : currentItems().filter((item) => normalizedStatus(item) === state.statusFilter);
  return [...filtered].sort(compareRows);
}

function effectivePageSize() {
  return state.pageSize === AUTO_PAGE_SIZE ? Math.max(1, state.autoPageSize) : state.pageSize;
}

function pageCount(items = filteredAndSortedItems()) {
  return Math.max(1, Math.ceil(items.length / effectivePageSize()));
}

function pageItems(items = filteredAndSortedItems()) {
  const start = (state.page - 1) * effectivePageSize();
  return items.slice(start, start + effectivePageSize());
}

function updateRow(item) {
  const data = rowData(item);
  let row = state.rows.get(data.id);
  if (!row) {
    row = document.createElement('tr');
    row.dataset.id = data.id;
    const checkboxCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select episode ${data.number}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(data.id);
      else state.selected.delete(data.id);
      updateSummary();
    });
    checkboxCell.append(checkbox);
    row.append(checkboxCell, ...Array.from({ length: 8 }, () => document.createElement('td')));
    state.rows.set(data.id, row);
  }
  const values = [
    String(data.number).padStart(3, '0'), data.title || '', data.resolution || '—',
    formatBytes(data.size), `${Math.round(Number(data.progress || 0))}%`, formatSpeed(data.speed),
    data.eta || '—', data.status || 'Ready',
  ];
  values.forEach((value, index) => {
    const target = row.children[index + 1];
    target.textContent = value;
    target.title = data.detail || value;
  });
  row.children[8].className = 'row-status';
  row.children[8].dataset.state = normalizedStatus(item);
  row.querySelector('input').checked = state.selected.has(data.id);
  return row;
}

function renderRows(items) {
  state.page = Math.min(Math.max(1, state.page), pageCount(items));
  const visible = pageItems(items);
  const visibleIds = new Set(visible.map((item) => rowData(item).id));
  for (const [id, row] of state.rows) {
    if (!visibleIds.has(id)) {
      row.remove();
      state.rows.delete(id);
    }
  }
  const fragment = document.createDocumentFragment();
  visible.forEach((item) => fragment.append(updateRow(item)));
  elements.episodesBody.replaceChildren(fragment);

  const sourceCount = currentItems().length;
  elements.episodesTitle.textContent = state.statusFilter === 'all'
    ? `Episode List & Queue (${sourceCount} total)`
    : `Episode List & Queue (${items.length} of ${sourceCount})`;
  if (sourceCount === 0) {
    elements.empty.textContent = 'Paste one or more Hongguo URLs and select Analyze.';
    elements.empty.hidden = false;
  } else if (items.length === 0) {
    elements.empty.textContent = `No episodes with Status "${STATUS_FILTER_LABELS[state.statusFilter]}".`;
    elements.empty.hidden = false;
  } else {
    elements.empty.hidden = true;
  }
}

function pageButton(label, target, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `page-btn${options.active ? ' active' : ''}`;
  button.textContent = label;
  button.disabled = Boolean(options.disabled);
  button.setAttribute('aria-label', options.ariaLabel || `Page ${label}`);
  if (options.active) button.setAttribute('aria-current', 'page');
  button.addEventListener('click', () => { state.page = target; renderView(); });
  return button;
}

function pageEllipsis() {
  const span = document.createElement('span');
  span.className = 'page-ellipsis';
  span.textContent = '…';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function renderPagination(items) {
  const count = pageCount(items);
  state.page = Math.min(Math.max(1, state.page), count);
  elements.pagination.replaceChildren();
  elements.pagination.append(
    pageButton('«', 1, { disabled: state.page === 1, ariaLabel: 'First page' }),
    pageButton('‹', Math.max(1, state.page - 1), { disabled: state.page === 1, ariaLabel: 'Previous page' }),
  );
  const first = Math.max(1, Math.min(state.page - 2, count - 4));
  const last = Math.min(count, first + 4);
  if (first > 1) {
    elements.pagination.append(pageButton('1', 1));
    if (first > 2) elements.pagination.append(pageEllipsis());
  }
  for (let page = first; page <= last; page += 1) {
    elements.pagination.append(pageButton(String(page), page, { active: page === state.page }));
  }
  if (last < count) {
    if (last < count - 1) elements.pagination.append(pageEllipsis());
    elements.pagination.append(pageButton(String(count), count));
  }
  elements.pagination.append(
    pageButton('›', Math.min(count, state.page + 1), { disabled: state.page === count, ariaLabel: 'Next page' }),
    pageButton('»', count, { disabled: state.page === count, ariaLabel: 'Last page' }),
  );
  elements.pageSizeSelect.value = String(state.pageSize);
  elements.gotoInput.max = String(count);
  elements.gotoInput.value = String(state.page);
  elements.pageTotal.textContent = `/ ${count}`;
}

function updateSummary() {
  const items = currentItems();
  const selected = selectedIds().length;
  elements.summary.textContent = items.length ? `${selected} of ${items.length} selected` : 'No episodes analyzed.';
  const visible = pageItems(filteredAndSortedItems());
  const selectedVisible = visible.filter((item) => state.selected.has(rowData(item).id)).length;
  elements.headerCheck.checked = visible.length > 0 && selectedVisible === visible.length;
  elements.headerCheck.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  const jobs = state.snapshot?.jobs || [];
  const completed = jobs.filter((job) => job.status === 'Completed').length;
  const aggregate = jobs.length
    ? jobs.reduce((total, job) => total + Number(job.progress || 0), 0) / jobs.length
    : 0;
  elements.overallProgress.value = aggregate;
  elements.overallLabel.textContent = `${completed} / ${jobs.length} (${Math.round(aggregate)}%)`;
  const failed = jobs.some((job) => job.status === 'Failed');
  elements.addQueue.disabled = !(state.snapshot?.discovered || [])
    .some((episode) => state.selected.has(episode.id) && episode.status === 'Ready') || state.active;
  elements.start.disabled = !jobs.some((job) => state.selected.has(job.id)
    && ['Queued', 'Ready', 'Paused', 'Failed', 'Cancelled'].includes(job.status)) || state.active;
  elements.pause.disabled = !state.active || state.snapshot?.phase !== 'downloading';
  elements.pause.textContent = state.snapshot?.paused ? 'Resume' : 'Pause';
  elements.cancel.disabled = !state.active;
  elements.retry.disabled = !failed || state.active;
  elements.remove.disabled = !jobs.some((job) => job.status === 'Completed') || state.active;
  elements.clearQueue.disabled = !jobs.length || state.active;
}

function renderView() {
  const items = filteredAndSortedItems();
  renderRows(items);
  renderPagination(items);
  updateSummary();
}

function currentRowHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--height-table-row');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 36;
}

function updateAutoPageSize() {
  if (state.pageSize !== AUTO_PAGE_SIZE) return;
  const header = elements.tableScroll.querySelector('thead');
  const available = elements.tableScroll.clientHeight - (header?.offsetHeight || currentRowHeight());
  const next = Math.max(1, Math.floor(available / currentRowHeight()));
  if (next === state.autoPageSize) return;
  state.autoPageSize = next;
  renderView();
}

function renderLog() {
  const logs = state.snapshot?.logs || [];
  const last = logs.at(-1);
  const key = `${logs.length}:${last?.timestamp || ''}:${last?.message || ''}`;
  if (key === state.logKey) return;
  state.logKey = key;
  if (!logs.length) {
    const empty = document.createElement('p');
    empty.className = 'log-empty';
    empty.textContent = 'No activity yet.';
    elements.log.replaceChildren(empty);
    return;
  }
  const nearBottom = elements.log.scrollHeight - elements.log.scrollTop - elements.log.clientHeight < 32;
  const fragment = document.createDocumentFragment();
  logs.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.dataset.level = String(entry.level).toLowerCase();
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatTime(entry.timestamp);
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message;
    row.append(time, message);
    fragment.append(row);
  });
  elements.log.replaceChildren(fragment);
  if (nearBottom) elements.log.scrollTop = elements.log.scrollHeight;
}

function applySnapshot(snapshot, _changedJob = null, eventType = '') {
  if (!snapshot) return;
  state.snapshot = snapshot;
  const previousView = state.view;
  if (eventType === 'analysis_done' || (eventType === '' && !snapshot.jobs?.length)) state.view = 'discovered';
  else if (['queue', 'job', 'progress', 'queue_done', 'pause', 'resume'].includes(eventType)) state.view = 'queue';
  if (previousView !== state.view || eventType === '') {
    state.page = 1;
    state.selected = new Set(currentItems()
      .filter((item) => rowData(item).selected === true)
      .map((item) => rowData(item).id));
  }
  state.active = ['analyzing', 'downloading'].includes(snapshot.phase);
  elements.phase.textContent = snapshot.paused ? 'Paused'
    : snapshot.phase === 'analyzing' ? 'Analyzing'
      : snapshot.phase === 'downloading' ? 'Downloading' : 'Idle';
  elements.outputPath.textContent = snapshot.settings.outputDir || 'Choose an output folder';
  elements.outputPath.title = snapshot.settings.outputDir || '';
  elements.quality.value = snapshot.settings.quality;
  elements.concurrency.value = String(snapshot.settings.concurrentDownloads);
  elements.duplicates.value = snapshot.settings.duplicateHandling;
  renderView();
  renderLog();
  elements.analyze.disabled = state.active;
}

function parseRange(value, maximum) {
  if (!value.trim()) throw new Error('Enter an episode range.');
  const values = new Set();
  for (const part of value.split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`Invalid range: ${part.trim()}`);
    const start = Number(match[1]);
    const end = Number(match[2] || start);
    if (start < 1 || end < start || end > maximum) throw new Error(`Range must be between 1 and ${maximum}.`);
    for (let number = start; number <= end; number += 1) values.add(number);
  }
  return values;
}

async function saveSettings() {
  return api.saveSettings({
    outputDir: state.snapshot.settings.outputDir,
    quality: elements.quality.value,
    concurrentDownloads: Number(elements.concurrency.value),
    duplicateHandling: elements.duplicates.value,
  });
}

async function invoke(operation) {
  try {
    await operation();
  } catch (error) {
    window.alert(error.message);
  }
}

elements.analyze.addEventListener('click', () => invoke(() => api.analyze(elements.urls.value)));
elements.addQueue.addEventListener('click', () => invoke(() => api.addToQueue(selectedIds())));
elements.output.addEventListener('click', () => invoke(async () => {
  const selected = await api.selectOutput(state.snapshot.settings.outputDir);
  if (selected) {
    state.snapshot.settings.outputDir = selected;
    await saveSettings();
  }
}));
for (const control of [elements.quality, elements.concurrency, elements.duplicates]) {
  control.addEventListener('change', () => invoke(saveSettings));
}
elements.selectAll.addEventListener('click', () => {
  currentItems().forEach((item) => state.selected.add(rowData(item).id));
  renderView();
});
elements.deselectAll.addEventListener('click', () => {
  state.selected.clear();
  renderView();
});
elements.headerCheck.addEventListener('change', () => {
  pageItems(filteredAndSortedItems()).forEach((item) => {
    const id = rowData(item).id;
    if (elements.headerCheck.checked) state.selected.add(id);
    else state.selected.delete(id);
  });
  renderView();
});
elements.applyRange.addEventListener('click', () => invoke(async () => {
  const items = currentItems();
  const maximum = Math.max(...items.map((item) => Number(rowData(item).number)), 0);
  const numbers = parseRange(elements.range.value, maximum);
  state.selected.clear();
  items.forEach((item) => {
    const data = rowData(item);
    if (numbers.has(Number(data.number))) state.selected.add(data.id);
  });
  renderView();
}));
elements.start.addEventListener('click', () => invoke(async () => {
  if (elements.duplicates.value === 'replace'
    && !window.confirm('Replace existing files with the same name? This cannot be undone.')) return;
  await saveSettings();
  await api.start(selectedIds());
}));
elements.pause.addEventListener('click', () => invoke(() => state.snapshot.paused ? api.resume() : api.pause()));
elements.cancel.addEventListener('click', () => invoke(api.cancel));
elements.retry.addEventListener('click', () => invoke(api.retryFailed));
elements.remove.addEventListener('click', () => invoke(api.removeCompleted));
elements.clearQueue.addEventListener('click', () => invoke(api.clearQueue));
elements.clearLog.addEventListener('click', () => invoke(api.clearLog));

elements.statusFilter.addEventListener('change', () => {
  state.statusFilter = elements.statusFilter.value;
  state.page = 1;
  renderView();
});

elements.pageSizeSelect.addEventListener('change', () => {
  state.pageSize = elements.pageSizeSelect.value === AUTO_PAGE_SIZE
    ? AUTO_PAGE_SIZE : Number(elements.pageSizeSelect.value);
  state.page = 1;
  renderView();
  updateAutoPageSize();
});

function commitGotoPage() {
  const count = pageCount();
  const requested = Number.parseInt(elements.gotoInput.value, 10);
  state.page = Number.isFinite(requested) ? Math.min(Math.max(1, requested), count) : state.page;
  renderView();
}

function sanitizeGotoPageInput() {
  if (elements.gotoInput.value && !/^\d+$/.test(elements.gotoInput.value)) {
    elements.gotoInput.value = '';
  }
}

function preventInvalidGotoInsertion(event) {
  const insertedText = event.data
    ?? event.clipboardData?.getData('text')
    ?? event.dataTransfer?.getData('text')
    ?? '';
  if (/\D/.test(insertedText)) event.preventDefault();
}

elements.gotoInput.addEventListener('beforeinput', preventInvalidGotoInsertion);
elements.gotoInput.addEventListener('paste', preventInvalidGotoInsertion);
elements.gotoInput.addEventListener('drop', preventInvalidGotoInsertion);
elements.gotoInput.addEventListener('input', sanitizeGotoPageInput);
elements.gotoInput.addEventListener('change', commitGotoPage);
elements.gotoInput.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey && !event.altKey
      && ['e', 'E', '+', '-', '.', ','].includes(event.key)) {
    event.preventDefault();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    commitGotoPage();
  }
});

function changeSort(header) {
  const key = header.dataset.sort;
  if (state.sort.key === key) state.sort.direction *= -1;
  else state.sort = { key, direction: 1 };
  state.page = 1;
  for (const candidate of document.querySelectorAll('th[data-sort]')) {
    candidate.setAttribute('aria-sort', candidate === header
      ? (state.sort.direction === 1 ? 'ascending' : 'descending') : 'none');
  }
  renderView();
}

for (const header of document.querySelectorAll('th[data-sort]')) {
  header.tabIndex = 0;
  header.setAttribute('aria-sort', header.dataset.sort === state.sort.key ? 'ascending' : 'none');
  header.addEventListener('click', () => changeSort(header));
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      changeSort(header);
    }
  });
}

api.onEvent((event) => applySnapshot(event.snapshot, event.job || event.episode, event.type));
invoke(async () => {
  const result = await api.getState();
  applySnapshot(result.snapshot);
  updateAutoPageSize();
});

if (typeof ResizeObserver === 'function' && elements.tableScroll) {
  new ResizeObserver(updateAutoPageSize).observe(elements.tableScroll);
}
