'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, Menu } = require('electron');
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

app.setName('MediaForge');
if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: 'MediaForge', applicationVersion: '1.0.0' });

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
        detail: 'Active processes will be stopped. Recoverable SRT retry state will be kept for the next launch.'
      }));
    } finally { promptOpen = false; }
    if (response !== 0) return;
  }
  await closeApplication();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const paths = new PathService({ projectRoot, userDataPath: app.getPath('userData') });
  paths.ensure();
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
  mainWindow = createMainWindow(settings.get().theme);
  const dialogService = new DialogService(() => mainWindow);
  registerIpcRouter({
    getWindow: () => mainWindow, registry, moduleManager, taskManager, settings, dialogService,
    healthCheck: async () => ({
      runtimes: await runtimeResolver.healthAll(),
      executables: await Promise.all([ffmpegLocator.health(), ffprobeLocator.health()])
    })
  });
  const smokeCapture = process.env.MEDIAFORGE_SMOKE_CAPTURE;
  if (smokeCapture) {
    const smokeWidth = Number(process.env.MEDIAFORGE_SMOKE_WIDTH);
    const smokeHeight = Number(process.env.MEDIAFORGE_SMOKE_HEIGHT);
    if (Number.isInteger(smokeWidth) && Number.isInteger(smokeHeight)) {
      mainWindow.setSize(smokeWidth, smokeHeight);
      mainWindow.center();
    }
    mainWindow.webContents.once('did-finish-load', async () => {
      const route = process.env.MEDIAFORGE_SMOKE_MODULE;
      if (route) {
        if (!/^[a-z_]+$/.test(route)) throw new Error('Invalid smoke-test module id.');
        const selector = JSON.stringify(`[data-module="${route}"]`);
        await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            const target = document.querySelector(${selector});
            if (target) { clearInterval(timer); target.click(); setTimeout(resolve, 900); }
            else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('Module route did not render')); }
          }, 50);
        })`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const image = await mainWindow.capturePage();
      fs.writeFileSync(smokeCapture, image.toPNG());
      await closeApplication();
    });
  }
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); void requestClose(); } });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(settings.get().theme);
      mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); void requestClose(); } });
    }
  });
});

app.on('before-quit', (event) => { if (!quitting && moduleManager) { event.preventDefault(); void requestClose(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') void closeApplication(); });
