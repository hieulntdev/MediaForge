import { applyTheme, initializeTheme, toggleTheme } from '../core/theme.js';

const state = { modules: [], filter: '', activeModule: null, health: null };
const elements = {
  dashboard: document.querySelector('#dashboard-view'), moduleView: document.querySelector('#module-view'),
  moduleList: document.querySelector('#module-list'), moduleEmpty: document.querySelector('#module-empty'),
  moduleNavigation: document.querySelector('#module-navigation'), moduleSearch: document.querySelector('#module-search'),
  globalSearch: document.querySelector('#global-search'), themeToggle: document.querySelector('#theme-toggle'),
  runtimeStatus: document.querySelector('#runtime-status'), clock: document.querySelector('#dashboard-clock'),
  frame: document.querySelector('#module-frame'), backButton: document.querySelector('#back-button'),
  moduleTitle: document.querySelector('#module-view-title'), moduleDescription: document.querySelector('#module-view-description')
};

function iconMarkup() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h3l2-7 3 14 3-10 2 6h3"></path></svg>';
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  elements.themeToggle.setAttribute('aria-label', label);
  elements.themeToggle.title = label;
  const frameRoot = elements.frame.contentDocument?.documentElement;
  if (frameRoot) frameRoot.dataset.theme = dark ? 'dark' : 'light';
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
  icon.innerHTML = iconMarkup();
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
  open.addEventListener('click', () => openModule(module));
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
    link.innerHTML = `${iconMarkup()}<span></span>`; link.querySelector('span').textContent = module.displayName;
    link.addEventListener('click', (event) => { event.preventDefault(); openModule(module); });
    elements.moduleNavigation.append(link);
  }
}

function setNavigation(moduleId = null) {
  document.querySelector('[data-route="dashboard"]').classList.toggle('is-active', !moduleId);
  for (const link of elements.moduleNavigation.querySelectorAll('.nav-item')) link.classList.toggle('is-active', link.dataset.module === moduleId);
}

async function openModule(module) {
  state.activeModule = module;
  elements.dashboard.hidden = true;
  elements.moduleView.hidden = false;
  elements.moduleTitle.textContent = module.displayName;
  elements.moduleDescription.textContent = module.description;
  elements.frame.title = `${module.displayName} module`;
  elements.frame.srcdoc = await window.mediaForge.loadModuleView(module.id);
  elements.frame.addEventListener('load', updateThemeButton, { once: true });
  setNavigation(module.id);
  history.replaceState(null, '', `#/modules/${module.frontendRoute}`);
}

function showDashboard() {
  state.activeModule = null;
  elements.frame.removeAttribute('srcdoc');
  elements.moduleView.hidden = true;
  elements.dashboard.hidden = false;
  setNavigation();
  history.replaceState(null, '', '#/dashboard');
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
elements.backButton.addEventListener('click', showDashboard);
document.querySelector('[data-route="dashboard"]').addEventListener('click', (event) => { event.preventDefault(); showDashboard(); });
for (const input of [elements.moduleSearch, elements.globalSearch]) {
  input.addEventListener('input', () => {
    state.filter = input.value;
    elements.moduleSearch.value = state.filter;
    elements.globalSearch.value = state.filter;
    if (state.activeModule) showDashboard();
    renderModules();
  });
}

try {
  state.modules = await window.mediaForge.listModules();
  renderNavigation(); renderModules();
  const route = location.hash.match(/^#\/modules\/(.+)$/)?.[1];
  const module = state.modules.find((item) => item.frontendRoute === route);
  if (module) await openModule(module); else showDashboard();
  void loadHealth();
} catch (error) {
  elements.moduleList.replaceChildren();
  elements.moduleEmpty.hidden = false;
  elements.moduleEmpty.textContent = `Unable to load modules: ${error.message}`;
}

export { openModule, renderModules, showDashboard };
