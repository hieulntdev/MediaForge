const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const EVENT_PREFIX = 'BILI_EVENT ';

let mainWindow = null;
let worker = null;

function pythonExecutable() {
  if (process.env.BILI_PYTHON) return process.env.BILI_PYTHON;
  const venv = path.join(__dirname, '..', '.venv', 'bin', 'python3');
  if (fs.existsSync(venv)) return venv;
  return 'python3';
}

function backendEntry() {
  return path.join(__dirname, '..', 'backend_entry.py');
}

function sendEvent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:event', event);
  }
}

function sendCommand(command) {
  if (!worker || !worker.stdin || !worker.stdin.writable) {
    sendEvent({ type: 'log', level: 'ERROR', message: 'Backend is not running.' });
    return false;
  }
  worker.stdin.write(`${JSON.stringify(command)}\n`);
  return true;
}

function startBackend() {
  const entry = backendEntry();
  if (!fs.existsSync(entry)) {
    sendEvent({ type: 'process_exit', code: null, message: `Backend entry point not found: ${entry}` });
    return;
  }
  worker = spawn(pythonExecutable(), [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });

  const consume = (stream) => {
    readline.createInterface({ input: stream }).on('line', (line) => {
      const value = line.trim();
      if (!value) return;
      if (value.startsWith(EVENT_PREFIX)) {
        try {
          sendEvent(JSON.parse(value.slice(EVENT_PREFIX.length)));
        } catch (error) {
          sendEvent({ type: 'log', level: 'ERROR', message: `Invalid backend event: ${error.message}` });
        }
        return;
      }
      sendEvent({ type: 'log', level: 'INFO', message: value.replace(/^\r+/, '') });
    });
  };
  consume(worker.stdout);
  consume(worker.stderr);

  worker.once('error', (error) => {
    sendEvent({ type: 'process_exit', code: null, message: error.message });
  });
  worker.once('close', (code) => {
    sendEvent({ type: 'process_exit', code });
    worker = null;
  });
}

const DEFAULT_WINDOW_WIDTH = 1180;
const DEFAULT_WINDOW_HEIGHT = 780;

function initialBounds() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const winWidth = Math.min(DEFAULT_WINDOW_WIDTH, width);
  const winHeight = Math.min(DEFAULT_WINDOW_HEIGHT, height);
  return {
    width: winWidth,
    height: winHeight,
    x: x + Math.round((width - winWidth) / 2),
    y: y + Math.round((height - winHeight) / 2),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Bilibili Video Downloader',
    ...initialBounds(),
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#f5f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
}

ipcMain.handle('dialog:select-links', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Link List File',
    properties: ['openFile'],
    filters: [{ name: 'Link list', extensions: ['txt', 'csv'] }],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('dialog:select-cookies', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Cookies File',
    properties: ['openFile'],
    filters: [{ name: 'Cookies', extensions: ['txt'] }],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('dialog:select-output', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Output Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('shell:open-folder', async (_event, outputPath) => {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    return 'Invalid path.';
  }
  const result = await shell.openPath(path.dirname(outputPath));
  return result || null;
});

ipcMain.on('backend:command', (_event, command) => {
  sendCommand(command);
});

app.whenReady().then(() => {
  startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (worker) worker.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
