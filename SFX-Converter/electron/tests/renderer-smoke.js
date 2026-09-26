'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const CHANNELS = require('../shared/channels');
const { createWindowOptions } = require('../main/window');

const calls = {
  selectVideo: 0,
  selectOutput: [],
  startTask: [],
  cancelTask: 0,
  settings: []
};

let savedTheme = 'light';

ipcMain.handle(CHANNELS.SELECT_VIDEO, () => {
  calls.selectVideo += 1;
  return { path: '/tmp/source.mp4', defaultOutputDir: '/tmp' };
});
ipcMain.handle(CHANNELS.SELECT_OUTPUT, (_event, currentPath) => {
  calls.selectOutput.push(currentPath);
  return '/tmp/export';
});
ipcMain.handle(CHANNELS.TASK_START, (_event, payload) => {
  calls.startTask.push(payload);
  return { jobId: 'smoke-job' };
});
ipcMain.handle(CHANNELS.TASK_CANCEL, () => {
  calls.cancelTask += 1;
  return { cancelled: true };
});
ipcMain.handle(CHANNELS.SETTINGS_GET, () => ({ theme: savedTheme }));
ipcMain.handle(CHANNELS.SETTINGS_SET, (_event, values) => {
  savedTheme = values.theme;
  calls.settings.push(values);
  return { theme: savedTheme };
});

async function rendererState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const videoSection = document.querySelector('[aria-labelledby="video-title"]');
    const outputSection = document.querySelector('[aria-labelledby="output-title"]');
    const logSection = document.querySelector('.log-section');
    const logView = document.querySelector('#log-view');
    const logEmpty = logView.querySelector('.log-empty');
    const logStyle = getComputedStyle(logView);
    const logViewRect = logView.getBoundingClientRect();
    const sun = document.querySelector('#theme-sun');
    const moon = document.querySelector('#theme-moon');
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, height: value.height, width: value.width };
    };
    return {
      theme: document.documentElement.dataset.theme,
      themeLabel: document.querySelector('#theme-toggle').getAttribute('aria-label'),
      sunDisplay: getComputedStyle(sun).display,
      moonDisplay: getComputedStyle(moon).display,
      iconColor: getComputedStyle(document.querySelector('#theme-toggle')).color,
      iconStroke: getComputedStyle(sun.querySelector('path')).stroke,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      panelBackground: getComputedStyle(videoSection).backgroundColor,
      panelBorder: getComputedStyle(videoSection).borderTopColor,
      primaryText: getComputedStyle(document.querySelector('#video-title')).color,
      videoPath: document.querySelector('#video-path').textContent,
      outputPath: document.querySelector('#output-path').textContent,
      runDisabled: document.querySelector('#run-button').disabled,
      browseDisabled: document.querySelector('#browse-video').disabled,
      cancelHidden: document.querySelector('#cancel-button').hidden,
      status: document.querySelector('#status-label').textContent,
      progress: document.querySelector('#progress-value').textContent,
      log: logView.textContent.trim(),
      logLines: logView.querySelectorAll('.log-line').length,
      logClientHeight: logView.clientHeight,
      logScrollHeight: logView.scrollHeight,
      logOverflowX: getComputedStyle(logView).overflowX,
      logOverflowY: getComputedStyle(logView).overflowY,
      logContentTop: logViewRect.top + logView.clientTop + parseFloat(logStyle.paddingTop),
      logEmptyTop: logEmpty?.getBoundingClientRect().top ?? null,
      videoRect: rect(videoSection),
      outputRect: rect(outputSection),
      logRect: rect(logSection),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogOpen: document.querySelector('#error-dialog').open
    };
  })()`);
}

async function clickAndSettle(window, selector) {
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function assertTheme(state, theme) {
  const expected = theme === 'dark'
    ? {
        action: 'Switch to light mode',
        body: 'rgb(29, 29, 31)',
        panel: 'rgb(44, 44, 46)',
        border: 'rgb(72, 72, 74)',
        text: 'rgb(245, 245, 247)',
        sun: 'block',
        moon: 'none'
      }
    : {
        action: 'Switch to dark mode',
        body: 'rgb(245, 245, 247)',
        panel: 'rgb(255, 255, 255)',
        border: 'rgb(210, 210, 215)',
        text: 'rgb(29, 29, 31)',
        sun: 'none',
        moon: 'block'
      };
  assert.equal(state.theme, theme);
  assert.equal(state.themeLabel, expected.action);
  assert.equal(state.bodyBackground, expected.body);
  assert.equal(state.panelBackground, expected.panel);
  assert.equal(state.panelBorder, expected.border);
  assert.equal(state.primaryText, expected.text);
  assert.equal(state.iconColor, expected.text);
  assert.equal(state.iconStroke, expected.text);
  assert.equal(state.sunDisplay, expected.sun);
  assert.equal(state.moonDisplay, expected.moon);
}

async function waitFor(window, expression, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for renderer condition: ${expression}`);
}

app.whenReady().then(async () => {
  const options = createWindowOptions('light');
  options.show = false;
  const window = new BrowserWindow(options);
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    let state = await rendererState(window);
    assertTheme(state, 'light');
    assert.equal(state.runDisabled, true);
    assert.equal(state.logOverflowX, 'hidden');
    assert.equal(state.logOverflowY, 'hidden');
    assert.equal(state.logScrollHeight, state.logClientHeight);
    assert.equal(state.logEmptyTop, state.logContentTop);

    await clickAndSettle(window, '#theme-toggle');
    state = await rendererState(window);
    assertTheme(state, 'dark');

    await clickAndSettle(window, '#theme-toggle');
    state = await rendererState(window);
    assertTheme(state, 'light');

    await clickAndSettle(window, '#theme-toggle');
    state = await rendererState(window);
    assertTheme(state, 'dark');

    await clickAndSettle(window, '#theme-toggle');
    state = await rendererState(window);
    assertTheme(state, 'light');
    assert.deepEqual(calls.settings, [
      { theme: 'dark' },
      { theme: 'light' },
      { theme: 'dark' },
      { theme: 'light' }
    ]);

    await clickAndSettle(window, '#browse-video');
    state = await rendererState(window);
    assert.equal(calls.selectVideo, 1);
    assert.equal(state.videoPath, '/tmp/source.mp4');
    assert.equal(state.outputPath, '/tmp');
    assert.equal(state.runDisabled, false);

    await clickAndSettle(window, '#browse-output');
    state = await rendererState(window);
    assert.deepEqual(calls.selectOutput, ['/tmp']);
    assert.equal(state.outputPath, '/tmp/export');

    const layoutBeforeLogs = state;
    for (let index = 1; index <= 1000; index += 1) {
      window.webContents.send(CHANNELS.TASK_EVENT, {
        type: 'task:log',
        level: 'INFO',
        message: `[12:00:00] [INFO] Layout stress log line ${index}`
      });
    }
    await waitFor(window, "document.querySelectorAll('#log-view .log-line').length === 500");
    state = await rendererState(window);
    assert.equal(state.logLines, 500);
    assert.equal(state.logOverflowY, 'auto');
    assert.ok(state.logScrollHeight > state.logClientHeight);
    assert.equal(state.logRect.height, layoutBeforeLogs.logRect.height);
    assert.equal(state.videoRect.height, layoutBeforeLogs.videoRect.height);
    assert.equal(state.outputRect.height, layoutBeforeLogs.outputRect.height);
    assert.equal(state.videoRect.top, layoutBeforeLogs.videoRect.top);
    assert.equal(state.outputRect.top, layoutBeforeLogs.outputRect.top);
    assert.equal(state.horizontalOverflow, false);

    window.setSize(900, 650);
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await rendererState(window);
    assert.equal(state.horizontalOverflow, false);
    assert.equal(state.logRect.height, 320);
    assert.ok(state.logScrollHeight > state.logClientHeight);
    assert.ok(state.videoRect.bottom <= state.outputRect.top, 'video and output panels must not overlap');
    assert.ok(state.outputRect.bottom <= state.logRect.top, 'output and log panels must not overlap');

    window.setSize(1180, 780);
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await rendererState(window);
    assert.equal(state.logRect.height, layoutBeforeLogs.logRect.height);
    assert.equal(state.videoRect.height, layoutBeforeLogs.videoRect.height);
    assert.equal(state.outputRect.height, layoutBeforeLogs.outputRect.height);

    await clickAndSettle(window, '#run-button');
    state = await rendererState(window);
    assert.deepEqual(calls.startTask, [{ inputPath: '/tmp/source.mp4', outputDir: '/tmp/export' }]);
    assert.equal(state.browseDisabled, true);
    assert.equal(state.cancelHidden, false);

    await clickAndSettle(window, '#cancel-button');
    assert.equal(calls.cancelTask, 1);

    window.webContents.send(CHANNELS.TASK_EVENT, {
      type: 'task:completed',
      outputPath: '/tmp/export/source_sfx.wav'
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    state = await rendererState(window);
    assert.equal(state.status, 'Completed: source_sfx.wav');
    assert.equal(state.progress, '100.0%');
    assert.equal(state.browseDisabled, false);
    assert.equal(state.cancelHidden, true);

    await clickAndSettle(window, '#clear-log');
    state = await rendererState(window);
    assert.match(state.log, /Activity log cleared\./);

    window.webContents.send(CHANNELS.TASK_EVENT, { type: 'backend:error', message: 'Smoke error' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    state = await rendererState(window);
    assert.equal(state.dialogOpen, true);
    assert.match(state.log, /Smoke error/);

    await clickAndSettle(window, '#error-dialog form button');
    state = await rendererState(window);
    assert.equal(state.dialogOpen, false);
    console.log('Electron renderer smoke test passed.');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
