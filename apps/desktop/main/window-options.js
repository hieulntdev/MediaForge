'use strict';

const path = require('node:path');

// Audited at the integrated viewport for Bili Downloader, SFX Converter, and
// SRT-to-Speech. Their narrow layouts scroll vertically without overlapping at
// this native window size, including the operating-system title bar.
const WINDOW_METRICS = Object.freeze({
  defaultWidth: 1180,
  defaultHeight: 780,
  minWidth: 900,
  minHeight: 650
});

function validateWorkArea(workArea) {
  if (!workArea || !Number.isFinite(workArea.x) || !Number.isFinite(workArea.y)
    || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)
    || workArea.width <= 0 || workArea.height <= 0) {
    throw new TypeError('A valid display work area is required.');
  }
}

function initialWindowBounds(workArea) {
  validateWorkArea(workArea);
  const width = Math.max(WINDOW_METRICS.minWidth, Math.min(WINDOW_METRICS.defaultWidth, Math.round(workArea.width)));
  const height = Math.max(WINDOW_METRICS.minHeight, Math.min(WINDOW_METRICS.defaultHeight, Math.round(workArea.height)));
  return {
    x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
    width,
    height
  };
}

function createWindowOptions(theme = 'light', workArea = null) {
  const bounds = workArea
    ? initialWindowBounds(workArea)
    : { width: WINDOW_METRICS.defaultWidth, height: WINDOW_METRICS.defaultHeight };
  return {
    title: 'MediaForge',
    ...bounds,
    minWidth: WINDOW_METRICS.minWidth,
    minHeight: WINDOW_METRICS.minHeight,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    movable: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: theme === 'dark' ? '#1d1d1f' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--mediaforge-theme=${theme === 'dark' ? 'dark' : 'light'}`]
    }
  };
}

module.exports = { WINDOW_METRICS, createWindowOptions, initialWindowBounds };
