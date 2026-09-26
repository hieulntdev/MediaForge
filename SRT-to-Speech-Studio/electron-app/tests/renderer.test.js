'use strict';

/**
 * Renderer behaviour tests (status column, filtering, manual retry, log).
 *
 * The app has no bundler and no DOM test dependency, so the renderer is loaded
 * into a `vm` context with a small DOM stub. `renderer.js` itself is untouched:
 * a test-only epilogue is appended so the module-scope bindings are reachable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const RENDERER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'renderer.js'), 'utf8'
);
const THEME_INIT_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'theme-init.js'), 'utf8'
);

const EPILOGUE = `
globalThis.__renderer = {
  state, elements, render, visibleCues, cuesFor, applyStatus,
  handleBackendEvent, retryCue, parseSrt, runSynthesis, rowFor, formatElapsed, formatSpeed,
  localStorage, computeAutoRowCount, handleTableContainerResize, applyTheme, initTheme
};
`;

const THREAD_VALUES = ['2', '3', '4', '5', '6'];

const SRT = [
  '1', '00:00:00,000 --> 00:00:02,000', 'First line',
  '', '2', '00:00:02,000 --> 00:00:04,000', 'Second line',
  '', '3', '00:00:04,000 --> 00:00:06,000', 'Third line'
].join('\n');

function classListOf(element) {
  const names = () => element.className.split(/\s+/).filter(Boolean);
  const write = (list) => { element.className = list.join(' '); };
  return {
    add: (...values) => {
      const list = names();
      for (const value of values) if (!list.includes(value)) list.push(value);
      write(list);
    },
    remove: (...values) => write(names().filter((name) => !values.includes(name))),
    contains: (value) => names().includes(value),
    toggle: (value) => {
      const has = names().includes(value);
      if (has) write(names().filter((name) => name !== value));
      else write([...names(), value]);
      return !has;
    }
  };
}

function createElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(), children: [], parent: null,
    listeners: {}, attributes: {},
    className: '', textContent: '', innerHTML: '', title: '', type: '',
    value: '', disabled: false, hidden: false, scrollTop: 0, scrollHeight: 0,
    clientHeight: 0, offsetHeight: 0,
    dataset: {}, options: [], style: {},
    append(...nodes) {
      for (const node of nodes) {
        if (node && typeof node === 'object') {
          node.parent = element;
          element.children.push(node);
        }
      }
    },
    replaceChildren(...nodes) { element.children = []; element.append(...nodes); },
    remove() {
      if (element.parent) {
        element.parent.children = element.parent.children.filter((item) => item !== element);
        element.parent = null;
      }
    },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute: (name) => element.attributes[name],
    addEventListener(type, handler) { (element.listeners[type] ||= []).push(handler); },
    dispatch(type, event = {}) {
      const evt = { preventDefault() {}, stopPropagation() {}, clientX: 0, key: '', ...event };
      for (const handler of element.listeners[type] || []) handler(evt);
    },
    getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0, right: 900, bottom: 600 }),
    querySelectorAll: () => [],
    contains: () => false,
    get childElementCount() { return element.children.length; },
    get firstElementChild() { return element.children[0]; }
  };
  element.classList = classListOf(element);
  return element;
}

function boot(initialStorage = {}) {
  const registry = new Map();
  const calls = { retrySegment: [], startSynthesis: [], previewAudio: [], saveProject: [], validateContent: [] };
  const played = [];
  const storage = new Map(Object.entries(initialStorage));
  const pending = [];
  const confirmCalls = [];
  let confirmAnswer = true;

  const document = {
    documentElement: createElement('html'),
    createElement,
    querySelector(selector) {
      if (!registry.has(selector)) registry.set(selector, createElement('div'));
      return registry.get(selector);
    },
    addEventListener() {}
  };
  const threads = document.querySelector('#threads-select');
  threads.options = THREAD_VALUES.map((value) => ({ value }));
  threads.value = '4';
  document.querySelector('#validate-checkbox').checked = false;
  document.querySelector('#status-filter').value = 'all';
  document.querySelector('#page-size-select').value = 'auto';
  document.querySelector('#goto-page-input').value = '1';

  const desktopAPI = {
    openSrt: async () => ({ path: '/tmp/sample.srt', content: SRT }),
    openVoice: async () => '/tmp/voice.mp3',
    selectOutput: async () => '/tmp/out',
    startSynthesis: async (job) => {
      calls.startSynthesis.push(job);
      return { destination: '/tmp/out/sample.zsp' };
    },
    retrySegment(job) {
      calls.retrySegment.push(job);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    cancelSynthesis: async () => {},
    previewAudio(filename) {
      calls.previewAudio.push(filename);
      return Promise.resolve(`file:///cache/${filename}`);
    },
    onBackendEvent(handler) { document.handler = handler; },
    saveProject(job) {
      calls.saveProject.push(job);
      return Promise.resolve({});
    },
    validateContent(job) {
      calls.validateContent.push(job);
      return Promise.resolve({});
    }
  };

  class Audio {
    constructor(url) { this.url = url; }
    async play() { played.push(this.url); }
    pause() {}
  }

  const sandbox = {
    document, window: { desktopAPI, addEventListener() {}, confirm: (message) => { confirmCalls.push(message); return confirmAnswer; } }, Audio,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(RENDERER_SOURCE + EPILOGUE, context, { filename: 'renderer.js' });

  const api = context.__renderer;
  return {
    api, calls, played, registry, pending, confirmCalls, document,
    setConfirmAnswer(value) { confirmAnswer = value; },
    emit(event) { api.handleBackendEvent(event); },
    async flush() {
      for (let tick = 0; tick < 4; tick += 1) await new Promise(setImmediate);
    },
    async loadSrt() {
      api.elements.subtitleInput.dispatch('click');
      await this.flush();
    },
    setFilter(value) {
      api.elements.statusFilter.value = value;
      api.elements.statusFilter.dispatch('change');
    },
    rows() { return api.elements.rows.children; },
    statusOf(row) { return row.children[4].dataset.status; },
    retryButtonOf(row) { return row.children[5].children[0].children[1]; },
    playButtonOf(row) { return row.children[5].children[0].children[0]; },
    logs() {
      return api.elements.log.children.map((row) => row.children[1].textContent);
    }
  };
}

function successEvent(index, position, audioFilename) {
  return {
    type: 'segment_result', index, position, status: 'success', attempts: 1,
    start: position * 2, end: position * 2 + 2,
    timeline_duration: 2, wav_duration: 1.5, overflow: -0.5, audio_filename: audioFilename
  };
}

function contentFailEvent(index, position, reason = 'CONTENT_WRONG') {
  return {
    type: 'segment_result', index, position, status: 'fail', reason,
    attempts: 3, message: `content validation failed: ${reason}`, audio_filename: '',
    start: position * 2, end: position * 2 + 2,
  };
}

function asrResultEvent(index, position, contentStatus, similarity = 0.4) {
  return {
    type: 'segment_asr_result', index, position,
    content_status: contentStatus, similarity, wer: 1 - similarity,
  };
}

test('theme bootstrap applies the saved preference before the renderer loads', () => {
  const document = { documentElement: createElement('html') };
  const localStorage = { getItem: (key) => key === 'srtts:theme' ? 'dark' : null };

  vm.runInNewContext(THEME_INIT_SOURCE, { document, localStorage });

  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('theme defaults to light and persists each explicit toggle', () => {
  const app = boot();

  assert.equal(app.document.documentElement.dataset.theme, 'light');
  assert.equal(app.api.elements.themeToggle.getAttribute('aria-label'), 'Switch to dark mode');
  app.api.elements.themeToggle.dispatch('click');
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.api.localStorage.getItem('srtts:theme'), 'dark');
  assert.equal(app.api.elements.themeToggle.getAttribute('aria-label'), 'Switch to light mode');
  assert.equal(app.api.elements.themeToggle.getAttribute('title'), 'Switch to light mode');
  assert.match(app.api.elements.themeToggle.innerHTML, /<circle/);

  app.api.elements.themeToggle.dispatch('click');
  assert.equal(app.document.documentElement.dataset.theme, 'light');
  assert.equal(app.api.localStorage.getItem('srtts:theme'), 'light');
  assert.equal(app.api.elements.themeToggle.getAttribute('aria-label'), 'Switch to dark mode');
  assert.match(app.api.elements.themeToggle.innerHTML, /width="16" height="16" fill="none"/);
  assert.match(app.api.elements.themeToggle.innerHTML, /stroke-width="1\.8"/);
});

test('theme restores a saved dark preference', () => {
  const app = boot({ 'srtts:theme': 'dark' });

  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.api.elements.themeToggle.getAttribute('aria-label'), 'Switch to light mode');
  assert.match(app.api.elements.themeToggle.innerHTML, /<circle/);
});

test('the status filter changes the view only', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(successEvent(2, 1, 'line_2.wav'));
  app.emit(contentFailEvent(3, 2));
  assert.deepEqual([...app.api.state.cues.map((cue) => cue.id)], [1, 2, 3]);

  app.setFilter('fail');
  assert.equal(app.api.state.cues.length, 3, 'filtering must not drop rows from the model');
  assert.deepEqual([...app.api.state.cues.map((cue) => cue.id)], [1, 2, 3]);
  assert.deepEqual([...app.api.state.cues.map((cue) => cue.status)],
    ['success', 'success', 'fail']);
  assert.deepEqual([...app.api.visibleCues().map((cue) => cue.id)], [3]);
  assert.equal(app.rows().length, 1);
  assert.equal(app.rows()[0].children[0].textContent, 3);

  app.setFilter('success');
  assert.deepEqual([...app.api.visibleCues().map((cue) => cue.id)], [1, 2]);
  app.setFilter('all');
  assert.equal(app.api.visibleCues().length, 3);
});

test('filtered rows keep the identity of their subtitle', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(contentFailEvent(3, 2));
  app.setFilter('fail');
  app.rows()[0].children[5].children[0].children[1].dispatch('click');
  await app.flush();
  assert.equal(app.calls.retrySegment.length, 1);
  assert.equal(app.calls.retrySegment[0].position, 2);
  assert.equal(app.calls.retrySegment[0].index, 3);
});

test('the Validate checkbox is off by default and is forwarded to manual retry', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  assert.equal(app.api.elements.validateCheckbox.checked, false, 'unchecked by default');
  app.retryButtonOf(app.rows()[1]).dispatch('click');
  await app.flush();
  assert.equal(app.calls.retrySegment[0].validateContent, false);
});

test('checking Validate is forwarded to manual retry', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  app.api.elements.validateCheckbox.checked = true;
  app.retryButtonOf(app.rows()[1]).dispatch('click');
  await app.flush();
  assert.equal(app.calls.retrySegment[0].validateContent, true);
});

test('retry is offered for every row while idle, but not while a batch runs', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(contentFailEvent(2, 1));
  const [first, second, third] = app.rows();
  assert.equal(app.retryButtonOf(first).disabled, false, 'a successful line is retryable too');
  assert.equal(app.retryButtonOf(second).disabled, false);
  assert.equal(app.retryButtonOf(third).disabled, true, 'a pending line is not retryable');

  app.api.state.busy = true;
  app.api.render();
  assert.equal(app.retryButtonOf(app.rows()[1]).disabled, true, 'no retry while a batch runs');
});

test('retrying a successful row asks for confirmation and proceeds when accepted', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.setConfirmAnswer(true);
  app.retryButtonOf(app.rows()[0]).dispatch('click');
  await app.flush();
  assert.equal(app.confirmCalls.length, 1);
  assert.equal(app.calls.retrySegment.length, 1);
  assert.equal(app.calls.retrySegment[0].index, 1);
});

test('declining the confirmation leaves a successful row untouched', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.setConfirmAnswer(false);
  app.retryButtonOf(app.rows()[0]).dispatch('click');
  await app.flush();
  assert.equal(app.confirmCalls.length, 1);
  assert.equal(app.calls.retrySegment.length, 0, 'declined retry never calls the backend');
  assert.equal(app.api.cuesFor(1)[0].status, 'success', 'status is unchanged');
});

test('retrying a failed row never asks for confirmation', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  app.retryButtonOf(app.rows()[1]).dispatch('click');
  await app.flush();
  assert.equal(app.confirmCalls.length, 0);
  assert.equal(app.calls.retrySegment.length, 1);
});

test('a second Retry click cannot start a second regeneration', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  const button = app.retryButtonOf(app.rows()[1]);
  button.dispatch('click');
  await app.flush();
  assert.equal(app.calls.retrySegment.length, 1);
  // The row is now busy: neither the button nor a direct call may fire again.
  assert.equal(app.retryButtonOf(app.rows()[1]).disabled, true);
  app.api.retryCue(app.api.cuesFor(2)[0]);
  await app.flush();
  assert.equal(app.calls.retrySegment.length, 1);

  app.pending[0].resolve({});
  await app.flush();
  assert.equal(app.calls.retrySegment.length, 1);
  // The row is released once the backend reports the retry process finished.
  app.emit({ type: 'retry_exit', code: 0, signal: null });
  assert.equal(app.api.state.retryingCueId, null);
  assert.equal(app.retryButtonOf(app.rows()[1]).disabled, false,
    'the line is retryable again');
});

test('a retry that ends without a result stays Fail', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  app.retryButtonOf(app.rows()[1]).dispatch('click');
  await app.flush();
  assert.equal(app.api.cuesFor(2)[0].status, 'processing');
  app.emit({ type: 'retry_exit', code: 1, signal: null });
  assert.equal(app.api.cuesFor(2)[0].status, 'fail', 'never left as Processing');
  assert.ok(app.logs().some((line) => line.includes('did not finish')));
  assert.equal(app.retryButtonOf(app.rows()[1]).disabled, false);
});

test('a manual retry failure keeps the line marked Fail', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  app.retryButtonOf(app.rows()[1]).dispatch('click');
  await app.flush();
  app.pending[0].resolve({});
  await app.flush();
  app.emit({
    type: 'segment_result', index: 2, position: 1, status: 'fail', manual: true,
    attempts: 1, message: 'duration validation failed', audio_filename: '',
    start: 2, end: 4, timeline_duration: 2, wav_duration: 9, overflow: 7
  });
  app.emit({ type: 'retry_exit', code: 0, signal: null });
  assert.equal(app.api.cuesFor(2)[0].status, 'fail');
  assert.equal(app.retryButtonOf(app.rows()[1]).disabled, false, 'Retry stays enabled');
  assert.ok(app.logs().some((line) => line.startsWith('Manual Retry Failed')));
});

test('play stays available after a manual retry succeeds', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1));
  assert.equal(app.playButtonOf(app.rows()[1]).disabled, true, 'no audio yet');
  app.retryButtonOf(app.rows()[1]).dispatch('click');
  await app.flush();
  app.pending[0].resolve({});
  await app.flush();
  app.emit(successEvent(2, 1, 'line_2_retry.wav'));
  const button = app.playButtonOf(app.rows()[1]);
  assert.equal(button.disabled, false);
  button.dispatch('click');
  await app.flush();
  assert.deepEqual([...app.calls.previewAudio], ['line_2_retry.wav']);
  assert.equal(app.played.length, 1);
});

test('a rename or delete of the audio file does not break the row', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.api.state.cues[0].audioFilename = undefined;
  app.api.render();
  assert.equal(app.playButtonOf(app.rows()[0]).disabled, true);
  assert.equal(app.rows()[0].children[5].children[0].children[0].textContent, '—');
});

test('auto retries never inflate the completed count', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({ type: 'started', total: 3, workers: 3, processors: 4 });
  app.emit({ type: 'segment_retry', index: 1, position: 0, attempt: 1, max_attempts: 3 });
  app.emit({ type: 'segment_retry', index: 1, position: 0, attempt: 2, max_attempts: 3 });
  assert.equal(app.api.elements.progress.value, 0, 'a retry is not a completed line');
  app.emit({ type: 'progress', completed: 1, total: 3, entry: { index: 1 } });
  assert.equal(Math.round(app.api.elements.progress.value), 33, '1 of 3, not 3 of 3');
  assert.equal(app.api.elements.status.textContent, 'Processing 1/3');
  assert.ok(app.logs().some((line) => line.includes('Auto retry 1/3')));
});

test('the activity log reports the processors actually used', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({ type: 'started', total: 3, workers: 3, processors: 6 });
  assert.ok(app.logs().some((line) => line.includes('Selected processors: 6')));
});

test('stopping the queue marks every unprocessed line as Skipped', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({
    type: 'started', total: 3, workers: 1, processors: 4
  });
  app.emit(contentFailEvent(1, 0));
  app.emit({
    type: 'stopped', index: 1, processed: 1, completed: 0, total: 3,
    skipped: [
      { position: 1, index: 2, start: 2, end: 4 },
      { position: 2, index: 3, start: 4, end: 6 }
    ]
  });
  assert.deepEqual([...app.api.state.cues.map((cue) => cue.status)],
    ['fail', 'skipped', 'skipped']);
  assert.equal(app.rows()[1].children[4].textContent, 'Skipped');
  assert.equal(app.rows()[1].children[5].children[0].children[1].disabled, true,
    'a skipped line has nothing to retry yet');
  const logs = app.logs();
  assert.ok(logs.some((line) => line.includes('failed duration validation after 3 retries')));
  assert.ok(logs.some((line) => line.includes('Skipped: processing stopped after final '
    + 'duration validation failure')));
  assert.ok(logs.some((line) => line.includes('2 subtitle line(s) were not processed')));
});

test('a content failure is logged with the full comparison', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(contentFailEvent(2, 1, 'CONTENT_MISSING'));
  const report = app.logs().find((line) => line.includes('[Content Validation Failed]'));
  assert.ok(report, 'the failure block must reach the log');
  for (const expected of [
    'Subtitle: #2', 'Reason: CONTENT_MISSING',
    'Attempt: 3', 'File: (discarded)', 'Status: Fail'
  ]) {
    assert.ok(report.includes(expected), `missing "${expected}" in:\n${report}`);
  }
});

test('a segment_asr_result event updates the row content status', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(asrResultEvent(1, 0, 'CONTENT_OK', 0.97));
  assert.equal(app.api.state.cues[0].contentStatus, 'CONTENT_OK');
});

test('once content validation starts, status text tracks it instead of freezing at 100%', async () => {
  // Regression test: synthesis finishing (100%) does not mean the run is
  // done -- content validation (ASR) still has to run, and it used to
  // leave the status text frozen at "Processing 3/3" for however long that
  // took, making a healthy run look stuck until the user gave up and hit
  // Cancel.
  const app = boot();
  await app.loadSrt();
  app.emit({ type: 'started', total: 3, workers: 3, processors: 3 });
  app.emit({ type: 'progress', completed: 3, total: 3, entry: { index: 3 } });
  assert.equal(app.api.elements.status.textContent, 'Processing 3/3');
  app.emit({ type: 'status', message: 'Validating audio content...' });
  assert.equal(app.api.elements.status.textContent, 'Validating audio content...');
  app.emit(asrResultEvent(1, 0, 'CONTENT_OK', 0.97));
  assert.equal(app.api.elements.status.textContent, 'Validating 1/3');
  app.emit(asrResultEvent(2, 1, 'CONTENT_OK', 0.97));
  assert.equal(app.api.elements.status.textContent, 'Validating 2/3');
});

test('a content-retry status line does not get overwritten by the validation counter', async () => {
  // The retry pass covers only a subset of lines; state.total would be the
  // wrong denominator, so segment_asr_result must not touch the status text
  // once a retry status line has been shown.
  const app = boot();
  await app.loadSrt();
  app.emit({ type: 'started', total: 3, workers: 3, processors: 3 });
  app.emit({ type: 'status', message: 'Validating audio content...' });
  app.emit(asrResultEvent(1, 0, 'CONTENT_OK', 0.97));
  assert.equal(app.api.elements.status.textContent, 'Validating 1/3');
  app.emit({ type: 'status', message: 'Retrying 1 content-failed line(s) (attempt 2/3)...' });
  assert.equal(app.api.elements.status.textContent, 'Retrying 1 content-failed line(s) (attempt 2/3)...');
  app.emit(asrResultEvent(2, 1, 'CONTENT_OK', 0.97));
  assert.equal(app.api.elements.status.textContent, 'Retrying 1 content-failed line(s) (attempt 2/3)...',
    'a retry-pass segment_asr_result must not overwrite the retry status line');
});

test('a success event with SPEED_ADJUST timing shows a badge, not a failure', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({
    ...successEvent(1, 0, 'line_1.wav'), timing_status: 'SPEED_ADJUST',
  });
  assert.equal(app.api.state.cues[0].status, 'success');
  assert.equal(app.api.state.cues[0].timingStatus, 'SPEED_ADJUST');
});

test('a SPEED_ADJUST row shows a visible Speed Adjust badge in its status cell', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({ ...successEvent(1, 0, 'line_1.wav'), timing_status: 'SPEED_ADJUST' });
  const statusCell = app.rows()[0].children[4];
  assert.ok(statusCell.textContent.includes('Speed Adjust'),
    `expected a visible Speed Adjust badge, got "${statusCell.textContent}"`);
});

test('a TIMING_OK success row shows no badge', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({ ...successEvent(1, 0, 'line_1.wav'), timing_status: 'TIMING_OK' });
  const statusCell = app.rows()[0].children[4];
  assert.equal(statusCell.textContent, 'Success');
});

test('Speed is unknown before processing and formats the backend value to two decimals', async () => {
  const app = boot();
  await app.loadSrt();
  assert.equal(app.rows()[0].children[3].textContent, '—');

  app.emit({ ...successEvent(1, 0, 'line_1.wav'), speed: 1 });
  app.emit({ ...successEvent(2, 1, 'line_2.wav'), speed: 1.274 });
  assert.equal(app.rows()[0].children[3].textContent, '1.00x');
  assert.equal(app.rows()[1].children[3].textContent, '1.27x');
  assert.equal(app.api.formatSpeed(undefined), '—');
});

test('regenerating a row clears stale Speed until the new result arrives', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({ ...successEvent(1, 0, 'line_1.wav'), speed: 1.1 });
  assert.equal(app.rows()[0].children[3].textContent, '1.10x');

  app.emit({ type: 'segment_started', index: 1, position: 0, manual: true });
  assert.equal(app.rows()[0].children[3].textContent, '—');
  app.emit({ ...successEvent(1, 0, 'line_1-new.wav'), speed: 1.25, manual: true });
  assert.equal(app.rows()[0].children[3].textContent, '1.25x');
});

test('complete keeps persisted Speed metadata when rebuilding rows', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({
    type: 'complete', elapsed: '00:00:01', destination: '/tmp/out/sample.zsp',
    entries: [{
      index: 1, start: 0, end: 2, content: 'First line', audio_filename: 'line_1.wav',
      timing: { status: 'SPEED_ADJUST', speed: 1.32 }
    }]
  });
  assert.equal(app.rows()[0].children[3].textContent, '1.32x');
  assert.equal(app.rows()[0].children[4].textContent, 'Success');
});

test('the processor selector defaults to the documented default', async () => {
  const app = boot();
  assert.equal(app.api.elements.threadsSelect.value, '4');
  assert.equal(app.api.state.cues.length, 0);
});

test('the TTS model selector defaults to VieNeu and exposes exactly two models', () => {
  const app = boot();
  assert.equal(app.api.elements.ttsModelSelect.value, 'vieneu');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = html.match(/<select id="tts-model-select">([\s\S]*?)<\/select>/)[1];
  const options = [...body.matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map((option) => option[3].trim()),
    ['VieNeu-TTS v3 Turbo', 'MeloTTS']);
  assert.match(options[0][2], /selected/);
});

test('a synthesis job snapshots the selected model, language, and speaker', async () => {
  const app = boot();
  app.api.state.subtitlePath = '/tmp/sample.srt';
  app.api.state.outputPath = '/tmp/out';
  app.api.elements.ttsModelSelect.value = 'melotts';
  app.api.elements.meloLanguageSelect.value = 'FR';
  app.api.elements.meloSpeakerSelect.value = 'FR';
  await app.api.runSynthesis(false);
  assert.equal(app.calls.startSynthesis.length, 1);
  assert.equal(app.calls.startSynthesis[0].ttsModel, 'melotts');
  assert.equal(app.calls.startSynthesis[0].meloLanguage, 'FR');
  assert.equal(app.calls.startSynthesis[0].meloSpeaker, 'FR');
  app.emit({ type: 'process_exit', code: 0, signal: null, retry: false });
});

test('the Speed column sits immediately left of Status', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1].trim());
  assert.deepEqual(headers, ['ID', 'Duration', 'Text Content', 'Speed', 'Status', 'Actions']);
});

test('the status filter offers All/Success/Fail with All selected', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = html.match(/<select id="status-filter">([\s\S]*?)<\/select>/)[1];
  const options = [...body.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(options.map((option) => option[1]), ['all', 'success', 'fail']);
  assert.equal(options.filter((option) => option[2].includes('selected')).length, 1);
  assert.match(options[0][2], /selected/);
});

test('the processor selector offers 2-6 with 4 selected', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = html.match(/<select id="threads-select">([\s\S]*?)<\/select>/)[1];
  const options = [...body.matchAll(/<option value="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(options.map((option) => option[1]), THREAD_VALUES);
  assert.match(options.find((option) => option[1] === '4')[2], /selected/);
  assert.equal(options.filter((option) => option[2].includes('selected')).length, 1);
});

function manyCues(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1, position: i, duration: `00:00:0${i},000 --> 00:00:0${i},500`,
    text: `Line ${i + 1}`, status: 'pending', attempts: 0
  }));
}

test('Auto page size fills the table height and stays in sync on resize', async () => {
  const app = boot();
  await app.loadSrt();
  app.api.state.cues = manyCues(50);
  app.api.elements.tableHead.offsetHeight = 40;
  app.api.elements.tableContainer.clientHeight = 220; // (220-40)/36 = 5 rows
  app.api.handleTableContainerResize();
  assert.equal(app.api.state.pageSize, 5);
  assert.equal(app.rows().length, 5);

  // The container grows (window resize, panel-resizer drag, ...): more rows fit.
  app.api.elements.tableContainer.clientHeight = 760;
  app.api.handleTableContainerResize();
  const grown = Math.floor((760 - 40) / 36); // 20
  assert.equal(app.api.state.pageSize, grown);
  assert.equal(app.rows().length, grown);

  // It shrinks back too.
  app.api.elements.tableContainer.clientHeight = 400;
  app.api.handleTableContainerResize();
  assert.equal(app.api.state.pageSize, Math.floor((400 - 40) / 36));
});

test('picking a fixed page size stops Auto from overriding it on resize', async () => {
  const app = boot();
  await app.loadSrt();
  app.api.state.cues = manyCues(50);
  app.api.elements.pageSizeSelect.value = '20';
  app.api.elements.pageSizeSelect.dispatch('change');
  assert.equal(app.api.state.autoPageSize, false);

  app.api.elements.tableContainer.clientHeight = 2000;
  app.api.elements.tableHead.offsetHeight = 40;
  app.api.handleTableContainerResize();
  assert.equal(app.api.state.pageSize, 20, 'a manual choice is not overridden by a resize');

  app.api.elements.pageSizeSelect.value = 'auto';
  app.api.elements.pageSizeSelect.dispatch('change');
  assert.equal(app.api.state.autoPageSize, true);
  assert.equal(app.api.state.pageSize, Math.floor((2000 - 40) / 36));
});

test('the page size select changes rows per page and resets to page 1', async () => {
  const app = boot();
  await app.loadSrt();
  app.api.state.cues = manyCues(25);
  app.api.state.currentPage = 3;
  app.api.render();
  app.api.elements.pageSizeSelect.value = '20';
  app.api.elements.pageSizeSelect.dispatch('change');
  assert.equal(app.api.state.pageSize, 20);
  assert.equal(app.api.state.currentPage, 1);
  assert.equal(app.rows().length, 20);
});

test('Go to page jumps directly and clamps to the valid range', async () => {
  const app = boot();
  await app.loadSrt();
  app.api.state.cues = manyCues(25);
  app.api.render();
  app.api.elements.gotoInput.value = '3';
  app.api.elements.gotoInput.dispatch('change');
  assert.equal(app.api.state.currentPage, 3);
  assert.equal(app.rows()[0].children[0].textContent, 21);

  app.api.elements.gotoInput.value = '999';
  app.api.elements.gotoInput.dispatch('change');
  assert.equal(app.api.state.currentPage, 3, 'clamped to the last page (25 rows / 10 = 3 pages)');

  app.api.elements.gotoInput.value = '0';
  app.api.elements.gotoInput.dispatch('change');
  assert.equal(app.api.state.currentPage, 1, 'clamped to the first page');
});

test('pagination shows an ellipsis and the last page when there are many pages', async () => {
  const app = boot();
  await app.loadSrt();
  app.api.state.cues = manyCues(200);
  app.api.state.currentPage = 1;
  app.api.render();
  const labels = app.api.elements.pagination.children.map((el) => el.textContent);
  assert.ok(labels.includes('…'), 'an ellipsis marks the gap to the last page');
  assert.ok(labels.includes('20'), 'the last page (200 rows / 10) is reachable');
});

test('the Clear button empties the activity log', async () => {
  const app = boot();
  await app.loadSrt();
  assert.ok(app.logs().length > 0);
  app.api.elements.clearLogButton.dispatch('click');
  assert.deepEqual(app.logs(), ['Log cleared']);
});

test('the panel resizer widens the table panel with arrow keys and persists it', () => {
  const app = boot();
  app.api.elements.workspace.getBoundingClientRect = () => ({ width: 1200 });
  app.api.elements.panelResizer.getBoundingClientRect = () => ({ width: 16 });
  app.api.elements.tablePanel.getBoundingClientRect = () => ({ width: 700 });

  app.api.elements.panelResizer.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(app.api.elements.tablePanel.style.flex, '0 0 724px');
  assert.equal(app.api.elements.processingPanel.style.flex, '1 1 auto');
  assert.equal(app.api.localStorage.getItem('srtts:table-panel-width'), String(724 / 1200),
    'persists the table-panel share as a ratio of workspace width, not a raw pixel count');

  app.api.elements.tablePanel.getBoundingClientRect = () => ({ width: 724 });
  app.api.elements.panelResizer.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(app.api.elements.tablePanel.style.flex, '0 0 700px');
});

test('the panel resizer clamps to a minimum width', () => {
  const app = boot();
  app.api.elements.workspace.getBoundingClientRect = () => ({ width: 1200 });
  app.api.elements.panelResizer.getBoundingClientRect = () => ({ width: 16 });
  app.api.elements.tablePanel.getBoundingClientRect = () => ({ width: 330 });

  app.api.elements.panelResizer.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(app.api.elements.tablePanel.style.flex, '0 0 320px', 'never below the 320px floor');
});

test('formatElapsed renders HH:MM:SS', () => {
  const app = boot();
  assert.equal(app.api.formatElapsed(0), '00:00:00');
  assert.equal(app.api.formatElapsed(65000), '00:01:05');
  assert.equal(app.api.formatElapsed(3661000), '01:01:01');
});

test('Save Project is disabled until at least one line has audio', async () => {
  const app = boot();
  await app.loadSrt();
  assert.equal(app.api.elements.saveButton.disabled, true);
  app.emit(successEvent(1, 0, 'line_1.wav'));
  assert.equal(app.api.elements.saveButton.disabled, false);
});

test('Save Project stays enabled even when another line has failed', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(contentFailEvent(2, 1));
  assert.equal(app.api.elements.saveButton.disabled, false);
});

test('clicking Save Project calls the backend and locks the button until it exits', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.api.elements.saveButton.dispatch('click');
  await app.flush();
  assert.equal(app.calls.saveProject.length, 1);
  assert.equal(app.api.elements.saveButton.disabled, true, 'locked while packaging runs');
  app.emit({ type: 'packaged', destination: '/tmp/out/sample.zsp' });
  app.emit({ type: 'package_exit', code: 0, signal: null });
  assert.equal(app.api.elements.saveButton.disabled, false, 'unlocked once packaging finishes');
  assert.ok(app.logs().some((line) => line.includes('Project saved: /tmp/out/sample.zsp')));
});

test('Validate Now is disabled until at least one line has audio', async () => {
  const app = boot();
  await app.loadSrt();
  assert.equal(app.api.elements.validateButton.disabled, true);
  app.emit(successEvent(1, 0, 'line_1.wav'));
  assert.equal(app.api.elements.validateButton.disabled, false);
});

test('clicking Validate Now calls the backend and flips a failing line to Fail', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(successEvent(2, 1, 'line_2.wav'));
  app.api.elements.validateButton.dispatch('click');
  await app.flush();
  assert.equal(app.calls.validateContent.length, 1);
  assert.equal(app.api.elements.validateButton.disabled, true, 'locked while validating');
  app.emit({ type: 'validation_started', total: 2 });
  app.emit(asrResultEvent(1, 0, 'CONTENT_OK', 0.97));
  assert.equal(app.api.cuesFor(1)[0].status, 'success');
  app.emit(asrResultEvent(2, 1, 'CONTENT_WRONG', 0.1));
  assert.equal(app.api.cuesFor(2)[0].status, 'fail', 'a manual-validate mismatch flips the row to Fail');
  app.emit({ type: 'validation_complete', total: 2 });
  app.emit({ type: 'validate_exit', code: 0, signal: null });
  assert.equal(app.api.elements.validateButton.disabled, false, 'unlocked once validation finishes');
});

test('a segment_asr_result during a normal run never flips status by itself', async () => {
  const app = boot();
  await app.loadSrt();
  app.emit({ type: 'started', total: 1, workers: 1, processors: 1 });
  app.emit(successEvent(1, 0, 'line_1.wav'));
  app.emit(asrResultEvent(1, 0, 'CONTENT_WRONG', 0.1));
  assert.equal(app.api.cuesFor(1)[0].status, 'success',
    'outside manual Validate Now, a content mismatch is resolved by segment_result, not here');
});

test('an SRT with a byte order mark still parses into stable positions', async () => {
  const app = boot();
  const cues = app.api.parseSrt(`﻿${SRT}`);
  assert.deepEqual([...cues.map((cue) => cue.id)], [1, 2, 3]);
  assert.deepEqual([...cues.map((cue) => cue.position)], [0, 1, 2]);
  assert.deepEqual([...cues.map((cue) => cue.status)], ['pending', 'pending', 'pending']);
});
