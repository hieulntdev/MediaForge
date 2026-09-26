'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const EMBEDDED_VIEWPORT = Object.freeze({ width: 662, height: 500 });

function rectScript(selector) {
  return `(() => {
    const value = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { top: value.top, right: value.right, bottom: value.bottom, left: value.left,
      width: value.width, height: value.height };
  })()`;
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: EMBEDDED_VIEWPORT.width,
    height: EMBEDDED_VIEWPORT.height,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `srt-layout-smoke-${process.pid}`
    }
  });
  let exitCode = 0;

  try {
    await window.loadFile(path.join(__dirname, '..', 'index.html'));
    await window.webContents.insertCSS('html,body{min-width:0!important;min-height:0!important}');
    window.setContentSize(EMBEDDED_VIEWPORT.width, EMBEDDED_VIEWPORT.height);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const [viewport, tablePanel, tableContainer, processingPanel] = await Promise.all([
      window.webContents.executeJavaScript(`({ width: innerWidth, height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        appScrollHeight: document.querySelector('.app-container').scrollHeight,
        appClientHeight: document.querySelector('.app-container').clientHeight })`),
      window.webContents.executeJavaScript(rectScript('#table-panel')),
      window.webContents.executeJavaScript(rectScript('#table-container')),
      window.webContents.executeJavaScript(rectScript('#processing-panel'))
    ]);

    assert.deepEqual(
      { width: viewport.width, height: viewport.height },
      EMBEDDED_VIEWPORT,
      'smoke test must use the MediaForge SRT iframe viewport'
    );
    assert.equal(viewport.documentWidth, viewport.clientWidth, 'SRT document must not overflow horizontally');
    assert.ok(viewport.appScrollHeight > viewport.appClientHeight, 'stacked panels must remain reachable by vertical scrolling');
    assert.ok(tablePanel.height >= 400, 'Subtitle Segments must not collapse in the narrow layout');
    assert.ok(tableContainer.height >= 280, 'the subtitle grid must retain a usable scrollable area');
    assert.ok(processingPanel.top >= tablePanel.bottom + 12, 'Processing must start below Subtitle Segments');
    console.log('SRT embedded layout smoke test passed.');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window.destroy();
    app.exit(exitCode);
  }
});
