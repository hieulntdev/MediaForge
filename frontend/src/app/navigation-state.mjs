export const TERMINAL_TASK_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function hasActiveModuleTasks(tasks, moduleId) {
  const values = tasks instanceof Map ? tasks.values() : tasks;
  return [...values].some((task) => (
    task.module === moduleId && !TERMINAL_TASK_STATES.has(task.state)
  ));
}

export function shouldBlockModuleNavigation({ currentModuleId, targetModuleId, tasks, snapshotAvailable = true }) {
  if (currentModuleId !== 'bili_downloader' || targetModuleId === currentModuleId) return false;
  if (!snapshotAvailable) return true;
  return hasActiveModuleTasks(tasks, currentModuleId);
}
