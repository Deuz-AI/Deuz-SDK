/**
 * The records of the rollback test (2.4 spec §4.2), in the formats 2.3
 * persists: what the 2.4 code writes into the 2.3 stores, what the 2.3.0
 * package writes back, and the ids both sides look them up by. Plain JSON, so
 * the 2.3 side (a child process) receives them as they are.
 */
import type { ChatRecord } from '../../src/chat';
import type { EvolveCandidate, EvolveRunRecord } from '../../src/evolve/types';
import type { MemoryRecord, MemoryScope } from '../../src/memory';
import type { RunRecord } from '../../src/types/runtime';
import type { SwarmSnapshot } from '../../src/types/swarm';
import { candidateRecord, runRecord } from '../fixtures/population-store-conformance';
import { initialSnapshot } from '../fixtures/swarm-store-conformance';

/** The tenancy scope of every run, goal and process record. */
export const TENANT = 'tenant';
/** The memory and chat scope. */
export const USER: MemoryScope = { userId: 'ada' };
/** The budget every request of both versions is admitted against (a lifetime budget). */
export const BUDGET_KEY = 'user:ada';
export const BUDGET_LIMITS = { tokens: 1_000_000, usd: 100 };

/** Who wrote a legacy record: the 2.4 code or the published 2.3.0. */
export type Writer = '24' | '23';

/** The ids of the legacy (2.3-format) records one writer creates. */
export interface LegacyIds {
  memory: string;
  /** A memory that is already expired, for the 2.3 TTL sweep. */
  expiredMemory: string;
  chat: string;
  /** A legacy durable-session checkpoint (`generateText` with `session`). */
  session: string;
  /** A background run record of the store pack. */
  run: string;
  /** A native run that completed (envelope version 1). */
  agentRunDone: string;
  /** A native run suspended on an approval, for the other version to resume. */
  agentRunSuspended: string;
  lease: string;
  claim: string;
  budgetRequest: string;
  swarm: { scope: string; runId: string };
  evolve: { scope: string; runId: string };
}

export function legacyIds(writer: Writer): LegacyIds {
  return {
    memory: `mem-${writer}`,
    expiredMemory: `mem-${writer}-expired`,
    chat: `chat-${writer}`,
    session: `session-${writer}`,
    run: `bg-${writer}`,
    agentRunDone: `legacy-${writer}-done`,
    agentRunSuspended: `legacy-${writer}-suspended`,
    lease: `lease-${writer}`,
    claim: `claim-${writer}`,
    budgetRequest: `request-${writer}`,
    swarm: { scope: TENANT, runId: `swarm-${writer}` },
    evolve: { scope: TENANT, runId: `evolve-${writer}` },
  };
}

/** The ids of the 2.4 records (only the 2.4 code reads or writes them). */
export const MODERN = {
  v3Suspended: 'v3-suspended',
  v3Done: 'v3-done',
  /** The chat a V3 run projects into the conditional store. */
  v3Chat: 'chat-v3',
  conditionalChat: 'chat-conditional',
  tombstonedChat: 'chat-conditional-deleted',
  goal: 'goal-24',
  chargedGoal: 'goal-24-charged',
  delivery: 'delivery-24',
  schedule: 'schedule-24',
  intent: 'intent-24',
  watermarkRun: 'run-charged',
  stream: 'stream-24',
  openStream: 'stream-24-open',
  processOperation: 'op-24',
} as const;

/** Every 2.4 run id: none of them may show up in a 2.3 listing. */
export const V3_RUN_IDS = [MODERN.v3Suspended, MODERN.v3Done] as const;

/** The legacy records a writer creates directly through the stores. */
export interface LegacyRecords {
  memory: MemoryRecord;
  expiredMemory: MemoryRecord;
  chat: ChatRecord;
  run: RunRecord;
  swarm: SwarmSnapshot;
  evolveRun: EvolveRunRecord;
  evolveCandidate: EvolveCandidate;
}

const hash = (text: string) => `sha256:${text.length.toString(16).padStart(64, '0')}`;

export function legacyRecords(writer: Writer, now: number): LegacyRecords {
  const ids = legacyIds(writer);
  const text = `Ada drinks tea every morning (written by ${writer === '24' ? '2.4' : '2.3'})`;
  const swarm = initialSnapshot(ids.swarm.scope);
  return {
    memory: {
      id: ids.memory,
      text,
      hash: hash(text),
      kind: 'semantic',
      scope: USER,
      metadata: { writer },
      importance: 0.5,
      createdAt: now,
      updatedAt: now,
    },
    expiredMemory: {
      id: ids.expiredMemory,
      text: `A short-lived note (${writer})`,
      hash: hash(`expired-${writer}`),
      kind: 'working',
      scope: USER,
      createdAt: now,
      updatedAt: now,
      expiresAt: 1,
    },
    chat: {
      chatId: ids.chat,
      scope: USER,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `Hello from ${writer}` }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello Ada' }] },
      ],
      updatedAt: now,
      messageIds: [`${ids.chat}:0`, `${ids.chat}:1`],
    },
    run: {
      runId: ids.run,
      status: 'running',
      goal: `Background work of ${writer}`,
      stepIndex: 1,
      meta: { writer },
      createdAt: now,
      updatedAt: now,
    },
    swarm: {
      ...swarm,
      run: { ...swarm.run, runId: ids.swarm.runId, createdAt: now, updatedAt: now },
    },
    evolveRun: runRecord({ ...ids.evolve, createdAt: now, updatedAt: now }),
    evolveCandidate: candidateRecord({
      ...ids.evolve,
      generation: 0,
      slot: 0,
      parentId: undefined,
    }),
  };
}
