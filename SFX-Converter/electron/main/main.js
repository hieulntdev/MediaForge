'use strict';

const path = require('node:path');
const { app, dialog, Menu } = require('electron');
const { createMainWindow } = require('./window');
const { registerIpcHandlers } = require('./ipc');
const { BackendProcess } = require('./services/backend-process');
const { SettingsStore } = require('./services/settings-store');
const CHANNELS = require('../shared/channels');

let mainWindow = null;
let backend = null;
let quitting = false;
let closingPromptOpen = false;

app.setName('SFX Converter');

async function closeApplication() {
  if (quitting) return;
  quitting = true;
  try {
    await backend?.shutdown();
  } finally {
    mainWindow?.destroy();
    app.quit();
  }
}

async function requestApplicationClose() {
  if (quitting || closingPromptOpen) return;

  if (backend?.isRunning) {
    closingPromptOpen = true;
    let response;
    try {
      ({ response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel Task and Quit', 'Continue Processing'],
        defaultId: 1,
        cancelId: 1,
        title: 'Task in Progress',
        message: 'Are you sure you want to quit?',
        detail: 'The current task will be cancelled and its temporary files will be removed.',
        noLink: true
      }));
    } finally {
      closingPromptOpen = false;
    }
    if (response !== 0) return;
    mainWindow?.webContents.send(CHANNELS.TASK_EVENT, { type: 'task:closing' });
  }

  await closeApplication();
}

function handleWindowClose(event) {
  if (quitting) return;
  event.preventDefault();
  void requestApplicationClose();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const projectRoot = path.resolve(__dirname, '..', '..');
  backend = new BackendProcess({ projectRoot });
  const settings = new SettingsStore(app.getPath('userData'));
  mainWindow = createMainWindow(settings.get().theme);
  registerIpcHandlers({ getWindow: () => mainWindow, backend, settings });

  mainWindow.on('close', handleWindowClose);

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow(settings.get().theme);
      mainWindow.on('close', handleWindowClose);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void closeApplication();
});

app.on('before-quit', (event) => {
  if (!quitting && backend) {
    event.preventDefault();
    void requestApplicationClose();
  }
});
