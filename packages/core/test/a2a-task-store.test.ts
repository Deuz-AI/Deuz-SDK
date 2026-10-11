/**
 * `@deuz-sdk/core/a2a` (2.3) — the task store contract, run against the
 * default in-memory store and against a key-value store of JSON strings
 * keyed by scope and task id, the durable store the A2A docs show. The
 * handler does no ownership check of its own, so tenant and owner isolation
 * hold only for a store that passes it.
 */
import {
  createInMemoryA2ATaskStore,
  type A2ATask,
  type A2ATaskScope,
  type A2ATaskStore,
} from '../src/a2a';
import { a2aTaskStoreContracts } from './fixtures/a2a-task-store-conformance';

a2aTaskStoreContracts('createInMemoryA2ATaskStore', () => createInMemoryA2ATaskStore());

function keyValueTaskStore(): A2ATaskStore {
  const kv = new Map<string, string>();
  const key = (taskId: string, scope: A2ATaskScope) =>
    JSON.stringify([scope.tenant ?? null, scope.owner ?? null, taskId]);
  return {
    load: async (taskId, scope) => {
      const json = kv.get(key(taskId, scope));
      return json === undefined ? undefined : (JSON.parse(json) as A2ATask);
    },
    save: async (task, scope) => {
      kv.set(key(task.id, scope), JSON.stringify(task));
    },
  };
}

a2aTaskStoreContracts('a key-value store keyed by scope and task id', keyValueTaskStore);
