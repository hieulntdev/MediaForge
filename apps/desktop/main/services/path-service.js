'use strict';

const fs = require('node:fs');
const path = require('node:path');

class PathService {
  constructor({ projectRoot, userDataPath }) {
    this.projectRoot = path.resolve(projectRoot);
    this.userData = path.resolve(userDataPath);
    this.config = path.join(this.userData, 'config');
    this.logs = path.join(this.userData, 'logs');
    this.cache = path.join(this.userData, 'cache');
    this.models = path.join(this.userData, 'models');
    this.temp = path.join(this.userData, 'temp');
    this.tasks = path.join(this.userData, 'tasks');
    this.outputs = path.join(this.userData, 'outputs');
  }

  ensure() {
    for (const directory of [
      this.userData, this.config, this.logs, this.cache,
      this.models, this.temp, this.tasks, this.outputs
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  resetSessionData() {
    // These directories contain only app-owned cache/task scratch data. Keep
    // config, logs, models, outputs, and user-selected sources untouched.
    for (const directory of [this.cache, this.temp, this.tasks]) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  taskWorkspace(taskId) {
    if (!/^[A-Za-z0-9-]+$/.test(String(taskId))) throw new TypeError('Invalid task id.');
    return path.join(this.tasks, String(taskId));
  }
}

module.exports = { PathService };

