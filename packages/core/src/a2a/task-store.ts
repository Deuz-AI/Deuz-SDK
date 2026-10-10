/**
 * a2a/task-store.ts — the default `A2ATaskStore` (2.3).
 */
import type { A2ATask, A2ATaskScope, A2ATaskStore } from './types';

/**
 * Tasks in a `Map`, per tenant. Tasks are copied on the way in and out, so
 * nothing outside the store can change a stored task. Lives as long as the
 * process (or isolate) and keeps every task: use it for development, tests and
 * single-process agents, and bring a durable `A2ATaskStore` when tasks must
 * survive a restart or be shared by several instances.
 */
export function createInMemoryA2ATaskStore(): A2ATaskStore {
  const tasks = new Map<string, A2ATask>();
  const keyOf = (taskId: string, scope: A2ATaskScope) =>
    JSON.stringify([scope.tenant ?? null, taskId]);
  return {
    load(taskId, scope) {
      const task = tasks.get(keyOf(taskId, scope));
      return task === undefined ? undefined : structuredClone(task);
    },
    save(task, scope) {
      tasks.set(keyOf(task.id, scope), structuredClone(task));
    },
  };
}
