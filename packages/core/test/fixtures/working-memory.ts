/**
 * A literal working memory snapshot (2.4) with a task list and an active
 * task, for the run store tests: it does not go through createWorkingMemory.
 */
import type { WorkingMemorySnapshot } from '../../src/context/working-memory/types';

export function createWorkingMemoryFixture(
  overrides: Partial<WorkingMemorySnapshot> = {},
): WorkingMemorySnapshot {
  return {
    kind: 'deuz-working-memory',
    version: 1,
    revision: 3,
    scope: 'tenant',
    goal: { text: 'Ship the release', writer: 'host', revision: 0, at: 1_000 },
    constraints: [
      { id: 'constraints-0-0', text: 'No force pushes', writer: 'host', revision: 0, at: 1_000 },
    ],
    tasks: {
      list: {
        goal: 'Ship the release',
        tasks: [
          { id: 't1', title: 'Build', status: 'done' },
          { id: 't2', title: 'Publish', status: 'in_progress' },
        ],
      },
      listRevision: 2,
      activeTaskId: 't2',
    },
    observations: [
      { id: 'observations-1-0', text: 'CI is green', writer: 'model', revision: 1, at: 2_000 },
    ],
    hypotheses: [
      {
        id: 'hypotheses-2-0',
        text: 'The registry is slow',
        writer: 'model',
        revision: 2,
        at: 3_000,
        status: 'proposed',
      },
    ],
    decisions: [],
    questions: [],
    attempts: [],
    applied: ['op-1', 'op-2', 'op-3'],
    createdAt: 1_000,
    updatedAt: 3_000,
    ...overrides,
  };
}
