const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  selectLinks: () => ipcRenderer.invoke('dialog:select-links'),
  selectCookies: () => ipcRenderer.invoke('dialog:select-cookies'),
  selectOutput: () => ipcRenderer.invoke('dialog:select-output'),
  openFolder: (outputPath) => ipcRenderer.invoke('shell:open-folder', outputPath),

  startDownload: (payload) => ipcRenderer.send('backend:command', {
    command: 'analyze', ...payload, auto_download: true,
  }),
  analyzeUrl: (url, cookiesFile) => ipcRenderer.send('backend:command', {
    command: 'analyze', url, cookies_file: cookiesFile, auto_download: false,
  }),
  download: (indices) => ipcRenderer.send('backend:command', { command: 'download', indices }),
  pause: () => ipcRenderer.send('backend:command', { command: 'pause' }),
  resume: () => ipcRenderer.send('backend:command', { command: 'resume' }),
  cancel: () => ipcRenderer.send('backend:command', { command: 'cancel' }),
  checkAccount: (cookiesFile) => ipcRenderer.send('backend:command', {
    command: 'check_account', cookies_file: cookiesFile,
  }),
  getSettings: () => ipcRenderer.send('backend:command', { command: 'get_settings' }),
  saveSettings: (settings) => ipcRenderer.send('backend:command', {
    command: 'save_settings', settings,
  }),

  onBackendEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('backend:event', listener);
    return () => ipcRenderer.removeListener('backend:event', listener);
  },
});
