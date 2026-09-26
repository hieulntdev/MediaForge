'use strict';

const fs = require('node:fs');
const path = require('node:path');

class SettingsStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'settings.json');
    this.values = { theme: 'light' };
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (saved && (saved.theme === 'light' || saved.theme === 'dark')) this.values.theme = saved.theme;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not read settings:', error.message);
    }
  }

  get() {
    return { ...this.values };
  }

  set(nextValues) {
    if (nextValues && (nextValues.theme === 'light' || nextValues.theme === 'dark')) {
      this.values.theme = nextValues.theme;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.values, null, 2), 'utf8');
    }
    return this.get();
  }
}

module.exports = { SettingsStore };
