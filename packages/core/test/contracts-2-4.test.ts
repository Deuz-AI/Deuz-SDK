/**
 * The 2.4 contract skeletons (W0): every entry point a W1 lane implements is
 * published now under its final name, and until its lane lands it fails
 * loudly with `NotImplementedError` (code `not_implemented`) naming itself,
 * never silently. A promise-returning stub rejects instead of throwing. The
 * errors each entry re-exports are the shared classes, not copies.
 */
import { describe, expect, it } from 'vitest';
import * as errors from '../src/errors';
import { GoalError } from '../src/goal/errors';
import { NotImplementedError } from '../src/internal/not-implemented';
import * as versioned from '../src/memory/versioned';
import * as context from '../src/context';
import * as chat from '../src/chat';
import * as ui from '../src/ui';
import { createTokenEstimator } from '../src/internal/estimate-tokens';
import * as goalRuntime from '../src/goal/runtime';
import { agentRunLeaseKey } from '../src/ops';
import * as learning from '../src/skills/learning';
import * as docker from '../src/compute/docker';
import * as storesSqlite from '../src/node/store-sqlite';
import * as storesPostgres from '../src/node/store-postgres';
import * as storesRedis from '../src/node/store-redis';
import * as opsSqlite from '../src/node/ops-sqlite';
import * as opsPostgres from '../src/node/ops-postgres';
import * as vmemSqlite from '../src/node/vmem-sqlite';
import * as vmemPostgres from '../src/node/vmem-postgres';
import * as goalRuntimeSqlite from '../src/node/goal-runtime-sqlite';
import * as goalRuntimePostgres from '../src/node/goal-runtime-postgres';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';

function expectStub(name: string, call: () => unknown): void {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, name).toBeInstanceOf(NotImplementedError);
  expect((thrown as NotImplementedError).feature).toBe(name);
  expect((thrown as NotImplementedError).code).toBe('not_implemented');
}

async function expectAsyncStub(name: string, call: () => Promise<unknown>): Promise<void> {
  const error = await call().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, name).toBeInstanceOf(NotImplementedError);
  expect((error as NotImplementedError).feature).toBe(name);
}

const any = {} as never;

describe('/memory/versioned skeleton', () => {
  it('publishes the session, tools, in-memory store and import helper as stubs', async () => {
    expectStub('createMemorySession', () => versioned.createMemorySession(any));
    expectStub('createVersionedMemoryTools', () => versioned.createVersionedMemoryTools(any));
    expectStub('createInMemoryVersionedMemoryStore', () =>
      versioned.createInMemoryVersionedMemoryStore(),
    );
    await expectAsyncStub('importLegacyMemory', () => versioned.importLegacyMemory(any));
  });

  it('re-exports the shared conflict and mismatch errors', () => {
    expect(versioned.RevisionConflictError).toBe(errors.RevisionConflictError);
    expect(versioned.OperationConflictError).toBe(errors.OperationConflictError);
    expect(versioned.EmbeddingMismatchError).toBe(errors.EmbeddingMismatchError);
    expect(typeof versioned.defineAccountedMemoryLLM).toBe('function');
    expect(typeof versioned.isAccounted).toBe('function');
  });
});

describe('/context skeleton', () => {
  it('publishes the compiler, working memory and source adapters as stubs', () => {
    expectStub('compileContext', () => context.compileContext(any));
    expectStub('createContextCompiler', () => context.createContextCompiler(any));
    expectStub('createWorkingMemory', () => context.createWorkingMemory(any));
    expectStub('applyWorkingMemoryPatch', () => context.applyWorkingMemoryPatch(any, any, any));
    expectStub('workingMemoryTools', () => context.workingMemoryTools(any));
    expectStub('createMemoryContextSource', () => context.createMemoryContextSource(any));
    expectStub('createRagContextSource', () => context.createRagContextSource(any));
    expectStub('createTranscriptContextSource', () => context.createTranscriptContextSource(any));
    expectStub('createSkillsContextSource', () => context.createSkillsContextSource(any));
  });

  it('makes the one token estimator public, unchanged', () => {
    expect(context.createTokenEstimator).toBe(createTokenEstimator);
    const estimator = context.createTokenEstimator();
    expect(estimator.estimate([{ role: 'user', content: 'x'.repeat(36) }])).toBe(14);
  });

  it('pins the spec defaults the compiler implements', () => {
    expect(context.DEFAULT_CONTEXT_BUDGET).toEqual({
      ratio: 0.2,
      maxTokens: 8192,
      workingMemoryTokens: 1024,
      shares: { memory: 2, rag: 2, skills: 1, transcript: 1 },
      candidatesPerSource: 20,
    });
    expect(context.DEFAULT_CONTEXT_REFRESH).toEqual({ minSteps: 2, maxPasses: 4 });
    expect(context.ContextBudgetExceededError).toBe(errors.ContextBudgetExceededError);
  });
});

describe('/chat and /ui 2.4 additions', () => {
  it('publishes the conditional chat store, transcript index and backfill as stubs', async () => {
    expectStub('createInMemoryConditionalChatStore', () =>
      chat.createInMemoryConditionalChatStore(),
    );
    // Implemented by L7a: the in-memory index and the backfill.
    const index = chat.createInMemoryTranscriptIndex();
    await chat.indexChat(index, {
      chatId: 'c',
      scope: { userId: 'u' },
      messages: [{ role: 'user', content: 'hello' }],
      updatedAt: 1,
    });
    expect(await index.search({ userId: 'u' }, 'hello')).toHaveLength(1);
    expect(chat.RevisionConflictError).toBe(errors.RevisionConflictError);
  });

  it('publishes the durable stream store stub, its batch defaults and the capability handshake', () => {
    expectStub('createInMemoryDurableStreamStateStore', () =>
      ui.createInMemoryDurableStreamStateStore(),
    );
    expect(ui.DEFAULT_DURABLE_STREAM_BATCH).toEqual({ maxDelayMs: 20, maxBytes: 16_384 });
    expect(ui.DEUZ_CAPABILITIES_HEADER).toBe('x-deuz-capabilities');
    expect(typeof ui.parseDeuzCapabilities).toBe('function');
  });
});

describe('/goal/runtime skeleton', () => {
  it('publishes the supervisor, scheduler, webhook, store and acceptance entry points as stubs', async () => {
    expectStub('createGoalSupervisor', () => goalRuntime.createGoalSupervisor(any));
    expectStub('createNativeRunLauncher', () => goalRuntime.createNativeRunLauncher(any));
    expectStub('createDurableScheduler', () => goalRuntime.createDurableScheduler(any));
    expectStub('createWebhookHandler', () => goalRuntime.createWebhookHandler(any));
    expectStub('toNodeHandler', () => goalRuntime.toNodeHandler(any));
    expectStub('createInMemoryGoalRuntimeStore', () =>
      goalRuntime.createInMemoryGoalRuntimeStore(),
    );
    await expectAsyncStub('verifyGoalAcceptance', () => goalRuntime.verifyGoalAcceptance(any));
  });

  it('keys an inbox entry by scope, namespace and delivery id, on every store alike', () => {
    expect(goalRuntime.goalInboxKey('tenant-a', 'webhook:github', 'd-1')).toBe(
      'inbox:["tenant-a","webhook:github","d-1"]',
    );
    // A separator inside a part can never make two deliveries collide.
    expect(goalRuntime.goalInboxKey('a', 'b:c', 'd')).not.toBe(
      goalRuntime.goalInboxKey('a:b', 'c', 'd'),
    );
    expect(() => goalRuntime.goalInboxKey('', 'n', 'd')).toThrow(TypeError);
    expect(() => goalRuntime.goalInboxKey('s', 'n', '')).toThrow(TypeError);
  });

  it('keys the goal lease like a native run lease', () => {
    expect(goalRuntime.goalLeaseKey('tenant-a', 'g-1')).toBe('goal:["tenant-a","g-1"]');
    expect(agentRunLeaseKey({ scope: 'tenant-a', runId: 'g-1' })).toBe('agent:["tenant-a","g-1"]');
  });

  it('pins the spec defaults of the supervisor and the scheduler', () => {
    expect(goalRuntime.DEFAULT_GOAL_RUNTIME_POLICY).toEqual({
      maxRuns: 10,
      maxRetries: 3,
      retryDelaysMs: [1_000, 5_000, 30_000],
      retainPayloadMs: 604_800_000,
    });
    expect(goalRuntime.DEFAULT_GOAL_SUPERVISOR).toEqual({
      concurrency: 1,
      leaseTtlMs: 30_000,
      pollMs: 1_000,
    });
    expect(goalRuntime.DEFAULT_DURABLE_SCHEDULER).toEqual({
      graceMs: 60_000,
      maxDeliveriesPerTick: 100,
      maxScanMinutes: 10_000,
      pollMs: 1_000,
    });
    expect(goalRuntime.GoalError).toBe(GoalError);
  });
});

describe('/skills/learning skeleton', () => {
  it('publishes proposeSkillFromRun as a stub and a typed refusal', async () => {
    await expectAsyncStub('proposeSkillFromRun', () => learning.proposeSkillFromRun(any));
    const error = new learning.SkillLearningError('source_too_large', 'too large');
    expect(errors.isDeuzError(error)).toBe(true);
    expect(error.code).toBe('source_too_large');
  });
});

describe('/compute/docker skeleton (Node-only)', () => {
  it('publishes the sandbox, runner and operation stores as stubs', () => {
    expectStub('createDockerSandbox', () => docker.createDockerSandbox(any));
    expectStub('createDockerProcessRunner', () => docker.createDockerProcessRunner(any));
    expectStub('createInMemoryProcessOperationStore', () =>
      docker.createInMemoryProcessOperationStore(),
    );
    expectStub('createSqliteProcessOperationStore', () =>
      docker.createSqliteProcessOperationStore(any),
    );
    expect(docker.OperationConflictError).toBe(errors.OperationConflictError);
  });

  it('pins the isolation and size defaults of spec §3.3', () => {
    expect(docker.DEFAULT_DOCKER_SANDBOX).toMatchObject({
      user: '10001:10001',
      network: 'none',
      cpus: 1,
      memoryBytes: 536_870_912,
      pids: 128,
      maxStagingBytes: 268_435_456,
      maxArtifactBytes: 67_108_864,
      cancelGraceMs: 2_000,
    });
  });
});

describe('2.4 Node stores on their entries', () => {
  it('reach the existing /stores and /ops entries through appended exports', () => {
    expectStub('createSqliteConditionalChatStore', () =>
      storesSqlite.createSqliteConditionalChatStore(any),
    );
    expectStub('createSqliteDurableStreamStateStore', () =>
      storesSqlite.createSqliteDurableStreamStateStore(any),
    );
    expectStub('createPostgresConditionalChatStore', () =>
      storesPostgres.createPostgresConditionalChatStore(any),
    );
    expectStub('createPostgresDurableStreamStateStore', () =>
      storesPostgres.createPostgresDurableStreamStateStore(any),
    );
    expectStub('createRedisDurableStreamStateStore', () =>
      storesRedis.createRedisDurableStreamStateStore(any),
    );
    expectStub('createSqliteAgentRunStoreV3', () => opsSqlite.createSqliteAgentRunStoreV3(any));
    expectStub('createPostgresAgentRunStoreV3', () =>
      opsPostgres.createPostgresAgentRunStoreV3(any),
    );
    expectStub('createInMemoryAgentRunStoreV3', () => createInMemoryAgentRunStoreV3());
  });

  it('keep the existing entry factories exported as before', () => {
    expect(typeof storesSqlite.createSqliteStores).toBe('function');
    expect(typeof storesPostgres.createPostgresStores).toBe('function');
    expect(typeof storesRedis.createRedisStores).toBe('function');
    expect(typeof opsSqlite.createSqliteOpsStore).toBe('function');
    expect(typeof opsPostgres.createPostgresOpsStore).toBe('function');
  });

  it('publish the versioned memory and goal runtime stores on their own subpaths', () => {
    expectStub('createSqliteVersionedMemoryStore', () =>
      vmemSqlite.createSqliteVersionedMemoryStore(any),
    );
    expectStub('createPostgresVersionedMemoryStore', () =>
      vmemPostgres.createPostgresVersionedMemoryStore(any),
    );
    expectStub('createSqliteGoalRuntimeStore', () =>
      goalRuntimeSqlite.createSqliteGoalRuntimeStore(any),
    );
    expectStub('createPostgresGoalRuntimeStore', () =>
      goalRuntimePostgres.createPostgresGoalRuntimeStore(any),
    );
  });
});
