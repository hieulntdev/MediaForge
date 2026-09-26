'use strict';

const path = require('node:path');
const { dialog, shell } = require('electron');

const DIALOGS = Object.freeze({
  links: { title: 'Select Link List File', properties: ['openFile'], filters: [{ name: 'Link list', extensions: ['txt', 'csv'] }] },
  cookies: { title: 'Select Cookies File', properties: ['openFile'], filters: [{ name: 'Cookies', extensions: ['txt'] }] },
  video: { title: 'Select Video', properties: ['openFile'], filters: [{ name: 'Video files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }, { name: 'All files', extensions: ['*'] }] },
  subtitle: { title: 'Select SRT subtitle file', properties: ['openFile'], filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }] },
  voice: { title: 'Select MP3 voice sample', properties: ['openFile'], filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }] },
  folder: { title: 'Select Output Folder', properties: ['openDirectory', 'createDirectory'] }
});

class DialogService {
  constructor(getWindow) { this.getWindow = getWindow; }

  async open(request = {}) {
    const definition = DIALOGS[request.kind];
    if (!definition) throw new Error('Unsupported dialog kind.');
    const result = await dialog.showOpenDialog(this.getWindow(), {
      ...definition,
      title: request.title || definition.title,
      defaultPath: typeof request.defaultPath === 'string' && request.defaultPath ? request.defaultPath : undefined
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = path.resolve(result.filePaths[0]);
    return request.includeContent
      ? { path: selected, content: require('node:fs').readFileSync(selected, 'utf8') }
      : selected;
  }

  async openPath(target, revealParent = false) {
    if (typeof target !== 'string' || !target) throw new TypeError('Invalid path.');
    const resolved = path.resolve(target);
    const result = await shell.openPath(revealParent ? path.dirname(resolved) : resolved);
    return result || null;
  }
}

module.exports = { DialogService, DIALOGS };

