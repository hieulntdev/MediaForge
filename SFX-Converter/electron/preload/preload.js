'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload scripts only have access to Electron and a small subset of
// Node built-ins. In particular, they cannot require local CommonJS modules.
// Keep these values in sync with electron/shared/channels.js.
const CHANNELS = Object.freeze({
  SELECT_VIDEO: 'dialog:select-video',
  SELECT_OUTPUT: 'dialog:select-output',
  TASK_START: 'task:start',
  TASK_CANCEL: 'task:cancel',
  TASK_EVENT: 'task:event',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set'
});

const initialThemeArgument = process.argv.find((argument) => argument.startsWith('--sfx-theme='));
const initialTheme = initialThemeArgument?.slice('--sfx-theme='.length) === 'dark' ? 'dark' : 'light';

contextBridge.exposeInMainWorld('sfxApi', Object.freeze({
  initialTheme,
  selectVideo: () => ipcRenderer.invoke(CHANNELS.SELECT_VIDEO),
  selectOutput: (currentPath) => ipcRenderer.invoke(CHANNELS.SELECT_OUTPUT, currentPath),
  startTask: (inputPath, outputDir) => ipcRenderer.invoke(CHANNELS.TASK_START, { inputPath, outputDir }),
  cancelTask: () => ipcRenderer.invoke(CHANNELS.TASK_CANCEL),
  getSettings: () => ipcRenderer.invoke(CHANNELS.SETTINGS_GET),
  setSettings: (values) => ipcRenderer.invoke(CHANNELS.SETTINGS_SET, values),
  onTaskEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Task event callback must be a function.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(CHANNELS.TASK_EVENT, listener);
    return () => ipcRenderer.removeListener(CHANNELS.TASK_EVENT, listener);
  }
}));
