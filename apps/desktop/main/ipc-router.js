'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ipcMain } = require('electron');
const CHANNELS = require('../shared/channels');

function readLocalAsset(entryPath, reference) {
  const root = path.dirname(entryPath);
  const assetPath = path.resolve(root, reference.split(/[?#]/, 1)[0]);
  const relative = path.relative(root, assetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Module asset escapes its UI directory: ${reference}`);
  return fs.readFileSync(assetPath, 'utf8');
}

function bundleModuleView(manifest) {
  const nonce = 'mediaforge-module';
  let source = fs.readFileSync(manifest.uiEntry, 'utf8');
  const deferredScripts = [];
  source = source.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
  source = source.replace(/<link\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi, (tag, before, href) => {
    if (!/\brel=["']stylesheet["']/i.test(tag)) return tag;
    return `<style nonce="${nonce}" data-mediaforge-asset="${href}">${readLocalAsset(manifest.uiEntry, href)}</style>`;
  });
  source = source.replace(/<script\b([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, before, src, after) => {
    const attributes = `${before} ${after}`;
    const script = `<script nonce="${nonce}" data-mediaforge-asset="${src}">${readLocalAsset(manifest.uiEntry, src)}</script>`;
    if (/\bdefer\b/i.test(attributes)) { deferredScripts.push(script); return ''; }
    return script;
  });
  if (deferredScripts.length) source = source.replace(/<\/body>/i, `${deferredScripts.join('\n')}</body>`);
  source = source.replace(/<script(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
  const base = `${pathToFileURL(path.dirname(manifest.uiEntry)).href}/`;
  const bridgeName = JSON.stringify(manifest.ui.bridge);
  // Module renderers also run as standalone windows, where their document
  // minimums mirror the native BrowserWindow minimum. Inside MediaForge the
  // iframe is necessarily narrower, so let the existing responsive rules use
  // its real viewport instead of forcing a clipped 900px document.
  const bridge = `<style nonce="${nonce}">html,body{min-width:0!important;min-height:0!important}#theme-toggle{display:none!important}</style><script nonce="${nonce}">window.mediaForge=parent.mediaForge;window.desktopAPI=parent[${bridgeName}];window.sfxApi=parent[${bridgeName}];window[${bridgeName}]=parent[${bridgeName}];</script>`;
  return source.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">${bridge}`);
}

function registerIpcRouter({ getWindow, registry, moduleManager, taskManager, settings, dialogService, healthCheck }) {
  ipcMain.handle(CHANNELS.MODULES_LIST, () => registry.list());
  ipcMain.handle(CHANNELS.MODULE_VIEW, (_event, moduleId) => {
    const manifest = registry.get(String(moduleId));
    return bundleModuleView(manifest);
  });
  ipcMain.handle(CHANNELS.MODULE_EXECUTE, (_event, request) => {
    if (!request || typeof request.module !== 'string' || typeof request.action !== 'string') throw new TypeError('Invalid module request.');
    return moduleManager.execute(request.module, request.action, request.payload || {});
  });
  ipcMain.handle(CHANNELS.MODULE_RESET, async (_event, moduleId) => {
    const manifest = registry.get(String(moduleId));
    if (moduleManager.isActive(manifest.id)) {
      return { reset: false, busy: true, message: 'Cannot reset this module while it is processing.' };
    }
    if (!await dialogService.confirmModuleReset()) return { reset: false, cancelled: true };
    if (moduleManager.isActive(manifest.id)) {
      return { reset: false, busy: true, message: 'Cannot reset this module while it is processing.' };
    }
    return moduleManager.reset(manifest.id);
  });
  ipcMain.handle(CHANNELS.TASKS_LIST, () => taskManager.list());
  ipcMain.handle(CHANNELS.TASK_CANCEL, (_event, taskId) => moduleManager.control(String(taskId), 'cancel'));
  ipcMain.handle(CHANNELS.TASK_PAUSE, (_event, taskId) => moduleManager.control(String(taskId), 'pause'));
  ipcMain.handle(CHANNELS.TASK_RESUME, (_event, taskId) => moduleManager.control(String(taskId), 'resume'));
  ipcMain.handle(CHANNELS.HEALTH_GET, () => healthCheck());
  ipcMain.handle(CHANNELS.DIALOG_OPEN, (_event, request) => dialogService.open(request));
  ipcMain.handle(CHANNELS.SHELL_OPEN_PATH, (_event, target, revealParent) => dialogService.openPath(target, revealParent));
  ipcMain.handle(CHANNELS.SETTINGS_GET, () => settings.get());
  ipcMain.handle(CHANNELS.SETTINGS_SET, (_event, values) => settings.set(values));

  taskManager.on('event', (payload) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.TASK_EVENT, payload);
  });
  moduleManager.on('module-event', (payload) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.MODULE_EVENT, payload);
  });
}

module.exports = { bundleModuleView, readLocalAsset, registerIpcRouter };
