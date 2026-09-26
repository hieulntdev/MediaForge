'use strict';

const fs = require('node:fs');
const path = require('node:path');

class SettingsStore {
  constructor(configDirectory) {
    this.filePath = path.join(configDirectory, 'settings.json');
    this.values = { theme: 'light' };
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (saved && (saved.theme === 'light' || saved.theme === 'dark')) {
        this.values.theme = saved.theme;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Could not read MediaForge settings:', error.message);
    }
  }

  get() {
    return { ...this.values };
  }

  set(values) {
    if (values && (values.theme === 'light' || values.theme === 'dark')) {
      this.values.theme = values.theme;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const partial = `${this.filePath}.part`;
      fs.writeFileSync(partial, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(partial, this.filePath);
    }
    return this.get();
  }
}

module.exports = { SettingsStore };

