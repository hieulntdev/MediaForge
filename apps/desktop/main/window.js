'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { createWindowOptions } = require('./window-options');

function createMainWindow(theme) {
  const display = screen.getPrimaryDisplay();
  const window = new BrowserWindow(createWindowOptions(theme, display.workArea));
  window.loadFile(path.join(__dirname, '..', '..', '..', 'frontend', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  return window;
}

module.exports = { createMainWindow };
