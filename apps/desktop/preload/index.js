'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const CHANNELS = Object.freeze({
  MODULES_LIST: 'mediaforge:modules:list', MODULE_VIEW: 'mediaforge:modules:view', MODULE_EXECUTE: 'mediaforge:module:execute', MODULE_RESET: 'mediaforge:module:reset', MODULE_EVENT: 'mediaforge:module:event',
  TASKS_LIST: 'mediaforge:tasks:list', TASK_CANCEL: 'mediaforge:task:cancel', TASK_PAUSE: 'mediaforge:task:pause',
  TASK_RESUME: 'mediaforge:task:resume', TASK_EVENT: 'mediaforge:task:event', HEALTH_GET: 'mediaforge:health:get',
  DIALOG_OPEN: 'mediaforge:dialog:open', SHELL_OPEN_PATH: 'mediaforge:shell:open-path',
  SETTINGS_GET: 'mediaforge:settings:get', SETTINGS_SET: 'mediaforge:settings:set'
});

const initialThemeArgument = process.argv.find((value) => value.startsWith('--mediaforge-theme='));
const initialTheme = initialThemeArgument?.endsWith('dark') ? 'dark' : 'light';
const appVersionArgument = process.argv.find((value) => value.startsWith('--mediaforge-version='));
const appVersion = appVersionArgument?.slice('--mediaforge-version='.length) || 'unknown';
const execute = (module, action, payload = {}) => ipcRenderer.invoke(CHANNELS.MODULE_EXECUTE, { module, action, payload });
const subscribe = (channel, callback, module = null) => {
  if (typeof callback !== 'function') throw new TypeError('Event callback must be a function.');
  const listener = (_event, value) => {
    if (module && value.module !== module) return;
    callback(module ? value.payload : value);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('mediaForge', Object.freeze({
  initialTheme,
  appVersion,
  listModules: () => ipcRenderer.invoke(CHANNELS.MODULES_LIST),
  loadModuleView: (moduleId) => ipcRenderer.invoke(CHANNELS.MODULE_VIEW, moduleId),
  execute,
  resetModule: (moduleId) => ipcRenderer.invoke(CHANNELS.MODULE_RESET, moduleId),
  listTasks: () => ipcRenderer.invoke(CHANNELS.TASKS_LIST),
  cancelTask: (taskId) => ipcRenderer.invoke(CHANNELS.TASK_CANCEL, taskId),
  pauseTask: (taskId) => ipcRenderer.invoke(CHANNELS.TASK_PAUSE, taskId),
  resumeTask: (taskId) => ipcRenderer.invoke(CHANNELS.TASK_RESUME, taskId),
  health: () => ipcRenderer.invoke(CHANNELS.HEALTH_GET),
  openDialog: (request) => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, request),
  getSettings: () => ipcRenderer.invoke(CHANNELS.SETTINGS_GET),
  setSettings: (values) => ipcRenderer.invoke(CHANNELS.SETTINGS_SET, values),
  onTaskEvent: (callback) => subscribe(CHANNELS.TASK_EVENT, callback),
  onModuleEvent: (callback) => subscribe(CHANNELS.MODULE_EVENT, callback)
}));

// Transitional compatibility bridges keep the three characterized renderers
// runnable while all process and filesystem access is owned by MediaForge.
contextBridge.exposeInMainWorld('sfxApi', Object.freeze({
  initialTheme,
  selectVideo: async () => {
    const selected = await ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'video' });
    return selected ? { path: selected, defaultOutputDir: selected.replace(/[\\/][^\\/]+$/, '') } : null;
  },
  selectOutput: (defaultPath) => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'folder', defaultPath }),
  startTask: (inputPath, outputDir) => execute('sfx_converter', 'extract_sfx', { inputPath, outputDir }),
  cancelTask: () => execute('sfx_converter', 'cancel'),
  getSettings: () => ipcRenderer.invoke(CHANNELS.SETTINGS_GET),
  setSettings: (values) => ipcRenderer.invoke(CHANNELS.SETTINGS_SET, values),
  onTaskEvent: (callback) => subscribe(CHANNELS.MODULE_EVENT, callback, 'sfx_converter')
}));

contextBridge.exposeInMainWorld('biliAPI', Object.freeze({
  selectLinks: () => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'links' }),
  selectCookies: () => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'cookies' }),
  selectOutput: () => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'folder' }),
  openFolder: (outputPath) => ipcRenderer.invoke(CHANNELS.SHELL_OPEN_PATH, outputPath, true),
  startDownload: (payload) => execute('bili_downloader', 'download', payload),
  analyzeUrl: (url, cookiesFile) => execute('bili_downloader', 'analyze', { url, cookies_file: cookiesFile }),
  download: (indices) => execute('bili_downloader', 'download', { indices }),
  pause: () => execute('bili_downloader', 'pause'),
  resume: () => execute('bili_downloader', 'resume'),
  cancel: () => execute('bili_downloader', 'cancel'),
  checkAccount: (cookiesFile) => execute('bili_downloader', 'check_account', { cookies_file: cookiesFile }),
  getSettings: () => execute('bili_downloader', 'get_settings'),
  saveSettings: (settings) => execute('bili_downloader', 'set_settings', { settings }),
  getState: () => execute('bili_downloader', 'get_state'),
  onBackendEvent: (callback) => subscribe(CHANNELS.MODULE_EVENT, callback, 'bili_downloader')
}));

contextBridge.exposeInMainWorld('hongguoAPI', Object.freeze({
  selectOutput: (defaultPath) => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'folder', defaultPath }),
  getState: () => execute('hongguo_downloader', 'get_state'),
  getSettings: () => execute('hongguo_downloader', 'get_settings'),
  saveSettings: (settings) => execute('hongguo_downloader', 'set_settings', { settings }),
  analyze: (urls) => execute('hongguo_downloader', 'analyze', { urls }),
  addToQueue: (ids) => execute('hongguo_downloader', 'add_to_queue', { ids }),
  start: (ids) => execute('hongguo_downloader', 'start', { ids }),
  pause: () => execute('hongguo_downloader', 'pause'),
  resume: () => execute('hongguo_downloader', 'resume'),
  cancel: () => execute('hongguo_downloader', 'cancel'),
  retryFailed: () => execute('hongguo_downloader', 'retry_failed'),
  removeCompleted: () => execute('hongguo_downloader', 'remove_completed'),
  clearQueue: () => execute('hongguo_downloader', 'clear_queue'),
  clearLog: () => execute('hongguo_downloader', 'clear_log'),
  onEvent: (callback) => subscribe(CHANNELS.MODULE_EVENT, callback, 'hongguo_downloader')
}));

contextBridge.exposeInMainWorld('srtAPI', Object.freeze({
  openSrt: () => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'subtitle', includeContent: true }),
  openVoice: () => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'voice' }),
  selectOutput: (defaultPath) => ipcRenderer.invoke(CHANNELS.DIALOG_OPEN, { kind: 'folder', defaultPath }),
  startSynthesis: (job) => execute('srt_to_speech', 'synthesize', job),
  retrySegment: (job) => execute('srt_to_speech', 'retry_cue', job),
  saveProject: (job) => execute('srt_to_speech', 'package_project', job),
  validateContent: (job) => execute('srt_to_speech', 'validate_content', job),
  cancelSynthesis: () => execute('srt_to_speech', 'cancel'),
  previewAudio: (filename) => execute('srt_to_speech', 'preview_audio', { filename }),
  onBackendEvent: (callback) => subscribe(CHANNELS.MODULE_EVENT, callback, 'srt_to_speech')
}));
