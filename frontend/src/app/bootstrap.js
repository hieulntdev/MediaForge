import { applyTheme, initializeTheme, toggleTheme } from '../core/theme.js';
import {
  hasActiveModuleTasks,
  moduleUsesNavigationLock,
  shouldBlockModuleNavigation,
} from './navigation-state.mjs';
import { moduleIconMarkup } from './module-icons.mjs';
import { clearAllModuleSessionStorage, clearModuleStorage } from './module-reset.mjs';

clearAllModuleSessionStorage();

const NAVIGATION_BLOCKED_MESSAGES = Object.freeze({
  bili_downloader: 'Downloads are in progress. Please wait until all active downloads are finished before switching modules.',
  hongguo_downloader: 'Cannot switch modules while Hongguo Downloader is processing.',
});
const state = {
  modules: [], filter: '', activeModule: null, health: null,
  tasks: new Map(), moduleFrames: new Map(),
};
const elements = {
  dashboard: document.querySelector('#dashboard-view'), moduleView: document.querySelector('#module-view'),
  moduleList: document.querySelector('#module-list'), moduleEmpty: document.querySelector('#module-empty'),
  moduleNavigation: document.querySelector('#module-navigation'), moduleSearch: document.querySelector('#module-search'),
  globalSearch: document.querySelector('#global-search'), themeToggle: document.querySelector('#theme-toggle'),
  runtimeStatus: document.querySelector('#runtime-status'), clock: document.querySelector('#dashboard-clock'),
  appVersion: document.querySelector('#app-version'),
  frameHost: document.querySelector('#module-frame-host'), frame: document.querySelector('#module-frame'),
  backButton: document.querySelector('#back-button'),
  resetButton: document.querySelector('#reset-module-button'),
  moduleTitle: document.querySelector('#module-view-title'), moduleDescription: document.querySelector('#module-view-description'),
  navigationNotice: document.querySelector('#navigation-notice')
};

function displayVersion(version) {
  return String(version).replace(/\.0$/, '');
}

elements.appVersion.textContent = `v${displayVersion(window.mediaForge.appVersion)}`;

function activeModuleLocksNavigation() {
  const moduleId = state.activeModule?.id;
  return moduleUsesNavigationLock(moduleId) && hasActiveModuleTasks(state.tasks, moduleId);
}

function activeModuleIsBusy() {
  return Boolean(state.activeModule && hasActiveModuleTasks(state.tasks, state.activeModule.id));
}

let noticeTimer = null;
function showNotice(message) {
  elements.navigationNotice.textContent = message;
  elements.navigationNotice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { elements.navigationNotice.hidden = true; }, 4000);
}

function showNavigationBlockedNotice(moduleId = state.activeModule?.id) {
  showNotice(NAVIGATION_BLOCKED_MESSAGES[moduleId]
    || 'This action is unavailable while the module is processing.');
}

function updateNavigationLock() {
  const locked = activeModuleLocksNavigation();
  elements.backButton.disabled = locked;
  const dashboardLink = document.querySelector('[data-route="dashboard"]');
  dashboardLink.setAttribute('aria-disabled', String(locked));
  for (const link of elements.moduleNavigation.querySelectorAll('.nav-item')) {
    const disabled = locked && link.dataset.module !== state.activeModule?.id;
    link.setAttribute('aria-disabled', String(disabled));
  }
  elements.resetButton.disabled = !state.activeModule || activeModuleIsBusy();
  elements.resetButton.title = activeModuleIsBusy()
    ? 'Clear is unavailable while this module is processing.'
    : 'Clear this module and restore its default settings.';
}

async function refreshTasks() {
  const tasks = await window.mediaForge.listTasks();
  state.tasks = new Map(tasks.map((task) => [task.id, task]));
  updateNavigationLock();
}

function restoreActiveHash() {
  const hash = state.activeModule
    ? `#/modules/${state.activeModule.frontendRoute}`
    : '#/dashboard';
  history.replaceState(null, '', hash);
}

async function navigationIsBlocked(targetModuleId = null) {
  const currentModuleId = state.activeModule?.id;
  if (!moduleUsesNavigationLock(currentModuleId) || targetModuleId === currentModuleId) return false;
  try {
    await refreshTasks();
  } catch {
    // Fail closed while leaving a guarded module: an unavailable snapshot
    // must not be interpreted as proof that its background work has finished.
    showNavigationBlockedNotice(currentModuleId);
    return true;
  }
  if (!shouldBlockModuleNavigation({
    currentModuleId,
    targetModuleId,
    tasks: state.tasks,
  })) return false;
  showNavigationBlockedNotice(currentModuleId);
  return true;
}

function updateFrameThemes() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  for (const frame of state.moduleFrames.values()) {
    const frameRoot = frame.contentDocument?.documentElement;
    if (frameRoot) frameRoot.dataset.theme = theme;
  }
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  elements.themeToggle.setAttribute('aria-label', label);
  elements.themeToggle.title = label;
  updateFrameThemes();
}

function frameFor(module) {
  if (state.moduleFrames.has(module.id)) return state.moduleFrames.get(module.id);
  const frame = state.moduleFrames.size === 0
    ? elements.frame
    : document.createElement('iframe');
  frame.id = `module-frame-${module.id}`;
  frame.className = 'module-frame';
  frame.title = `${module.displayName} module`;
  frame.hidden = true;
  if (state.moduleFrames.size !== 0) elements.frameHost.append(frame);
  state.moduleFrames.set(module.id, frame);
  return frame;
}

async function reloadModuleFrame(module) {
  const current = state.moduleFrames.get(module.id);
  if (!current) return;
  const frame = document.createElement('iframe');
  frame.id = current.id;
  frame.className = 'module-frame';
  frame.title = `${module.displayName} module`;
  frame.hidden = state.activeModule?.id !== module.id;
  current.replaceWith(frame);
  if (elements.frame === current) elements.frame = frame;
  state.moduleFrames.set(module.id, frame);
  frame.addEventListener('load', updateThemeButton, { once: true });
  frame.srcdoc = await window.mediaForge.loadModuleView(module.id);
}

async function resetActiveModule() {
  const module = state.activeModule;
  if (!module) return;
  try {
    await refreshTasks();
    if (hasActiveModuleTasks(state.tasks, module.id)) {
      showNotice('Clear is unavailable while this module is processing.');
      return;
    }
    elements.resetButton.disabled = true;
    elements.resetButton.setAttribute('aria-busy', 'true');
    const result = await window.mediaForge.resetModule(module.id);
    if (!result?.reset) {
      if (result?.busy) showNotice(result.message || 'Clear is unavailable while this module is processing.');
      return;
    }
    clearModuleStorage(module.id, { includePreferences: true });
    await refreshTasks();
    await reloadModuleFrame(module);
    showNotice(`${module.displayName} was reset to its default state.`);
  } catch (error) {
    showNotice(error.message || 'Unable to reset this module.');
  } finally {
    elements.resetButton.removeAttribute('aria-busy');
    updateNavigationLock();
  }
}

function moduleRow(module) {
  const row = document.createElement('article');
  row.className = 'module-row';
  row.dataset.module = module.id;
  const identity = document.createElement('div');
  identity.className = 'module-identity';
  const icon = document.createElement('div');
  icon.className = 'module-icon';
  icon.dataset.accent = module.accent;
  icon.innerHTML = moduleIconMarkup(module.id);
  const copy = document.createElement('div');
  copy.className = 'module-copy';
  const title = document.createElement('h3'); title.textContent = module.displayName;
  const description = document.createElement('p'); description.textContent = module.description; description.title = module.description;
  copy.append(title, description); identity.append(icon, copy);
  const runtime = document.createElement('div'); runtime.className = 'module-meta module-runtime'; runtime.textContent = 'Runtime';
  const runtimeValue = document.createElement('strong'); runtimeValue.textContent = module.runtime; runtime.append(runtimeValue);
  const version = document.createElement('div'); version.className = 'module-meta'; version.textContent = 'Version';
  const versionValue = document.createElement('strong'); versionValue.textContent = `v${module.version}`; version.append(versionValue);
  const actions = document.createElement('div'); actions.className = 'module-actions';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'button button-secondary'; open.textContent = 'Open';
  open.addEventListener('click', () => { void openModule(module); });
  actions.append(open); row.append(identity, runtime, version, actions);
  return row;
}

function renderModules() {
  const term = state.filter.trim().toLowerCase();
  const modules = state.modules.filter((module) => `${module.displayName} ${module.description} ${module.runtime}`.toLowerCase().includes(term));
  elements.moduleList.replaceChildren(...modules.map(moduleRow));
  elements.moduleEmpty.hidden = modules.length !== 0;
}

function renderNavigation() {
  elements.moduleNavigation.replaceChildren();
  for (const module of state.modules) {
    const link = document.createElement('a'); link.className = 'nav-item'; link.href = `#/modules/${module.frontendRoute}`; link.dataset.module = module.id;
    link.innerHTML = `${moduleIconMarkup(module.id)}<span></span>`; link.querySelector('span').textContent = module.displayName;
    link.addEventListener('click', (event) => { event.preventDefault(); void openModule(module); });
    elements.moduleNavigation.append(link);
  }
}

function setNavigation(moduleId = null) {
  document.querySelector('[data-route="dashboard"]').classList.toggle('is-active', !moduleId);
  for (const link of elements.moduleNavigation.querySelectorAll('.nav-item')) link.classList.toggle('is-active', link.dataset.module === moduleId);
}

async function openModule(module) {
  if (state.activeModule?.id === module.id) return true;
  if (await navigationIsBlocked(module.id)) { restoreActiveHash(); return false; }
  state.activeModule = module;
  elements.dashboard.hidden = true;
  elements.moduleView.hidden = false;
  elements.moduleTitle.textContent = module.displayName;
  elements.moduleDescription.textContent = module.description;
  for (const frame of state.moduleFrames.values()) frame.hidden = true;
  const frame = frameFor(module);
  frame.hidden = false;
  if (!frame.hasAttribute('srcdoc')) {
    frame.addEventListener('load', updateThemeButton, { once: true });
    frame.srcdoc = await window.mediaForge.loadModuleView(module.id);
  }
  setNavigation(module.id);
  history.replaceState(null, '', `#/modules/${module.frontendRoute}`);
  updateNavigationLock();
  return true;
}

async function showDashboard() {
  if (await navigationIsBlocked(null)) { restoreActiveHash(); return false; }
  state.activeModule = null;
  elements.moduleView.hidden = true;
  elements.dashboard.hidden = false;
  setNavigation();
  history.replaceState(null, '', '#/dashboard');
  updateNavigationLock();
  return true;
}

function updateClock() {
  const now = new Date();
  elements.clock.textContent = `${now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}\n${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

async function loadHealth() {
  try {
    state.health = await window.mediaForge.health();
    const all = [...state.health.runtimes, ...state.health.executables];
    const ready = all.filter((item) => item.ok).length;
    elements.runtimeStatus.textContent = ready === all.length ? `All ${ready} local dependencies ready.` : `${ready}/${all.length} local dependencies ready.`;
    elements.runtimeStatus.dataset.status = ready === all.length ? 'ready' : 'missing';
    elements.runtimeStatus.title = all.filter((item) => !item.ok).map((item) => `${item.id || item.name}: ${item.error}`).join('\n');
  } catch (error) {
    elements.runtimeStatus.textContent = 'Health check unavailable.';
    elements.runtimeStatus.dataset.status = 'error';
    elements.runtimeStatus.title = error.message;
  }
}

initializeTheme(); updateThemeButton(); updateClock(); setInterval(updateClock, 1000);
elements.themeToggle.addEventListener('click', () => { toggleTheme(); updateThemeButton(); });
elements.backButton.addEventListener('click', () => { void showDashboard(); });
elements.resetButton.addEventListener('click', () => { void resetActiveModule(); });
document.querySelector('[data-route="dashboard"]').addEventListener('click', (event) => { event.preventDefault(); void showDashboard(); });
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); void showDashboard(); });
for (const input of [elements.moduleSearch, elements.globalSearch]) {
  input.addEventListener('input', () => {
    state.filter = input.value;
    elements.moduleSearch.value = state.filter;
    elements.globalSearch.value = state.filter;
    if (state.activeModule) void showDashboard();
    renderModules();
  });
}

window.mediaForge.onTaskEvent((event) => {
  const task = event?.payload?.task;
  if (!task?.id) return;
  state.tasks.set(task.id, task);
  updateNavigationLock();
});

window.addEventListener('hashchange', () => {
  const route = location.hash.match(/^#\/modules\/(.+)$/)?.[1];
  const module = state.modules.find((item) => item.frontendRoute === route);
  if (module) void openModule(module);
  else void showDashboard();
});

try {
  state.modules = await window.mediaForge.listModules();
  await refreshTasks();
  renderNavigation(); renderModules();
  const route = location.hash.match(/^#\/modules\/(.+)$/)?.[1];
  const routedModule = state.modules.find((item) => item.frontendRoute === route);
  const activeLockedModule = (
    routedModule
    && moduleUsesNavigationLock(routedModule.id)
    && hasActiveModuleTasks(state.tasks, routedModule.id)
      ? routedModule
      : state.modules.find((item) => (
        moduleUsesNavigationLock(item.id) && hasActiveModuleTasks(state.tasks, item.id)
      ))
  );
  const module = activeLockedModule || routedModule;
  if (module) await openModule(module); else await showDashboard();
  void loadHealth();
} catch (error) {
  elements.moduleList.replaceChildren();
  elements.moduleEmpty.hidden = false;
  elements.moduleEmpty.textContent = `Unable to load modules: ${error.message}`;
}

export { openModule, renderModules, showDashboard };
