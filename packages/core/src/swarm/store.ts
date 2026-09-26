import type {
  SwarmChannelEntry,
  SwarmChannelPost,
  SwarmCommit,
  SwarmEvent,
  SwarmEventInput,
  SwarmKey,
  SwarmRunQuery,
  SwarmRunRecord,
  SwarmRunStatus,
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

/**
 * The run's lease (2.2): 'held' when another executor drives it right now,
 * 'lost' when this executor's lease lapsed or changed hands and it stopped
 * writing. Task records stay as they were for the next executor.
 */
export class SwarmLeaseError extends Error {
  readonly code: 'held' | 'lost';
  constructor(code: 'held' | 'lost', message?: string) {
    super(
      message ??
        (code === 'held'
          ? 'Another executor holds this swarm run'
          : 'This executor lost the swarm run lease'),
    );
    this.name = 'SwarmLeaseError';
    this.code = code;
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

/** Hard caps on runtime spawning (2.2). */
export const SWARM_MAX_TASKS = 10_000;
export const SWARM_MAX_SPAWN_DEPTH = 64;

const bounded = (value: unknown, max: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

function validLimits(limits: SwarmRunRecord['dynamic']): boolean {
  return (
    !!limits &&
    bounded(limits.maxTasks, SWARM_MAX_TASKS) &&
    bounded(limits.maxSpawnDepth, SWARM_MAX_SPAWN_DEPTH) &&
    bounded(limits.maxSpawnPerTask, limits.maxTasks)
  );
}

export function validateSwarmSnapshot(snapshot: SwarmSnapshot, key?: SwarmKey): void {
  const run = snapshot?.run;
  if (
    !run ||
    run.kind !== 'deuz-swarm' ||
    !(
      (run.version === 1 && run.dynamic === undefined) ||
      (run.version === 2 && validLimits(run.dynamic))
    ) ||
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
      (task.status === 'completed' && !task.result) ||
      (task.depth !== undefined && (!Number.isSafeInteger(task.depth) || task.depth < 0)) ||
      (task.spawnedBy !== undefined &&
        (!task.spawnedBy.taskId ||
          !Number.isSafeInteger(task.spawnedBy.attempt) ||
          task.spawnedBy.attempt < 1 ||
          !['completed', 'failed'].includes(task.spawnedBy.on)))
    )
      throw new Error('Corrupt swarm task state');
    ids.add(task.task.id);
  }
}

/**
 * Store-side check of a commit's spawned tasks (2.2): each is new, pending and
 * namespaced under a parent that reaches the matching terminal state in the
 * same commit, within the run's persisted limits, with dependencies that exist
 * or are spawned alongside it and form no cycle. Nothing is written on failure.
 */
export function validateSpawn(input: {
  run: SwarmRunRecord;
  tasks: readonly SwarmTaskRecord[];
  spawn: readonly SwarmTaskRecord[];
  exists: (taskId: string) => boolean;
  count: number;
}): void {
  const { run, spawn } = input;
  if (!spawn.length) return;
  if (run.version !== 2 || !run.dynamic)
    throw new Error('Only a dynamic (version 2) swarm run can spawn tasks');
  const limits = run.dynamic;
  if (input.count + spawn.length > limits.maxTasks)
    throw new Error(`Swarm task limit exceeded (${limits.maxTasks})`);
  const parents = new Map(input.tasks.map((task) => [task.task.id, task]));
  const perParent = new Map<string, number>();
  const batch = new Map<string, SwarmTaskRecord>();
  for (const record of spawn) {
    const id = record.task?.id;
    if (!id || batch.has(id) || input.exists(id))
      throw new Error(`Spawned task ID is not new: ${String(id)}`);
    if (
      record.status !== 'pending' ||
      record.attempt !== 0 ||
      record.result !== undefined ||
      record.error !== undefined ||
      record.agentState !== undefined ||
      record.resolvedPrompt !== undefined
    )
      throw new Error(`Spawned task must start pending: ${id}`);
    const origin = record.spawnedBy;
    const parent = origin && parents.get(origin.taskId);
    if (
      !origin ||
      !parent ||
      parent.status !== origin.on ||
      parent.attempt !== origin.attempt ||
      !id.startsWith(`${origin.taskId}/`)
    )
      throw new Error(`A spawned task must commit with its parent's terminal state: ${id}`);
    const depth = (parent.depth ?? 0) + 1;
    if (record.depth !== depth || depth > limits.maxSpawnDepth)
      throw new Error(`Swarm spawn depth exceeded (${limits.maxSpawnDepth}): ${id}`);
    const spawned = (perParent.get(origin.taskId) ?? 0) + 1;
    if (spawned > limits.maxSpawnPerTask)
      throw new Error(`Swarm per-task spawn limit exceeded (${limits.maxSpawnPerTask})`);
    perParent.set(origin.taskId, spawned);
    batch.set(id, record);
  }
  // Existing tasks cannot depend on new ones, so a cycle can only lie inside the batch.
  const pending = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const [id, record] of batch) {
    const deps = [...(record.task.dependsOn ?? []), ...(record.task.after ?? [])];
    if (new Set(deps).size !== deps.length) throw new Error(`Duplicate dependency: ${id}`);
    let inBatch = 0;
    for (const dep of deps) {
      if (batch.has(dep)) {
        inBatch++;
        children.set(dep, [...(children.get(dep) ?? []), id]);
      } else if (!input.exists(dep)) throw new Error(`Missing dependency: ${dep}`);
    }
    pending.set(id, inBatch);
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const next of children.get(ready[index]!) ?? []) {
      const left = pending.get(next)! - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (ready.length !== batch.size) throw new Error('Swarm dependency cycle among spawned tasks');
  validateSwarmSnapshot({ run, tasks: [...batch.values()] });
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

const CHANNEL = /^[A-Za-z0-9._:-]{1,64}$/;
/** Longest blackboard note text (2.2). */
export const SWARM_MAX_NOTE = 16_000;

export function validateChannelName(channel: unknown): string {
  if (typeof channel !== 'string' || !CHANNEL.test(channel))
    throw new Error(`Invalid swarm channel name: ${String(channel)}`);
  return channel;
}

const samePost = (left: SwarmChannelPost, right: SwarmChannelPost): boolean =>
  left.channel === right.channel &&
  left.taskId === right.taskId &&
  left.text === right.text &&
  encodeSwarm(left.data ?? null) === encodeSwarm(right.data ?? null);

/**
 * Validate a commit's blackboard posts and assign sequences (2.2). Identical
 * repeats of an entry — already stored or earlier in the same commit — are
 * dropped; a different post under the same entryId rejects the whole commit.
 */
export function planPosts(input: {
  posts: readonly SwarmChannelPost[];
  taskExists: (taskId: string) => boolean;
  find: (entryId: string) => SwarmChannelPost | undefined;
  last: (channel: string) => number;
}): SwarmChannelEntry[] {
  const planned = new Map<string, SwarmChannelEntry>();
  const next = new Map<string, number>();
  for (const post of input.posts) {
    validateChannelName(post?.channel);
    if (typeof post.entryId !== 'string' || !post.entryId || post.entryId.length > 512)
      throw new Error('Invalid swarm post entryId');
    if (!input.taskExists(post.taskId))
      throw new Error(`Swarm post from an unknown task: ${post.taskId}`);
    if (!Number.isSafeInteger(post.attempt) || post.attempt < 1 || !Number.isFinite(post.at))
      throw new Error('Invalid swarm post attempt or time');
    if (typeof post.text !== 'string' || !post.text || post.text.length > SWARM_MAX_NOTE)
      throw new Error(`Swarm post text must be 1..${SWARM_MAX_NOTE} characters`);
    encodeSwarm(post.data ?? null);
    const prior = planned.get(post.entryId) ?? input.find(post.entryId);
    if (prior) {
      if (!samePost(prior, post))
        throw new Error(`Conflicting swarm post for entry ${post.entryId}`);
      continue;
    }
    const sequence = (next.get(post.channel) ?? input.last(post.channel)) + 1;
    next.set(post.channel, sequence);
    planned.set(post.entryId, cloneSwarm({ ...post, sequence }));
  }
  return [...planned.values()];
}

/** The journal events a commit's newly stored posts produce (2.2). */
export function postEvents(entries: readonly SwarmChannelEntry[]): SwarmEventInput[] {
  return entries.map((entry) => ({
    type: 'channel.posted',
    taskId: entry.taskId,
    detail: entry.channel,
    timestamp: entry.at,
  }));
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

const RUN_STATUSES: readonly SwarmRunStatus[] = [
  'running',
  'completed',
  'partial',
  'suspended',
  'cancelled',
];

/** Shared listRuns validation (2.2). */
export function validateRunQuery(query: SwarmRunQuery): void {
  if (
    !query ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 1000 ||
    (query.status !== undefined && !RUN_STATUSES.includes(query.status)) ||
    (query.scope !== undefined && (typeof query.scope !== 'string' || !query.scope))
  )
    throw new Error('Invalid swarm run query (status, scope, or limit 1..1000)');
}

/** The listRuns order (2.2): updatedAt, then scope, then runId. */
export function compareRuns(left: SwarmRunRecord, right: SwarmRunRecord): number {
  return (
    left.updatedAt - right.updatedAt ||
    (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0) ||
    (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0)
  );
}

/** In-process reference store with exactly the same CAS/atomicity contract as SQLite. */
export function createInMemorySwarmStore(): SwarmStore {
  const runs = new Map<
    string,
    {
      run: SwarmRunRecord;
      tasks: Map<string, SwarmTaskRecord>;
      events: SwarmEvent[];
      channels: Map<string, SwarmChannelEntry[]>;
      entries: Map<string, SwarmChannelEntry>;
    }
  >();
  return {
    capabilities: Object.freeze(['spawn', 'channels', 'list'] as const),
    async listRuns(query) {
      validateRunQuery(query);
      return cloneSwarm(
        [...runs.values()]
          .map((row) => row.run)
          .filter(
            (run) =>
              (query.status === undefined || run.status === query.status) &&
              (query.scope === undefined || run.scope === query.scope),
          )
          .sort(compareRuns)
          .slice(0, query.limit),
      );
    },
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
        channels: new Map(),
        entries: new Map(),
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
      if (row.run.revision !== change.expectedRevision) throw new SwarmConflictError();
      const tasks = cloneSwarm(change.tasks ?? []);
      const spawn = cloneSwarm(change.spawn ?? []);
      for (const task of tasks) {
        if (!row.tasks.has(task.task.id)) throw new Error('Cannot add tasks to a fixed swarm DAG');
        validateTaskChange(row.tasks.get(task.task.id)!, task, row.run);
      }
      validateSpawn({
        run: row.run,
        tasks,
        spawn,
        exists: (taskId) => row.tasks.has(taskId),
        count: row.tasks.size,
      });
      const posted = planPosts({
        posts: change.posts ?? [],
        taskExists: (taskId) => row.tasks.has(taskId),
        find: (entryId) => row.entries.get(entryId),
        last: (channel) => row.channels.get(channel)?.length ?? 0,
      });
      const inputs = [...(change.events ?? []), ...postEvents(posted)];
      const run = cloneSwarm(nextSwarmRun(row.run, { ...change, events: inputs }));
      const events = cloneSwarm(makeSwarmEvents(change, row.run.lastSequence, inputs));
      // All validation/serialization precedes the first mutation.
      for (const task of [...tasks, ...spawn]) row.tasks.set(task.task.id, task);
      for (const entry of posted) {
        row.channels.set(entry.channel, [...(row.channels.get(entry.channel) ?? []), entry]);
        row.entries.set(entry.entryId, entry);
      }
      row.run = run;
      row.events.push(...events);
      return cloneSwarm(run);
    },
    async readChannel(key, channel, afterSequence, limit) {
      validateChannelName(channel);
      validateEventCursor(afterSequence, limit);
      return cloneSwarm(
        runs
          .get(swarmKey(key))
          ?.channels.get(channel)
          ?.slice(afterSequence, afterSequence + limit) ?? [],
      );
    },
    async readEvents(key, afterSequence, limit) {
      validateEventCursor(afterSequence, limit);
      return cloneSwarm(
        runs.get(swarmKey(key))?.events.slice(afterSequence, afterSequence + limit) ?? [],
      );
    },
  };
}
