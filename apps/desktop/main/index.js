'use strict';

const path = require('node:path');
const { app, BrowserWindow, dialog, Menu, session } = require('electron');
const { createMainWindow } = require('./window');
const { registerIpcRouter } = require('./ipc-router');
const { DialogService } = require('./services/dialog-service');
const { FFmpegLocator, FFprobeLocator } = require('./services/executable-locator');
const { ModuleManager } = require('./services/module-manager');
const { ModuleRegistry } = require('./services/module-registry');
const { PathService } = require('./services/path-service');
const { ProcessManager } = require('./services/process-manager');
const { RuntimeResolver } = require('./services/runtime-resolver');
const { SettingsStore } = require('./services/settings-store');
const { TaskManager } = require('./services/task-manager');
const { resetRendererSession } = require('./services/session-state');

app.setName('MediaForge');
if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: 'MediaForge', applicationVersion: app.getVersion() });

let mainWindow = null;
let moduleManager = null;
let processManager = null;
let taskManager = null;
let quitting = false;
let promptOpen = false;

async function closeApplication() {
  if (quitting) return;
  quitting = true;
  try {
    await moduleManager?.shutdown();
    await processManager?.shutdown();
  } finally {
    mainWindow?.destroy();
    app.quit();
  }
}

async function requestClose() {
  if (quitting || promptOpen) return;
  if (taskManager?.active().length) {
    promptOpen = true;
    let response = 1;
    try {
      ({ response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel Tasks and Quit', 'Continue Processing'],
        defaultId: 1, cancelId: 1, noLink: true,
        title: 'Tasks in Progress', message: 'MediaForge is still processing media.',
        detail: 'Active processes will be stopped. User files, exports, and recovery artifacts will be preserved.'
      }));
    } finally { promptOpen = false; }
    if (response !== 0) return;
  }
  await closeApplication();
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const paths = new PathService({ projectRoot, userDataPath: app.getPath('userData') });
  paths.ensure();
  paths.resetSessionData();
  await resetRendererSession(session.defaultSession);
  const registry = new ModuleRegistry({ modulesRoot: path.join(projectRoot, 'backend', 'mediaforge', 'modules'), projectRoot });
  registry.discover();
  const runtimeResolver = new RuntimeResolver({ projectRoot });
  const ffmpegLocator = new FFmpegLocator();
  const ffprobeLocator = new FFprobeLocator();
  processManager = new ProcessManager();
  taskManager = new TaskManager({ pathService: paths });
  const settings = new SettingsStore(paths.config);
  moduleManager = new ModuleManager({
    registry, runtimeResolver, processManager, taskManager, pathService: paths,
    ffmpegLocator, ffprobeLocator
  });
  mainWindow = createMainWindow(settings.get().theme, app.getVersion());
  const dialogService = new DialogService(() => mainWindow);
  registerIpcRouter({
    getWindow: () => mainWindow, registry, moduleManager, taskManager, settings, dialogService,
    healthCheck: async () => ({
      runtimes: await runtimeResolver.healthAll(),
      executables: await Promise.all([ffmpegLocator.health(), ffprobeLocator.health()])
    })
  });
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); void requestClose(); } });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(settings.get().theme, app.getVersion());
      mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); void requestClose(); } });
    }
  });
});

app.on('before-quit', (event) => { if (!quitting && moduleManager) { event.preventDefault(); void requestClose(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') void closeApplication(); });
