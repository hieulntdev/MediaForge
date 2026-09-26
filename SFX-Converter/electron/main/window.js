'use strict';

const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

function createWindowOptions(theme = 'light') {
  return {
    title: 'SFX Converter',
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: theme === 'dark' ? '#1d1d1f' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--sfx-theme=${theme === 'dark' ? 'dark' : 'light'}`]
    }
  };
}

function createMainWindow(theme = 'light') {
  const window = new BrowserWindow(createWindowOptions(theme));

  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  return window;
}

module.exports = { createMainWindow, createWindowOptions };
