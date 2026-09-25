import type {
  SwarmDynamicLimits,
  SwarmRunRecord,
  SwarmSpawnRequest,
  SwarmTask,
  SwarmTaskRecord,
} from '../types/swarm';
import { SWARM_MAX_SPAWN_DEPTH, SWARM_MAX_TASKS, validateSpawn } from './store';

const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

const bounded = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

/** Validate caller limits (2.2); `maxSpawnPerTask` defaults to `maxTasks`. */
export function resolveDynamicLimits(limits: SwarmDynamicLimits): Required<SwarmDynamicLimits> {
  const maxSpawnPerTask = limits?.maxSpawnPerTask ?? limits?.maxTasks;
  if (
    !bounded(limits?.maxTasks, SWARM_MAX_TASKS) ||
    !bounded(limits.maxSpawnDepth, SWARM_MAX_SPAWN_DEPTH) ||
    !bounded(maxSpawnPerTask, limits.maxTasks)
  ) {
    throw new Error(
      `Swarm dynamic limits need integers: 1 ≤ maxTasks ≤ ${SWARM_MAX_TASKS}, 1 ≤ maxSpawnDepth ≤ ${SWARM_MAX_SPAWN_DEPTH}, 1 ≤ maxSpawnPerTask ≤ maxTasks`,
    );
  }
  return { maxTasks: limits.maxTasks, maxSpawnDepth: limits.maxSpawnDepth, maxSpawnPerTask };
}

/** Persisted limits only tighten when a process resumes with other options. */
export function tightenLimits(
  saved: Required<SwarmDynamicLimits>,
  requested: Required<SwarmDynamicLimits> | undefined,
): Required<SwarmDynamicLimits> {
  if (!requested) return saved;
  return {
    maxTasks: Math.min(saved.maxTasks, requested.maxTasks),
    maxSpawnDepth: Math.min(saved.maxSpawnDepth, requested.maxSpawnDepth),
    maxSpawnPerTask: Math.min(saved.maxSpawnPerTask, requested.maxSpawnPerTask),
  };
}

/**
 * Turn a finished task's spawn requests into pending records (2.2). Every
 * request is checked before anything commits — against the task bindings,
 * the effective limits and the same store rules — so an invalid request fails
 * its parent instead of the whole run.
 */
export function spawnRecords(input: {
  run: SwarmRunRecord;
  limits: Required<SwarmDynamicLimits> | undefined;
  /** The parent's current record; its attempt is the one that spawns. */
  parent: SwarmTaskRecord;
  on: 'completed' | 'failed';
  requests: readonly SwarmSpawnRequest[];
  records: ReadonlyMap<string, SwarmTaskRecord>;
  /** Validates a definition against the bindings and returns its binding version. */
  define: (task: SwarmTask) => string;
}): SwarmTaskRecord[] {
  if (!Array.isArray(input.requests)) throw new TypeError('Spawn requests must be an array');
  if (!input.requests.length) return [];
  if (input.run.version !== 2 || !input.limits)
    throw new Error('This swarm run was created without `dynamic` limits; it cannot spawn tasks');
  const depth = (input.parent.depth ?? 0) + 1;
  const spawn = input.requests.map((request): SwarmTaskRecord => {
    if (!request || typeof request.key !== 'string' || !KEY.test(request.key))
      throw new Error(`Invalid spawn key: ${String(request?.key)}`);
    const { key, ...definition } = request;
    const task = { ...definition, id: `${input.parent.task.id}/${key}` } as SwarmTask;
    return {
      task,
      bindingVersion: input.define(task),
      status: 'pending',
      attempt: 0,
      spawnedBy: { taskId: input.parent.task.id, attempt: input.parent.attempt, on: input.on },
      depth,
    };
  });
  validateSpawn({
    run: { ...input.run, dynamic: input.limits },
    tasks: [{ ...input.parent, status: input.on }],
    spawn,
    exists: (taskId) => input.records.has(taskId),
    count: input.records.size,
  });
  return spawn;
}
