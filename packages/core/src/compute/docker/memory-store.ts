/**
 * The in-memory `ProcessOperationStore` (2.4): one process, tests, and hosts
 * that accept losing the records with the process (a restarted host then
 * finds every container an orphan).
 */
import { resolveDependencies } from '../../internal/resolve-deps';
import type { Dependencies } from '../../types/deps';
import {
  applyChanges,
  assertNewRecord,
  cloneRecord,
  compareRecords,
  initialRecord,
  operationConflict,
  pageRecords,
  resolveQuery,
  TERMINAL_PROCESS_STATES,
} from './store-shared';
import type { ProcessOperationRecord, ProcessOperationStore } from './types';

const key = (scope: string, operationId: string) => JSON.stringify([scope, operationId]);

export function createInMemoryProcessOperationStore(
  options: { deps?: Dependencies } = {},
): ProcessOperationStore {
  const { clock } = resolveDependencies(options.deps);
  const records = new Map<string, ProcessOperationRecord>();

  return {
    async create(record) {
      assertNewRecord(record);
      const stored = records.get(key(record.scope, record.operationId));
      if (stored) {
        if (stored.requestDigest !== record.requestDigest)
          throw operationConflict(stored, record.requestDigest);
        return { status: 'existing', record: cloneRecord(stored) };
      }
      const created = initialRecord(record, clock.now());
      records.set(key(record.scope, record.operationId), created);
      return { status: 'created', record: cloneRecord(created) };
    },

    async get(scope, operationId) {
      const stored = records.get(key(scope, operationId));
      return stored ? cloneRecord(stored) : undefined;
    },

    async update(scope, operationId, changes, { expectedRevision }) {
      const stored = records.get(key(scope, operationId));
      if (!stored) return { status: 'conflict' };
      if (stored.revision !== expectedRevision)
        return { status: 'conflict', record: cloneRecord(stored) };
      const next = applyChanges(stored, changes, clock.now());
      records.set(key(scope, operationId), next);
      return { status: 'committed', record: cloneRecord(next) };
    },

    async list(query) {
      const resolved = resolveQuery(query);
      return pageRecords([...records.values()].sort(compareRecords), resolved);
    },

    async prune({ terminalBefore }) {
      let removed = 0;
      for (const [id, record] of records) {
        if (TERMINAL_PROCESS_STATES.has(record.state) && record.updatedAt < terminalBefore) {
          records.delete(id);
          removed++;
        }
      }
      return removed;
    },

    async close() {},
  };
}
