'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveBackendLaunch({ projectRoot, env = process.env, platform = process.platform }) {
  const configured = env.SFX_CONVERTER_PYTHON;
  const venvPython = path.join(projectRoot, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (configured) return { executable: configured, args: ['-u', '-m', 'app.backend'], cwd: projectRoot };
  if (fs.existsSync(venvPython)) return { executable: venvPython, args: ['-u', '-m', 'app.backend'], cwd: projectRoot };

  throw new Error(
    `Python environment not found at ${venvPython}. Run ./scripts/setup.sh, ` +
    'or set SFX_CONVERTER_PYTHON to a Python 3.10-3.12 executable with the project dependencies installed.'
  );
}

module.exports = { resolveBackendLaunch };
