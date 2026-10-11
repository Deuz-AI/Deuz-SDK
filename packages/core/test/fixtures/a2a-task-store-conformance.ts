import { describe, expect, it } from 'vitest';
import type { A2ATask, A2ATaskScope, A2ATaskStore } from '../../src/a2a';

const ALICE_AT_ACME: A2ATaskScope = { tenant: 'acme', owner: 'alice' };

/**
 * Scopes a handler can hand a store, all different. The last six run
 * together when a key joins the parts with a separator or leaves one out.
 */
const SCOPES: readonly A2ATaskScope[] = [
  {},
  { tenant: 'acme' },
  { owner: 'acme' },
  ALICE_AT_ACME,
  { tenant: 'acme', owner: 'bob' },
  { tenant: 'globex', owner: 'alice' },
  { tenant: 'a', owner: 'b:c' },
  { tenant: 'a:b', owner: 'c' },
  { tenant: 'a', owner: 'b/c' },
  { tenant: 'a/b', owner: 'c' },
  { tenant: 'null' },
  { owner: 'undefined' },
];

/** The same task id under every scope; the context id says whose task it is. */
function taskIn(scope: A2ATaskScope): A2ATask {
  return {
    id: 'task-1',
    contextId: `context of ${JSON.stringify(scope)}`,
    status: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: '2026-10-10T10:00:00.000Z' },
    artifacts: [],
    history: [{ messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'weather?' }] }],
  };
}

/**
 * The A2A task store contract (2.3): what `createA2AHandler` relies on. A
 * store returns the task last saved under a task id and a scope, and
 * `undefined` for any other pair: tenant and owner isolation rest on it, as
 * the handler does no ownership check of its own. Run it against your own
 * store:
 *
 * ```ts
 * a2aTaskStoreContracts('my store', () => createMyTaskStore());
 * ```
 */
export function a2aTaskStoreContracts(
  name: string,
  make: () => A2ATaskStore | Promise<A2ATaskStore>,
): void {
  describe(name, () => {
    it('returns the task last saved, and undefined for an unknown one', async () => {
      const store = await make();
      expect(await store.load('task-1', ALICE_AT_ACME)).toBeUndefined();
      const waiting = taskIn(ALICE_AT_ACME);
      await store.save(waiting, ALICE_AT_ACME);
      expect(await store.load('task-1', ALICE_AT_ACME)).toEqual(waiting);
      const done: A2ATask = { ...waiting, status: { state: 'TASK_STATE_COMPLETED' } };
      await store.save(done, ALICE_AT_ACME);
      expect(await store.load('task-1', ALICE_AT_ACME)).toEqual(done);
      expect(await store.load('task-2', ALICE_AT_ACME)).toBeUndefined();
    });

    it('finds a task only under the scope it was saved with', async () => {
      const store = await make();
      await store.save(taskIn(ALICE_AT_ACME), ALICE_AT_ACME);
      for (const scope of SCOPES) {
        if (scope === ALICE_AT_ACME) continue;
        expect(await store.load('task-1', scope), JSON.stringify(scope)).toBeUndefined();
      }
    });

    it('keeps the task of every scope apart, under one task id', async () => {
      const store = await make();
      for (const scope of SCOPES) await store.save(taskIn(scope), scope);
      for (const scope of SCOPES) {
        expect(await store.load('task-1', scope), JSON.stringify(scope)).toEqual(taskIn(scope));
      }
    });
  });
}
