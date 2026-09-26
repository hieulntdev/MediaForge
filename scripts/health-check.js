'use strict';

const path = require('node:path');
const { FFmpegLocator, FFprobeLocator } = require('../apps/desktop/main/services/executable-locator');
const { ModuleRegistry } = require('../apps/desktop/main/services/module-registry');
const { RuntimeResolver } = require('../apps/desktop/main/services/runtime-resolver');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const registry = new ModuleRegistry({ modulesRoot: path.join(projectRoot, 'backend', 'mediaforge', 'modules'), projectRoot });
  const modules = registry.discover();
  const runtimes = await new RuntimeResolver({ projectRoot }).healthAll();
  const executables = await Promise.all([new FFmpegLocator().health(), new FFprobeLocator().health()]);
  console.log(JSON.stringify({ modules, runtimes, executables }, null, 2));
  if ([...runtimes, ...executables].some((item) => !item.ok)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

