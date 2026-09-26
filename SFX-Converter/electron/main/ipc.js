'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dialog, ipcMain } = require('electron');
const CHANNELS = require('../shared/channels');

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32768) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function registerIpcHandlers({ getWindow, backend, settings }) {
  ipcMain.handle(CHANNELS.SELECT_VIDEO, async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Select Video',
      properties: ['openFile'],
      filters: [
        { name: 'Video files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedPath = path.resolve(result.filePaths[0]);
    return { path: selectedPath, defaultOutputDir: path.dirname(selectedPath) };
  });

  ipcMain.handle(CHANNELS.SELECT_OUTPUT, async (_event, requestedPath) => {
    const defaultPath = typeof requestedPath === 'string' && requestedPath ? requestedPath : undefined;
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Select Output Folder',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled || result.filePaths.length === 0 ? null : path.resolve(result.filePaths[0]);
  });

  ipcMain.handle(CHANNELS.TASK_START, async (_event, payload) => {
    const inputPath = path.resolve(assertString(payload?.inputPath, 'Video path'));
    const outputDir = path.resolve(assertString(payload?.outputDir, 'Output folder'));
    if (!fs.statSync(inputPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Video file does not exist: ${inputPath}`);
    if (!fs.statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Output folder does not exist: ${outputDir}`);
    }
    return backend.start(inputPath, outputDir);
  });

  ipcMain.handle(CHANNELS.TASK_CANCEL, () => ({ cancelled: backend.cancel() }));
  ipcMain.handle(CHANNELS.SETTINGS_GET, () => settings.get());
  ipcMain.handle(CHANNELS.SETTINGS_SET, (_event, values) => settings.set(values));

  backend.on('event', (payload) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.TASK_EVENT, payload);
  });
}

module.exports = { registerIpcHandlers };

