'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  outputDir: '', quality: 'best', concurrentDownloads: 3,
  segmentConcurrency: 8, maxRetries: 5, timeoutSeconds: 60,
  duplicateHandling: 'rename'
});

class HongguoStore {
  constructor(pathService) {
    this.legacyDirectory = path.join(pathService.userData, 'hongguo');
    this.legacyFilePath = path.join(this.legacyDirectory, 'state.json');
    this.configDirectory = path.join(pathService.config, 'hongguo-downloader');
    this.settingsPath = path.join(this.configDirectory, 'settings.json');
    this.directory = path.join(pathService.cache, 'hongguo-downloader');
    this.filePath = path.join(this.directory, 'session.json');
    this.partials = path.join(pathService.temp, 'hongguo-downloader', 'partials');
    this.migrateLegacySettings();
    fs.mkdirSync(this.partials, { recursive: true });
  }

  migrateLegacySettings() {
    if (fs.existsSync(this.settingsPath)) return;
    try {
      const legacy = JSON.parse(fs.readFileSync(this.legacyFilePath, 'utf8'));
      if (legacy?.settings && typeof legacy.settings === 'object') this.saveSettings(legacy.settings);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not migrate Hongguo settings:', error.message);
    }
  }

  loadSettings() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return { ...DEFAULT_SETTINGS, ...(saved || {}) };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not read Hongguo settings:', error.message);
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(settings) {
    fs.mkdirSync(this.configDirectory, { recursive: true });
    const partial = `${this.settingsPath}.part`;
    fs.writeFileSync(partial, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }, null, 2), 'utf8');
    fs.renameSync(partial, this.settingsPath);
  }

  load() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not read Hongguo state:', error.message);
    }
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    return {
      revision: Number(saved.revision) || 0,
      phase: 'idle', paused: false,
      settings: this.loadSettings(),
      series: Array.isArray(saved.series) ? saved.series : [],
      discovered: Array.isArray(saved.discovered) ? saved.discovered : [], jobs,
      logs: Array.isArray(saved.logs) ? saved.logs.slice(-500) : []
    };
  }

  save(snapshot) {
    this.saveSettings(snapshot.settings);
    fs.mkdirSync(this.directory, { recursive: true });
    const value = {
      schemaVersion: 1,
      revision: snapshot.revision,
      series: snapshot.series,
      discovered: snapshot.discovered,
      jobs: snapshot.jobs.map(({ mediaSource, settings, ...job }) => job),
      logs: snapshot.logs.slice(-500)
    };
    const partial = `${this.filePath}.part`;
    fs.writeFileSync(partial, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(partial, this.filePath);
  }

  removePartial(jobId) {
    const key = crypto.createHash('sha256').update(String(jobId)).digest('hex').slice(0, 20);
    fs.rmSync(path.join(this.partials, key), { recursive: true, force: true });
  }

  cleanupSession() {
    fs.rmSync(this.directory, { recursive: true, force: true });
    fs.rmSync(path.dirname(this.partials), { recursive: true, force: true });
    fs.rmSync(this.legacyDirectory, { recursive: true, force: true });
    fs.mkdirSync(this.partials, { recursive: true });
  }

  resetToDefaults(defaultOutputDir) {
    this.cleanupSession();
    const settings = { ...DEFAULT_SETTINGS, outputDir: defaultOutputDir || '' };
    this.saveSettings(settings);
    return settings;
  }
}

module.exports = { DEFAULT_SETTINGS, HongguoStore };
