import type {
  SwarmCommit,
  SwarmEvent,
  SwarmEventInput,
  SwarmKey,
  SwarmRunRecord,
  SwarmSnapshot,
  SwarmStore,
  SwarmTaskRecord,
} from '../types/swarm';

export class SwarmConflictError extends Error {
  constructor(message = 'Swarm revision conflict or run already exists') {
    super(message);
    this.name = 'SwarmConflictError';
  }
}

/** Persistence deliberately rejects values JSON would silently change. */
export function encodeSwarm(value: unknown): string {
  const encoded = JSON.stringify(value, function (key, item: unknown) {
    const original: unknown = (this as Record<string, unknown>)[key];
    if (original instanceof Uint8Array) {
      return { $deuzSwarmBytes: Array.from(original) };
    }
    if (
      original &&
      typeof original === 'object' &&
      !Array.isArray(original) &&
      Object.getPrototypeOf(original) !== Object.prototype &&
      Object.getPrototypeOf(original) !== null
    ) {
      throw new Error('Swarm state requires plain objects, arrays, or Uint8Array');
    }
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('Non-finite swarm value');
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
      throw new Error('Swarm state must be serializable');
    }
    if (item && typeof item === 'object' && '$deuzSwarmBytes' in item) {
      throw new Error('Reserved swarm serialization key');
    }
    return item;
  });
  if (encoded === undefined) throw new Error('Swarm state must be serializable');
  return encoded;
}

export function decodeSwarm<T>(value: string): T {
  return JSON.parse(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && '$deuzSwarmBytes' in item) {
      const bytes = (item as { $deuzSwarmBytes: unknown }).$deuzSwarmBytes;
      if (
        !Array.isArray(bytes) ||
        Object.keys(item).length !== 1 ||
        !bytes.every(
          (byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255,
        )
      ) {
        throw new Error('Corrupt swarm binary state');
      }
      return new Uint8Array(bytes);
    }
    return item;
  }) as T;
}

export function cloneSwarm<T>(value: T): T {
  return decodeSwarm<T>(encodeSwarm(value));
}

export function swarmKey(key: SwarmKey): string {
  return JSON.stringify([key.scope, key.runId]);
}

export function validateSwarmSnapshot(snapshot: SwarmSnapshot, key?: SwarmKey): void {
  const run = snapshot?.run;
  if (
    !run ||
    run.kind !== 'deuz-swarm' ||
    run.version !== 1 ||
    !run.scope ||
    !run.runId ||
    !Number.isSafeInteger(run.revision) ||
    run.revision < 0 ||
    !Number.isSafeInteger(run.lastSequence) ||
    run.lastSequence < 0 ||
    !['running', 'completed', 'partial', 'suspended', 'cancelled'].includes(run.status) ||
    typeof run.cancelRequested !== 'boolean' ||
    typeof run.definitionVersion !== 'string' ||
    !Number.isFinite(run.createdAt) ||
    !Number.isFinite(run.updatedAt) ||
    !Array.isArray(snapshot.tasks) ||
    (key && (run.scope !== key.scope || run.runId !== key.runId))
  ) {
    throw new Error('Invalid or unsupported swarm snapshot');
  }
  const ids = new Set<string>();
  for (const task of snapshot.tasks) {
    if (
      !task?.task?.id ||
      ids.has(task.task.id) ||
      !Number.isSafeInteger(task.attempt) ||
      task.attempt < 0 ||
      ![
        'pending',
        'running',
        'suspended',
        'completed',
        'failed',
        'blocked',
        'cancelled',
        'needs_reconciliation',
      ].includes(task.status) ||
      (task.status === 'completed' && !task.result)
    )
      throw new Error('Corrupt swarm task state');
    ids.add(task.task.id);
  }
}

export function nextSwarmRun(run: SwarmRunRecord, change: SwarmCommit): SwarmRunRecord {
  if (run.revision !== change.expectedRevision) throw new SwarmConflictError();
  const next = {
    ...run,
    ...change.run,
    revision: run.revision + 1,
    lastSequence: run.lastSequence + (change.events?.length ?? 0),
  };
  validateSwarmSnapshot({ run: next, tasks: [] }, run);
  return next;
}

export function validateTaskChange(
  previous: SwarmTaskRecord,
  next: SwarmTaskRecord,
  run: SwarmRunRecord,
): void {
  if (
    encodeSwarm(previous.task) !== encodeSwarm(next.task) ||
    previous.bindingVersion !== next.bindingVersion
  ) {
    throw new Error('Cannot modify a fixed swarm task definition');
  }
  validateSwarmSnapshot({ run, tasks: [next] });
}

export function makeSwarmEvents(
  key: SwarmKey,
  previous: number,
  inputs: readonly SwarmEventInput[],
): SwarmEvent[] {
  return inputs.map((event, index) => ({
    ...event,
    scope: key.scope,
    runId: key.runId,
    version: 1,
    sequence: previous + index + 1,
  }));
}

export function validateEventCursor(afterSequence: number, limit: number): void {
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new Error('Invalid swarm event cursor or page limit (1..1000)');
  }
}

/** In-process reference store with exactly the same CAS/atomicity contract as SQLite. */
export function createInMemorySwarmStore(): SwarmStore {
  const runs = new Map<
    string,
    { run: SwarmRunRecord; tasks: Map<string, SwarmTaskRecord>; events: SwarmEvent[] }
  >();
  return {
    async create(snapshot, inputs) {
      validateSwarmSnapshot(snapshot);
      if (snapshot.run.revision !== 0 || snapshot.run.lastSequence !== 0)
        throw new Error('New swarm counters must start at zero');
      const key = swarmKey(snapshot.run);
      if (runs.has(key)) throw new SwarmConflictError();
      const copy = cloneSwarm(snapshot);
      const events = cloneSwarm(makeSwarmEvents(copy.run, 0, inputs));
      copy.run.lastSequence = events.length;
      runs.set(key, {
        run: copy.run,
        tasks: new Map(copy.tasks.map((task) => [task.task.id, task])),
        events,
      });
      return cloneSwarm(copy.run);
    },
    async load(key) {
      const row = runs.get(swarmKey(key));
      return row ? cloneSwarm({ run: row.run, tasks: [...row.tasks.values()] }) : undefined;
    },
    async head(key) {
      const row = runs.get(swarmKey(key));
      return row ? cloneSwarm(row.run) : undefined;
    },
    async commit(change) {
      const row = runs.get(swarmKey(change));
      if (!row) throw new Error('Swarm run not found');
      const run = cloneSwarm(nextSwarmRun(row.run, change));
      const tasks = cloneSwarm(change.tasks ?? []);
      const events = cloneSwarm(makeSwarmEvents(change, row.run.lastSequence, change.events ?? []));
      for (const task of tasks) {
        if (!row.tasks.has(task.task.id)) throw new Error('Cannot add tasks to a fixed swarm DAG');
        validateTaskChange(row.tasks.get(task.task.id)!, task, run);
      }
      // All validation/serialization precedes the first mutation.
      for (const task of tasks) row.tasks.set(task.task.id, task);
      row.run = run;
      row.events.push(...events);
      return cloneSwarm(run);
    },
    async readEvents(key, afterSequence, limit) {
      validateEventCursor(afterSequence, limit);
      return cloneSwarm(
        runs.get(swarmKey(key))?.events.slice(afterSequence, afterSequence + limit) ?? [],
      );
    },
  };
}
