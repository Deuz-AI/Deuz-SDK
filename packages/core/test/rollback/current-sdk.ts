/**
 * The 2.4 side of the rollback test (spec §4.2): the current code's stores on
 * one backend (a SQLite file or a Postgres schema), each opening its own
 * connection as a separate worker would, and what the current code writes
 * there and reads back.
 *
 * Beside the 2.3 stores' tables it writes every kind of 2.4 record:
 * versioned memory (revisions, receipts, vectors, a forget), V3 runs with
 * their context package blobs and redactions, the goal runtime (goal, state,
 * inbox, schedule and occurrence, intent, watermark), conditional chats with
 * their transcript index and a tombstone, durable streams and, on SQLite,
 * process operations. Into the 2.3 stores themselves it writes the legacy
 * records a 2.4 worker of a rolling upgrade writes: memory, chat, durable
 * session, background run, native runs (one suspended for 2.3 to resume),
 * a lease, a claim, a budget request, a swarm and an evolve run.
 */
import type pg from 'pg';
import { resumeAgent, runAgent } from '../../src/agent-run';
import type { ChatRecord } from '../../src/chat';
import {
  createMemoryContextSource,
  createTranscriptContextSource,
} from '../../src/context/sources';
import { generateText } from '../../src/generate';
import { transitionGoal } from '../../src/goal';
import type { MemoryScope } from '../../src/memory';
import { createMemorySession, type MemorySession } from '../../src/memory/versioned';
import type { Embedder } from '../../src/memory';
import { createPostgresBudgetStore } from '../../src/node/budget-postgres';
import { createSqliteBudgetStore } from '../../src/node/budget-sqlite';
import { createPostgresConditionalChatStore } from '../../src/node/chat-conditional-postgres';
import { createSqliteConditionalChatStore } from '../../src/node/chat-conditional-sqlite';
import { createSqlitePopulationStore } from '../../src/node/evolve-sqlite';
import { createPostgresGoalRuntimeStore } from '../../src/node/goal-runtime-postgres';
import { createSqliteGoalRuntimeStore } from '../../src/node/goal-runtime-sqlite';
import { createPostgresOpsStore } from '../../src/node/ops-postgres';
import { createSqliteOpsStore } from '../../src/node/ops-sqlite';
import { createSqliteProcessOperationStore } from '../../src/node/process-ops-sqlite';
import { createPostgresAgentRunStoreV3 } from '../../src/node/runs-v3-postgres';
import { createSqliteAgentRunStoreV3 } from '../../src/node/runs-v3-sqlite';
import { createPostgresStores } from '../../src/node/store-postgres';
import { createSqliteStores } from '../../src/node/store-sqlite';
import { createPostgresDurableStreamStateStore } from '../../src/node/stream-state-postgres';
import { createSqliteDurableStreamStateStore } from '../../src/node/stream-state-sqlite';
import { createPostgresSwarmStore } from '../../src/node/swarm-postgres';
import { createSqliteSwarmStore } from '../../src/node/swarm-sqlite';
import { createPostgresVersionedMemoryStore } from '../../src/node/vmem-postgres';
import { createSqliteVersionedMemoryStore } from '../../src/node/vmem-sqlite';
import { createMockModel, type MockResponse } from '../../src/testing';
import type { AgentRunOptionsV3 } from '../../src/types/agent-run-v3';
import type { Clock } from '../../src/types/deps';
import {
  occurrence,
  runIntent,
  runtimeGoal,
  runtimeState,
  scheduleInput,
  delivery,
  T0,
} from '../fixtures/goal-runtime-store-conformance';
import { newRecord } from '../fixtures/process-ops-store-conformance';
import {
  BUDGET_KEY,
  BUDGET_LIMITS,
  MODERN,
  TENANT,
  USER,
  V3_RUN_IDS,
  legacyIds,
  legacyRecords,
  type LegacyIds,
} from './records';

export type Backend =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; pool: pg.Pool; schema: string };

const MINUTE = 60_000;

/** The goal runtime's clock: times relative to the conformance fixtures' `T0`. */
export function goalClock(): Clock {
  return {
    now: () => T0 + 10 * MINUTE,
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
}

/** The current code's stores on one backend. */
export function openCurrent(backend: Backend) {
  const clock = goalClock();
  if (backend.kind === 'sqlite') {
    const { path } = backend;
    const pack = createSqliteStores({ path });
    const ops = createSqliteOpsStore({ path });
    const budget = createSqliteBudgetStore({ path });
    const swarm = createSqliteSwarmStore({ path });
    const evolve = createSqlitePopulationStore({ path });
    const vmem = createSqliteVersionedMemoryStore({ path });
    const runsV3 = createSqliteAgentRunStoreV3({ path });
    const goals = createSqliteGoalRuntimeStore({ path, clock });
    const chat = createSqliteConditionalChatStore({ path });
    const streams = createSqliteDurableStreamStateStore({ path });
    const processOps = createSqliteProcessOperationStore({ path });
    const owned = [
      pack,
      ops,
      budget,
      swarm,
      evolve,
      vmem,
      runsV3,
      goals,
      chat,
      streams,
      processOps,
    ];
    return {
      kind: backend.kind,
      pack,
      ops,
      budget,
      swarm,
      evolve: evolve as typeof evolve | undefined,
      vmem,
      runsV3,
      goals,
      chat,
      streams,
      processOps: processOps as typeof processOps | undefined,
      async close() {
        for (const store of owned) await store.close();
      },
    };
  }
  const { pool, schema } = backend;
  const pack = createPostgresStores({ client: pool, schema });
  const ops = createPostgresOpsStore({ client: pool, schema });
  const budget = createPostgresBudgetStore({ client: pool, schema });
  const swarm = createPostgresSwarmStore({ client: pool, schema });
  const vmem = createPostgresVersionedMemoryStore({ pool, schema });
  const runsV3 = createPostgresAgentRunStoreV3({ pool, schema });
  const goals = createPostgresGoalRuntimeStore({ pool, schema, clock });
  const chat = createPostgresConditionalChatStore({ pool, schema });
  const streams = createPostgresDurableStreamStateStore({ pool, schema });
  // Every store borrows the pool; closing them leaves it open for its owner.
  const owned = [pack, vmem, runsV3, goals, chat, streams];
  return {
    kind: backend.kind,
    pack,
    ops,
    budget,
    swarm,
    // 2.3 has no Postgres evolve store, and process operations are SQLite-only (spec §4.3).
    evolve: undefined as ReturnType<typeof createSqlitePopulationStore> | undefined,
    vmem,
    runsV3,
    goals,
    chat,
    streams,
    processOps: undefined as ReturnType<typeof createSqliteProcessOperationStore> | undefined,
    async close() {
      for (const store of owned) await store.close();
    },
  };
}

export type CurrentStores = ReturnType<typeof openCurrent>;

// ---------------------------------------------------------------------------
// Runs, tools and models
// ---------------------------------------------------------------------------

const parameters = { type: 'object', properties: {} } as const;

/** A tool behind an approval; `calls` counts its executions. */
export function gateTool() {
  const gate = {
    calls: 0,
    tool: {
      description: 'Deploy, once a human approved it.',
      parameters,
      needsApproval: true,
      execute: () => {
        gate.calls += 1;
        return 'deployed';
      },
    },
  };
  return gate;
}

/** A mock model whose `calls` counts the model calls it answered. */
export function countingModel(responses: MockResponse[]) {
  const counter = { calls: 0 };
  const model = createMockModel({
    get responses() {
      counter.calls += 1;
      return responses;
    },
  });
  return { model, counter };
}

/** A deterministic embedder: three dimensions from the text's shape. */
const embedder: Embedder = {
  async embed(texts) {
    return {
      vectors: texts.map((text) => [
        text.length,
        text.split(' ').length,
        text.includes('tea') ? 1 : 0,
      ]),
      model: 'rollback-embedder',
    };
  },
};

/** The versioned-memory session every 2.4 write goes through: a forget redacts the V3 packages. */
export function memorySession(stores: CurrentStores): MemorySession {
  return createMemorySession({
    store: stores.vmem,
    scope: USER,
    embedder,
    onForget: (event) => stores.runsV3.redactForgotten(event),
  });
}

/** The V3 run that suspends on its approval, with context from memory and past chats. */
export function v3Options(
  stores: CurrentStores,
  session: MemorySession,
  model: AgentRunOptionsV3['model'],
  gate: ReturnType<typeof gateTool>,
  runId: string,
): AgentRunOptionsV3 {
  return {
    model,
    instructions: 'You deploy carefully.',
    prompt: 'Remember my tea preference, then deploy the service.',
    checkpointVersion: 3,
    session: { store: stores.runsV3, runId, scope: TENANT },
    tools: { gate: gate.tool },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    context: {
      sources: [
        createMemoryContextSource({ session }),
        createTranscriptContextSource({ index: stores.chat.transcript, scope: USER }),
      ],
    },
    versionedMemory: { session, tools: true },
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What the 2.4 writes left for the checks: ids only known once written. */
export interface CurrentWrites {
  /** The approval the suspended legacy run (2.4-written) waits for. */
  legacyApprovalId: string;
  /** The approval the suspended V3 run waits for. */
  v3ApprovalId: string;
  /** Versioned memory records still there, and the one forgotten. */
  memory: { kept: string[]; forgotten: string; operations: string[] };
}

const ok = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`2.4 write failed: ${message}`);
};

/** Writes the legacy records a 2.4 worker writes into the 2.3 stores. */
export async function writeLegacy(stores: CurrentStores, now: number): Promise<string> {
  const ids = legacyIds('24');
  const records = legacyRecords('24', now);
  const { pack, ops } = stores;
  await pack.memory.upsert([records.memory, records.expiredMemory]);
  await pack.chats.saveChat(records.chat);
  await pack.runs.create(records.run);
  // A legacy durable session: two steps through a tool, checkpointed at each boundary.
  await generateText({
    model: createMockModel({
      responses: [{ toolCalls: [{ toolName: 'lookup', args: {} }] }, { text: 'found it' }],
    }),
    prompt: 'Look it up',
    tools: { lookup: { parameters, execute: async () => 'tea' } },
    maxSteps: 2,
    session: { store: pack.sessions, runId: ids.session },
  });
  // Native runs on the 2.3 run store: 2.4 features off, so envelope version 1.
  const done = await runAgent({
    model: createMockModel({ responses: [{ text: 'done by 2.4' }] }),
    prompt: 'Say done',
    session: { store: ops.agentRuns, runId: ids.agentRunDone, scope: TENANT },
  });
  ok(done.status === 'completed', `legacy run ${ids.agentRunDone} is ${done.status}`);
  const gate = gateTool();
  const suspended = await runAgent({
    model: createMockModel({
      responses: [{ toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] }],
    }),
    prompt: 'Deploy',
    tools: { gate: gate.tool },
    session: { store: ops.agentRuns, runId: ids.agentRunSuspended, scope: TENANT },
  });
  ok(
    suspended.status === 'suspended',
    `legacy run ${ids.agentRunSuspended} is ${suspended.status}`,
  );
  if (suspended.status !== 'suspended') throw new Error('unreachable');
  ok(
    (await ops.leases.acquire({ key: ids.lease, owner: 'worker-24', ttlMs: 30 * MINUTE })) !==
      undefined,
    `lease ${ids.lease}`,
  );
  ok(await ops.claims(ids.claim), `claim ${ids.claim}`);
  const reserved = await stores.budget.reserve({
    requestId: ids.budgetRequest,
    modelId: 'mock-model',
    tokens: 100,
    usd: 0.01,
    scopes: [{ key: BUDGET_KEY, limits: BUDGET_LIMITS }],
  });
  ok(reserved.admitted, `budget request ${ids.budgetRequest}`);
  await stores.budget.settle(ids.budgetRequest, { tokens: 80, usd: 0.008 });
  await stores.swarm.create(records.swarm, [{ type: 'run.started', timestamp: now }]);
  if (stores.evolve) {
    await stores.evolve.createRun(records.evolveRun);
    await stores.evolve.putCandidate(records.evolveCandidate);
  }
  return suspended.pendingApprovals[0]!.approvalId;
}

/** Writes every kind of 2.4 record. */
export async function writeModern(
  stores: CurrentStores,
): Promise<Omit<CurrentWrites, 'legacyApprovalId'>> {
  // Conditional chats (their transcript index rides the same transaction), one tombstoned.
  const chat = (chatId: string, texts: string[]): ChatRecord => ({
    chatId,
    scope: USER,
    messages: texts.map((text, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text }],
    })),
    messageIds: texts.map((_, index) => `${chatId}:${index}`),
    updatedAt: 1,
  });
  const live = await stores.chat.writeChat(
    chat(MODERN.conditionalChat, ['Which tea does Ada like?', 'Green tea, always.']),
    { expectedRevision: 0 },
  );
  ok(live.status === 'committed', `conditional chat: ${live.status}`);
  const doomed = await stores.chat.writeChat(chat(MODERN.tombstonedChat, ['Forget this chat']), {
    expectedRevision: 0,
  });
  ok(doomed.status === 'committed', `conditional chat to delete: ${doomed.status}`);
  const tombstone = await stores.chat.tombstoneChat(MODERN.tombstonedChat, { expectedRevision: 1 });
  ok(tombstone.status === 'deleted', `tombstone: ${tombstone.status}`);

  // Versioned memory: revisions, receipts, vectors and a forget.
  const session = memorySession(stores);
  const tea = await session.remember({ text: 'Ada prefers green tea', supersede: 'add' });
  const teaId = tea.records[0]!.id;
  const revised = await session.revise(
    teaId,
    { text: 'Ada prefers jasmine tea' },
    { expectedRevision: 1 },
  );
  const coffee = await session.remember({ text: 'Ada dislikes coffee', supersede: 'add' });
  const trip = await session.remember({ text: 'Ada is in Lisbon this week', supersede: 'add' });
  const tripId = trip.records[0]!.id;

  // V3 runs: one completed, projecting its chat into the conditional store; one
  // suspended on its approval after a memory tool write, its packages in blobs.
  const doneModel = countingModel([{ text: 'v3 done' }]);
  const done = await runAgent({
    ...v3Options(stores, session, doneModel.model, gateTool(), MODERN.v3Done),
    prompt: 'Which tea do I like?',
    chat: { store: stores.chat, chatId: MODERN.v3Chat, scope: USER },
  });
  ok(done.status === 'completed', `V3 run ${MODERN.v3Done} is ${done.status}`);
  const suspendedModel = countingModel([
    {
      toolCalls: [
        {
          toolName: 'memory_remember',
          id: 'm1',
          args: { text: 'Ada takes her tea without sugar' },
        },
      ],
    },
    { toolCalls: [{ toolName: 'gate', id: 'g1', args: {} }] },
  ]);
  const suspended = await runAgent(
    v3Options(stores, session, suspendedModel.model, gateTool(), MODERN.v3Suspended),
  );
  ok(suspended.status === 'suspended', `V3 run ${MODERN.v3Suspended} is ${suspended.status}`);
  if (suspended.status !== 'suspended') throw new Error('unreachable');
  // The forget comes after the runs, so their packages hold the forgotten record.
  const forgot = await session.forget(tripId);
  ok(forgot.redaction === 'complete', `forget redaction: ${forgot.redaction}`);

  // The goal runtime: a goal with state, an inbox delivery, a schedule that
  // delivered one occurrence, a run intent, and a ledger watermark.
  const goal = runtimeGoal(MODERN.goal, TENANT, T0);
  const saved = await stores.goals.runtime.save(runtimeState(goal), goal);
  ok(saved.status === 'committed', `goal runtime state: ${saved.status}`);
  await stores.goals.inbox.enqueue(delivery(goal, MODERN.delivery));
  const schedule = await stores.goals.schedules.put(scheduleInput(goal, MODERN.schedule), {
    expectedRevision: 0,
    effectiveFrom: T0,
  });
  ok(schedule.status === 'committed', `schedule: ${schedule.status}`);
  const advanced = await stores.goals.schedules.advance({
    scope: TENANT,
    scheduleId: MODERN.schedule,
    expectedRevision: 1,
    fromCursor: T0,
    toCursor: T0 + MINUTE,
    occurrences: [occurrence(goal, MODERN.schedule, T0 + MINUTE)],
  });
  ok(advanced.status === 'advanced', `schedule advance: ${advanced.status}`);
  const intent = await stores.goals.intents.record(runIntent(goal, MODERN.intent));
  ok(intent.status === 'committed', `run intent: ${intent.status}`);
  const charged = runtimeGoal(MODERN.chargedGoal, TENANT, T0);
  await stores.goals.save(charged);
  const watermark = await stores.goals.watermarks.advance({
    scope: TENANT,
    goalId: MODERN.chargedGoal,
    runId: MODERN.watermarkRun,
    expectedRevision: 0,
    next: { tokens: 100, usd: 0.1, reservedTokens: 0, reservedUsd: 0 },
    goal: transitionGoal(
      charged,
      { type: 'charge', tokens: 100, usd: 0.1, key: `${MODERN.watermarkRun}:100` },
      { now: T0 + 1 },
    ).record,
  });
  ok(watermark.status === 'committed', `watermark: ${watermark.status}`);

  // Durable streams: one finished, one still open.
  ok((await stores.streams.open(MODERN.stream, 1)).status === 'opened', 'stream open');
  const committed = await stores.streams.commit({
    streamId: MODERN.stream,
    token: 1,
    records: [
      { seq: 0, part: { type: 'start', messageId: 'msg-1' } },
      { seq: 1, part: { type: 'text-delta', text: 'Green tea.' } },
      { seq: 2, part: { type: 'done' } },
    ],
  });
  ok(committed.status === 'committed', `stream commit: ${committed.status}`);
  ok((await stores.streams.open(MODERN.openStream, 1)).status === 'opened', 'open stream');
  await stores.streams.append(MODERN.openStream, 0, { type: 'start', messageId: 'msg-2' });

  // Process operations (SQLite only).
  if (stores.processOps) {
    const created = await stores.processOps.create(
      newRecord({ operationId: MODERN.processOperation, scope: TENANT }),
    );
    ok(created.status === 'created', `process operation: ${created.status}`);
  }

  return {
    v3ApprovalId: suspended.pendingApprovals[0]!.approvalId,
    memory: {
      kept: [teaId, coffee.records[0]!.id],
      forgotten: tripId,
      operations: [tea, revised, coffee, trip].map((result) => result.receipt.operationId),
    },
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** JSON as the 2.3 side reports it: `undefined` fields gone, `undefined` itself `null`. */
export const json = <T>(value: T): T =>
  (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;

/**
 * The legacy records under `ids` as the current code reads them, in the same
 * shape the 2.3 side reports (`legacy-smoke.mjs`, `readLegacy`).
 */
export async function readLegacy(stores: CurrentStores, ids: LegacyIds) {
  const { pack, ops } = stores;
  return json({
    memory: await pack.memory.get(ids.memory),
    expiredMemory: await pack.memory.get(ids.expiredMemory),
    memoryIds: (await pack.memory.list(USER)).map((record) => record.id).sort(),
    chat: await pack.chats.loadChat(ids.chat),
    chatIds: [...(await pack.chats.listChats(USER))].sort(),
    session: await pack.sessions.load(ids.session),
    run: await pack.runs.get(ids.run),
    agentRunDone: await ops.agentRuns.load(ids.agentRunDone),
    agentRunSuspended: await ops.agentRuns.load(ids.agentRunSuspended),
    budget: await stores.budget.usage(BUDGET_KEY, { byModel: true }),
    swarm: await stores.swarm.load(ids.swarm),
    evolve: stores.evolve
      ? {
          run: await stores.evolve.loadRun(ids.evolve),
          candidates: await stores.evolve.listCandidates(ids.evolve),
        }
      : null,
  });
}

/** Every 2.4 record, as the current code reads it: equal before and after 2.3 ran. */
export async function readModern(
  stores: CurrentStores,
  writes: Omit<CurrentWrites, 'legacyApprovalId'>,
) {
  const scope: MemoryScope = USER;
  const runs = await Promise.all(V3_RUN_IDS.map((runId) => stores.runsV3.load(runId)));
  const digests = [
    ...new Set(runs.flatMap((run) => run?.context?.steps.map((step) => step.blob.digest) ?? [])),
  ].sort();
  const goal = stores.goals;
  const streamRecords = async (streamId: string) => {
    const out = [];
    for await (const record of stores.streams.read(streamId)) out.push(record);
    return out;
  };
  return json({
    v3: {
      runs,
      list: (await stores.runsV3.list()).runs,
      blobs: await Promise.all(
        digests.map(async (digest) => ({ digest, blob: await stores.runsV3.getBlob(digest) })),
      ),
    },
    memory: {
      scopeRevision: await stores.vmem.scopeRevision(scope),
      history: await Promise.all(writes.memory.kept.map((id) => stores.vmem.history(scope, id))),
      forgotten: (await stores.vmem.get(scope, writes.memory.forgotten)) ?? null,
      receipts: await Promise.all(writes.memory.operations.map((id) => stores.vmem.receipt(id))),
      search: (await stores.vmem.search({ scope, text: 'tea', topK: 10 })).map((hit) => [
        hit.record.id,
        hit.record.revision,
      ]),
    },
    goals: {
      goal: await goal.load(MODERN.goal, { scope: TENANT }),
      charged: await goal.load(MODERN.chargedGoal, { scope: TENANT }),
      list: await goal.list({ scope: TENANT }),
      state: await goal.runtime.get(TENANT, MODERN.goal),
      inbox: await goal.inbox.list({ scope: TENANT, goalId: MODERN.goal }),
      schedule: await goal.schedules.get(TENANT, MODERN.schedule),
      occurrences: await goal.schedules.occurrences?.({ scope: TENANT }),
      intent: await goal.intents.get(TENANT, MODERN.intent),
      watermark: await goal.watermarks.get(TENANT, MODERN.chargedGoal, MODERN.watermarkRun),
    },
    chat: {
      live: await stores.chat.readChat(MODERN.conditionalChat),
      projected: await stores.chat.readChat(MODERN.v3Chat),
      tombstoned: await stores.chat.readChat(MODERN.tombstonedChat),
      list: [...(await stores.chat.listChats(USER))].sort(),
      search: (await stores.chat.transcript.search(USER, 'tea', { limit: 10 })).map((hit) => [
        hit.chatId,
        hit.messageId,
      ]),
    },
    streams: {
      finished: await streamRecords(MODERN.stream),
      open: await streamRecords(MODERN.openStream),
      lastSeq: [
        await stores.streams.lastSeq(MODERN.stream),
        await stores.streams.lastSeq(MODERN.openStream),
      ],
    },
    processOps: stores.processOps
      ? {
          record: await stores.processOps.get(TENANT, MODERN.processOperation),
          list: await stores.processOps.list({ scope: TENANT }),
        }
      : null,
  });
}

/** A 2.4 worker continuing the V3 run 2.3 refused: it waited for a compatible worker (§4.6). */
export async function resumeV3(stores: CurrentStores, approvalId: string) {
  const session = memorySession(stores);
  const gate = gateTool();
  const { model, counter } = countingModel([{ text: 'deployed after approval' }]);
  const result = await resumeAgent({
    ...v3Options(stores, session, model, gate, MODERN.v3Suspended),
    approvalResponses: [{ approvalId, approved: true }],
  });
  return { result, modelCalls: counter.calls, toolCalls: gate.calls };
}

/** A 2.4 worker continuing a legacy run 2.3 started and suspended. */
export async function resumeLegacy(stores: CurrentStores, runId: string, approvalId: string) {
  const gate = gateTool();
  const { model, counter } = countingModel([{ text: 'resumed by 2.4' }]);
  const result = await resumeAgent({
    model,
    prompt: 'Deploy',
    tools: { gate: gate.tool },
    session: { store: stores.ops.agentRuns, runId, scope: TENANT },
    approvalResponses: [{ approvalId, approved: true }],
  });
  return { result, modelCalls: counter.calls, toolCalls: gate.calls };
}
