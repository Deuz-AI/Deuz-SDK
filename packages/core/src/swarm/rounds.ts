import type { NativeExecutionContext } from '../types/execution';
import type {
  SwarmReducerBinding,
  SwarmReducerContext,
  SwarmSpawnRequest,
  SwarmTask,
  SwarmTaskResult,
} from '../types/swarm';
import { SWARM_GROUP } from './blackboard';

/** How many agents of which binding a group runs next round, and with what prompt (2.2). */
export interface RoundsGroupPlan {
  agent: string;
  /** 1..1000 agents in this group. */
  count: number;
  prompt: string;
}

/** A consolidator's verdict on the round that just finished (2.2). */
export interface RoundsDecision {
  /** End the chain now. */
  stop?: boolean;
  /** Next round's plan by group; a group left out does not run. No groups also stops. */
  groups?: Readonly<Record<string, RoundsGroupPlan>>;
  /** Kept on this consolidator's output. Must be serializable. */
  summary?: unknown;
}

export interface RoundsConsolidateInput {
  /** The round that just finished, starting at 1. */
  round: number;
  /** Results of the round's completed tasks, by group, in task order. */
  groups: Readonly<Record<string, readonly SwarmTaskResult[]>>;
  /** Terminal status of every task of the round, by task ID. */
  settled: SwarmReducerContext['settled'];
  readChannel: SwarmReducerContext['readChannel'];
  /** Budget-accounted context for any model call the consolidator makes. */
  execution: NativeExecutionContext;
  signal: AbortSignal;
}

export interface CreateRoundsOptions {
  /** The chain's root task ID and the prefix of its two reducer bindings. */
  id: string;
  initial: Readonly<Record<string, RoundsGroupPlan>>;
  consolidate: (input: RoundsConsolidateInput) => RoundsDecision | Promise<RoundsDecision>;
  /** 1..64; the last consolidator stops the chain. */
  maxRounds: number;
  /** Agent bindings a decision may schedule; defaults to the ones in `initial`. */
  agents?: readonly string[];
  /** Replay policy of the round tasks; 'manual' (default) reconciles interruptions. */
  replay?: 'manual' | 'safe';
  /** Per-attempt budget of each round task. */
  timeoutMs?: number;
}

/** Tasks and reducers to hand to `createSwarm` and `swarm.run` (2.2). */
export interface SwarmRounds {
  tasks: SwarmTask[];
  reducers: Record<string, SwarmReducerBinding>;
}

const lastSegment = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/**
 * Rounds of group-parallel agents with a consolidator between them (2.2): the
 * pattern of large research runs. Each round's agents work in blackboard
 * groups; a consolidator then reads their completed results — failed explorers
 * do not block it — and decides the next round: which groups continue, with how
 * many agents and what prompt. It is built from dynamic-swarm spawns, so the
 * swarm needs `dynamic` limits of at least `maxRounds` spawn depth.
 */
export function createRounds(options: CreateRoundsOptions): SwarmRounds {
  if (!options.id || /[/]/.test(options.id)) throw new Error('Rounds id must be a nonempty name');
  if (!Number.isSafeInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 64)
    throw new Error('Rounds maxRounds must be an integer from 1 to 64');
  const allowed = new Set(
    options.agents ?? Object.values(options.initial).map((plan) => plan.agent),
  );
  const start = `${options.id}:start`;
  const consolidator = `${options.id}:round`;

  function requests(
    plan: Readonly<Record<string, RoundsGroupPlan>>,
    round: number,
    parentId: string,
  ): SwarmSpawnRequest[] {
    const tasks: SwarmSpawnRequest[] = [];
    const members: string[] = [];
    for (const [group, entry] of Object.entries(plan)) {
      if (!SWARM_GROUP.test(group)) throw new Error(`Invalid rounds group: ${group}`);
      if (!entry || !allowed.has(entry.agent))
        throw new Error(`Agent ${String(entry?.agent)} is not allowed in these rounds`);
      if (!Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1000)
        throw new Error(`Rounds group ${group} needs a count from 1 to 1000`);
      if (typeof entry.prompt !== 'string' || !entry.prompt)
        throw new Error(`Rounds group ${group} needs a prompt`);
      for (let index = 1; index <= entry.count; index++) {
        const key = `${group}.${index}`;
        tasks.push({
          key,
          agent: entry.agent,
          prompt: entry.prompt,
          group,
          ...(options.replay ? { replay: options.replay } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        members.push(`${parentId}/${key}`);
      }
    }
    if (!members.length) throw new Error('A round needs at least one group');
    tasks.push({ key: `c${round}`, reducer: consolidator, after: members });
    return tasks;
  }
  // Fail fast on a bad first round instead of at run time.
  requests(options.initial, 1, options.id);

  return {
    tasks: [{ id: options.id, reducer: start }],
    reducers: {
      [start]: {
        execute(_results, context) {
          context.spawn(requests(options.initial, 1, context.taskId));
          return { round: 0 };
        },
      },
      [consolidator]: {
        async execute(results, context) {
          const round = Number(lastSegment(context.taskId).slice(1));
          const groups: Record<string, SwarmTaskResult[]> = {};
          for (const id of Object.keys(context.settled)) {
            const group = lastSegment(id).split('.')[0]!;
            groups[group] ??= [];
            if (results[id]) groups[group].push(results[id]);
          }
          const decision = await options.consolidate({
            round,
            groups,
            settled: context.settled,
            readChannel: context.readChannel,
            execution: context.execution,
            signal: context.signal,
          });
          const next = decision?.groups ?? {};
          const stopped =
            !!decision?.stop || round >= options.maxRounds || !Object.keys(next).length;
          if (!stopped) context.spawn(requests(next, round + 1, context.taskId));
          return { round, stopped, summary: decision?.summary ?? null };
        },
      },
    },
  };
}
