export const TERMINAL_TASK_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
export const NAVIGATION_LOCK_MODULE_IDS = new Set(['bili_downloader', 'hongguo_downloader']);

export function hasActiveModuleTasks(tasks, moduleId) {
  const values = tasks instanceof Map ? tasks.values() : tasks;
  return [...values].some((task) => (
    task.module === moduleId && !TERMINAL_TASK_STATES.has(task.state)
  ));
}

export function moduleUsesNavigationLock(moduleId) {
  return NAVIGATION_LOCK_MODULE_IDS.has(moduleId);
}

export function shouldBlockModuleNavigation({ currentModuleId, targetModuleId, tasks, snapshotAvailable = true }) {
  if (!moduleUsesNavigationLock(currentModuleId) || targetModuleId === currentModuleId) return false;
  if (!snapshotAvailable) return true;
  return hasActiveModuleTasks(tasks, currentModuleId);
}
