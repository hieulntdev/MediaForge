const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  openSrt: () => ipcRenderer.invoke('dialog:open-srt'),
  openVoice: () => ipcRenderer.invoke('dialog:open-voice'),
  selectOutput: () => ipcRenderer.invoke('dialog:select-output'),
  startSynthesis: (job) => ipcRenderer.invoke('synthesis:start', job),
  retrySegment: (job) => ipcRenderer.invoke('synthesis:retry-segment', job),
  saveProject: (job) => ipcRenderer.invoke('project:save', job),
  validateContent: (job) => ipcRenderer.invoke('synthesis:validate-content', job),
  cancelSynthesis: () => ipcRenderer.invoke('synthesis:cancel'),
  previewAudio: (filename) => ipcRenderer.invoke('audio:preview', filename),
  onBackendEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('backend:event', listener);
    return () => ipcRenderer.removeListener('backend:event', listener);
  }
});
