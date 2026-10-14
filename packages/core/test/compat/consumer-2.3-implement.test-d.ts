/**
 * Frozen 2.3 consumer fixture (2.4, W0A), part 2: the interfaces a 2.3
 * application IMPLEMENTS and the client handles it PASSES IN.
 *
 * Every object below implements one interface the way a 2.3 consumer would:
 * its required members and the records it returns, built from the 2.3 field
 * set, then handed to the SDK where the SDK takes it. A 2.4 change that adds a
 * required member to one of these interfaces, a required field to a record a
 * store returns, or a stricter return type breaks this file, as it would break
 * that application. Optional members a consumer may implement are implemented
 * too, so a change to their signature breaks here as well.
 *
 * Imports point at the source file behind each public subpath (tsup entry
 * map): `../../src/agent` is `@deuz-sdk/core/agent`, `../../src/node/ops-sqlite`
 * is `@deuz-sdk/core/ops/sqlite`, and so on. Part 1 is `consumer-2.3.test-d.ts`.
 */
import { expectTypeOf, test } from 'vitest';
// @deuz-sdk/core
import { generateText, streamChat, wrapModel, createClient } from '../../src/index';
import type {
  BreakerState,
  BreakerStore,
  Clock,
  Dependencies,
  KeyProvider,
  LanguageModel,
  Logger,
  Message,
  ObserveEvent,
  Observer,
  PriceProvider,
  PriceUsageOptions,
  SessionStore,
  AgentCheckpoint,
  Span,
  SpanOptions,
  StreamPart,
  ToolApprovalRequest,
  Tracer,
  Usage,
} from '../../src/index';
// @deuz-sdk/core/middleware
import type { LanguageModelMiddleware } from '../../src/middleware';
// @deuz-sdk/core/agent
import {
  createInMemoryAgentRunStore,
  runAgent,
  createExecutionContext,
  createBudgetLedger,
} from '../../src/agent';
import type {
  AgentRunEnvelope,
  AgentRunListPage,
  AgentRunListQuery,
  AgentRunStore,
  BudgetHold,
  BudgetHoldQuery,
  BudgetPruneOptions,
  BudgetPruneResult,
  BudgetStore,
  BudgetStoreReservation,
  BudgetStoreReserveInput,
  BudgetSweepOptions,
  BudgetSweepResult,
  BudgetUsage,
  BudgetUsageOptions,
} from '../../src/agent';
// @deuz-sdk/core/ops
import { agentRunLeaseKey } from '../../src/ops';
import type {
  Lease,
  LeaseProvider,
  LeaseRenewal,
  LeaseRenewOptions,
  LeaseSignal,
} from '../../src/ops';
// @deuz-sdk/core/memory
import { remember, recall, createMemoryTools } from '../../src/memory';
import type {
  Embedder as MemoryEmbedder,
  MemoryHit,
  MemoryKind,
  MemoryLLM,
  MemoryQuery,
  MemoryRecord,
  MemoryScope,
  MemorySeams,
  MemoryStore,
} from '../../src/memory';
// @deuz-sdk/core/chat
import type { ChatRecord, ChatStore } from '../../src/chat';
// @deuz-sdk/core/ui
import { toDeuzStreamResponse, resumeDeuzStreamResponse } from '../../src/ui';
import type { StreamStateRecord, StreamStateStore } from '../../src/ui';
// @deuz-sdk/core/runtime
import { createRunManager } from '../../src/runtime';
import type { RunRecord, RunStatus, RunStore } from '../../src/runtime';
// @deuz-sdk/core/durable
import { resumeFromCheckpoint } from '../../src/durable';
import type { ApprovalSigner, SignedApprovalPayload } from '../../src/durable';
// @deuz-sdk/core/goal
import { createGoal } from '../../src/goal/index';
import type { GoalListPage, GoalListQuery, GoalRecord, GoalStore } from '../../src/goal/index';
// @deuz-sdk/core/schedule
import { createScheduler, handleSignal } from '../../src/schedule';
import type { ScheduleClaim } from '../../src/schedule';
// @deuz-sdk/core/swarm
import { createSwarm } from '../../src/swarm';
import type {
  SwarmChannelEntry,
  SwarmCommit,
  SwarmEvent,
  SwarmEventInput,
  SwarmKey,
  SwarmPruneOptions,
  SwarmRunQuery,
  SwarmRunRecord,
  SwarmSnapshot,
  SwarmStore,
  SwarmStoreCapability,
} from '../../src/swarm';
// @deuz-sdk/core/evolve
import type {
  EvolveCandidate,
  EvolveCandidateQuery,
  EvolveGenerationCommit,
  EvolveKey,
  EvolveRunRecord,
  PopulationStore,
} from '../../src/evolve';
// @deuz-sdk/core/a2a
import { createA2AHandler } from '../../src/a2a/index';
import type { A2ATask, A2ATaskScope, A2ATaskStore } from '../../src/a2a/index';
// @deuz-sdk/core/batch
import { createBatchClient } from '../../src/batch/index';
import type { BatchJob, BatchJobStore } from '../../src/batch/index';
// @deuz-sdk/core/mcp
import type {
  McpClient,
  McpConnectionStatus,
  McpGetPromptResult,
  McpPrompt,
  McpResource,
  McpResourceContent,
  McpSdkLine,
  TokenStore,
} from '../../src/mcp/index';
// @deuz-sdk/core/compute
import { codeActTool, shellTool } from '../../src/compute';
import type {
  CodeExecutionRequest,
  CodeExecutionResult,
  ComputeSandbox,
  ShellExecutionRequest,
  ShellExecutionResult,
} from '../../src/compute';
// @deuz-sdk/core/rag
import { retrieve, indexChunks, createParserRegistry } from '../../src/rag';
import type {
  Embedder as RagEmbedder,
  EmbeddedChunk,
  Reranker,
  ScoredChunk,
  VectorStore,
  DocumentParser,
  ParsedDocument,
} from '../../src/rag';
// @deuz-sdk/core/stores/sqlite, /stores/postgres, /stores/redis
import { createSqliteStores, type SqliteDatabaseLike } from '../../src/node/store-sqlite';
import { createPostgresStores, type PgClientLike } from '../../src/node/store-postgres';
import {
  createRedisStores,
  wrapIoredisClient,
  type IoredisClientLike,
  type RedisClientLike,
  type RedisScriptClient,
} from '../../src/node/store-redis';
// @deuz-sdk/core/ops/sqlite, /ops/postgres, /ops/redis
import { createSqliteOpsStore, createSqliteBudgetStore } from '../../src/node/ops-sqlite';
import { createPostgresOpsStore, createPostgresBudgetStore } from '../../src/node/ops-postgres';
import { createRedisOpsStore, createRedisBudgetStore } from '../../src/node/ops-redis';
// @deuz-sdk/core/swarm/sqlite, /swarm/postgres, /swarm/redis, /evolve/sqlite
import { createSqliteSwarmStore } from '../../src/node/swarm-sqlite';
import { createPostgresSwarmStore } from '../../src/node/swarm-postgres';
import { createRedisSwarmStore } from '../../src/node/swarm-redis';
import { createSqlitePopulationStore } from '../../src/node/evolve-sqlite';

declare const model: LanguageModel;
declare const messages: Message[];
declare const goal: GoalRecord;

const USAGE: Usage = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 2,
};

// ---------------------------------------------------------------------------
// Dependencies seams (`deps`)
// ---------------------------------------------------------------------------

test('the Dependencies seams a consumer injects', () => {
  const clock: Clock = {
    now: () => 0,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
  const logger: Logger = {
    debug: (_message: string, _fields?: Record<string, unknown>) => {},
    info: (_message: string, _fields?: Record<string, unknown>) => {},
    warn: (_message: string, _fields?: Record<string, unknown>) => {},
    error: (_message: string, _fields?: Record<string, unknown>) => {},
  };
  const span: Span = {
    setAttribute: (_key: string, _value: unknown) => {},
    recordException: (_error: unknown) => {},
    end: () => {},
  };
  const tracer: Tracer = {
    startSpan: (_name: string, _attributes?: Record<string, unknown>, _options?: SpanOptions) =>
      span,
  };
  const breakerStore: BreakerStore = {
    get: async (_key: string): Promise<BreakerState | undefined> => ({
      failures: 0,
      openedAt: 0,
      cooldownUntil: 0,
    }),
    set: (_key: string, _state: BreakerState) => {},
  };
  const keyProvider: KeyProvider = { getKey: async (_provider: string) => 'key' };
  const priceProvider: PriceProvider = {
    priceUsage: (_model: string, _usage: Usage, _options?: PriceUsageOptions) => 0.01,
    cacheSavings: async (_model: string, _usage: Usage, _options?: PriceUsageOptions) => 0,
  };
  // A Usage built from the 2.3 fields (a consumer's own pricing tests do this).
  expectTypeOf(priceProvider.priceUsage('m', USAGE, { tier: 'batch' })).not.toBeAny();
  const observer: Observer = {
    options: { enabled: true, sampleRate: 1 },
    emit: (_event: ObserveEvent) => {},
    flush: async () => {},
    close: () => {},
  };
  const deps: Dependencies = {
    fetch: globalThis.fetch,
    clock,
    logger,
    tracer,
    tracerMode: 'hierarchical',
    breakerStore,
    keyProvider,
    priceProvider,
    generateId: () => 'id',
    onUsage: (_usage, _meta) => {},
    onFinish: (_meta) => {},
    observer,
  };
  expectTypeOf(generateText({ model, prompt: 'hi', deps })).resolves.toHaveProperty('text');
  expectTypeOf(createClient({ apiKeys: { anthropic: 'k' }, deps })).toHaveProperty('generateText');
});

test('a model middleware', () => {
  const middleware: LanguageModelMiddleware = {
    name: 'audit',
    transformParams: async (options, ctx) => {
      expectTypeOf(ctx.operation).toExtend<'stream' | 'generate'>();
      return options;
    },
    wrapGenerate: async (next, options, _ctx) => next(options),
    wrapStream: (next, options, _ctx) => next(options),
  };
  const wrapped = wrapModel(model, [middleware]);
  expectTypeOf(wrapped.model).toEqualTypeOf<LanguageModel>();
  expectTypeOf(wrapped.streamChat({ prompt: 'hi' })).toHaveProperty('fullStream');
  expectTypeOf(wrapped.generateText({ prompt: 'hi' })).resolves.toHaveProperty('text');
  expectTypeOf(streamChat({ model, prompt: 'hi' })).toHaveProperty('fullStream');
});

// ---------------------------------------------------------------------------
// Persistence the loops and runs read and write
// ---------------------------------------------------------------------------

test('a SessionStore (durable legacy checkpoints)', async () => {
  const saved = new Map<string, AgentCheckpoint>();
  const store: SessionStore = {
    save: async (checkpoint: AgentCheckpoint) => {
      saved.set(checkpoint.runId, checkpoint);
    },
    load: (runId: string) => saved.get(runId),
    delete: (runId: string) => {
      saved.delete(runId);
    },
    list: async () => [...saved.keys()],
  };
  await generateText({ model, prompt: 'hi', session: { store, runId: 'r', durability: 'strict' } });
  expectTypeOf(resumeFromCheckpoint(store, 'r', { model })).resolves.toHaveProperty('text');
});

test('a RunStore (background runs)', () => {
  const runs = new Map<string, RunRecord>();
  const status: RunStatus = 'queued';
  const store: RunStore = {
    create: (record: RunRecord) => {
      runs.set(record.runId, record);
    },
    update: async (runId: string, patch: Partial<Omit<RunRecord, 'runId'>>) => {
      const run = runs.get(runId);
      if (run) runs.set(runId, { ...run, ...patch });
    },
    get: (runId: string) => runs.get(runId),
    list: (filter?: { status?: RunStatus }) =>
      [...runs.values()].filter((r) => !filter?.status || r.status === filter.status),
    delete: (runId: string) => {
      runs.delete(runId);
    },
  };
  const record: RunRecord = { runId: 'r', status, createdAt: 0, updatedAt: 0 };
  store.create(record);
  expectTypeOf(createRunManager({ store })).toHaveProperty('startRun');
});

test('a ChatStore (chat persistence)', async () => {
  const chats = new Map<string, ChatRecord>();
  const store: ChatStore = {
    saveChat: async (record: ChatRecord) => {
      chats.set(record.chatId, record);
    },
    loadChat: (chatId: string) => chats.get(chatId),
    deleteChat: (chatId: string) => {
      chats.delete(chatId);
    },
    listChats: async (_scope?: MemoryScope) => [...chats.keys()],
  };
  const record: ChatRecord = {
    chatId: 'c',
    scope: { userId: 'u' },
    messages,
    updatedAt: 0,
    parentId: 'p',
    messageIds: ['m1'],
  };
  await store.saveChat(record);
  await generateText({ model, prompt: 'hi', chat: { store, chatId: 'c', scope: { userId: 'u' } } });
  await runAgent({ model, prompt: 'hi', chat: { store, chatId: 'c', scope: { userId: 'u' } } });
});

test('a MemoryStore, an Embedder and a MemoryLLM (built-in memory)', async () => {
  const records = new Map<string, MemoryRecord>();
  const kind: MemoryKind = 'semantic';
  const record: MemoryRecord = {
    id: 'm',
    text: 'fact',
    hash: 'h',
    kind,
    scope: { userId: 'u', agentId: 'a', runId: 'r', actorId: 'x', chatId: 'c' },
    createdAt: 0,
    updatedAt: 0,
    metadata: { tags: ['t'] },
    importance: 0.5,
    embedding: [0.1],
    embeddingModelId: 'model',
    expiresAt: 10,
    validAt: 0,
    invalidAt: null,
  };
  const store: MemoryStore = {
    upsert: async (input: MemoryRecord[]) => {
      for (const r of input) records.set(r.id, r);
    },
    get: async (id: string, _scope?: MemoryScope) => records.get(id) ?? null,
    search: async (query: MemoryQuery): Promise<MemoryHit[]> =>
      [...records.values()]
        .filter((r) => (query.kind ? r.kind === query.kind : true))
        .slice(0, query.topK ?? 5)
        .map((r) => ({ record: r, score: 1 })),
    list: async (_scope: MemoryScope, opts?: { kind?: MemoryKind; limit?: number }) =>
      [...records.values()].slice(0, opts?.limit),
    delete: async (ids: string[]) => {
      for (const id of ids) records.delete(id);
    },
    update: async (id: string, patch: Partial<MemoryRecord>) => {
      const r = records.get(id);
      if (r) records.set(id, { ...r, ...patch });
    },
    findByHash: async (hashes: string[], _scope: MemoryScope) =>
      [...records.values()].filter((r) => hashes.includes(r.hash)),
    deleteExpired: async (_now: number, _scope?: MemoryScope) => 0,
  };
  await store.upsert([record]);
  const embedder: MemoryEmbedder = {
    embed: async (texts: string[], _action: 'add' | 'search' | 'update') => ({
      vectors: texts.map(() => [0.1]),
      model: 'model',
    }),
  };
  const llm: MemoryLLM = async (prompt: { system: string; user: string }) => prompt.user;
  const seams: MemorySeams = {
    store,
    embedder,
    llm,
    clock: { now: () => 0, setTimeout: () => () => {} },
    generateId: () => 'id',
    hashFn: async (text: string) => text,
    logger: { warn: (_message: string, _fields?: Record<string, unknown>) => {} },
  };
  const scope: MemoryScope = { userId: 'u' };
  await generateText({ model, prompt: 'hi', memory: { seams, scope, recall: { topK: 3 } } });
  await runAgent({ model, prompt: 'hi', memory: { seams, scope, extract: false } });
  expectTypeOf(remember(messages, scope, seams)).resolves.toBeArray();
  expectTypeOf(recall({ scope, text: 'q' }, seams)).resolves.toBeArray();
  expectTypeOf(createMemoryTools({ scope, seams })).toBeObject();
});

test('a StreamStateStore (resumable UI streams)', () => {
  const streams = new Map<string, StreamStateRecord[]>();
  const store: StreamStateStore = {
    append: async (streamId: string, seq: number, part: StreamStateRecord['part']) => {
      const list = streams.get(streamId) ?? [];
      list.push({ seq, part });
      streams.set(streamId, list);
    },
    read: async function* (streamId: string, fromSeq?: number) {
      for (const record of streams.get(streamId) ?? []) {
        if (fromSeq === undefined || record.seq >= fromSeq) yield record;
      }
    },
    lastSeq: (streamId: string) => streams.get(streamId)?.at(-1)?.seq,
    delete: (streamId: string) => {
      streams.delete(streamId);
    },
  };
  const result = streamChat({ model, prompt: 'hi' });
  expectTypeOf(toDeuzStreamResponse(result, { store, streamId: 's' })).toEqualTypeOf<Response>();
  expectTypeOf(resumeDeuzStreamResponse(store, 's', { lastEventId: 3 })).toEqualTypeOf<Response>();
});

test('an AgentRunStore (native runs)', async () => {
  const runs = new Map<string, AgentRunEnvelope>();
  const store: AgentRunStore = {
    load: (runId: string) => runs.get(runId),
    save: async (envelope: AgentRunEnvelope) => {
      runs.set(envelope.runId, envelope);
    },
    list: async (_query?: AgentRunListQuery): Promise<AgentRunListPage> => ({
      runs: [...runs.values()].map((e) => ({
        runId: e.runId,
        scope: e.scope,
        phase: e.phase,
        revision: 1,
        updatedAt: 0,
      })),
      cursor: undefined,
    }),
  };
  const result = await runAgent({
    model,
    prompt: 'hi',
    session: { store, runId: 'r', scope: 't' },
  });
  expectTypeOf(result.status).toExtend<string>();
  expectTypeOf(createInMemoryAgentRunStore()).toExtend<AgentRunStore>();
});

test('a LeaseProvider (cross-process claims)', async () => {
  const leases = new Map<string, Lease>();
  const provider: LeaseProvider = {
    acquire: async (request: { key: string; owner: string; ttlMs: number }) => {
      const lease: Lease = {
        key: request.key,
        owner: request.owner,
        token: 1,
        expiresAt: request.ttlMs,
      };
      leases.set(lease.key, lease);
      return lease;
    },
    renew: async (lease: Lease, _ttlMs: number, _options?: LeaseRenewOptions) => {
      const renewal: LeaseRenewal = leases.has(lease.key)
        ? { held: true, lease, signals: [], queued: [] }
        : { held: false };
      return renewal;
    },
    release: async (lease: Lease) => {
      leases.delete(lease.key);
    },
    signal: async (_key: string, _signal: LeaseSignal) => true,
    ack: async (_lease: Lease, _signal: 'cancel') => true,
    prune: async (_before: number) => 0,
  };
  const session = { store: createInMemoryAgentRunStore(), runId: 'r', scope: 't' };
  await runAgent({ model, prompt: 'hi', session, lease: { provider, owner: 'me', ttlMs: 30_000 } });
  expectTypeOf(agentRunLeaseKey(session)).toBeString();
});

test('a BudgetStore (persistent budget scopes)', () => {
  const store: BudgetStore = {
    reserve: async (input: BudgetStoreReserveInput): Promise<BudgetStoreReservation> =>
      input.scopes.length > 0
        ? { admitted: true, scopes: input.scopes.map((s) => ({ key: s.key, tokens: 0, usd: 0 })) }
        : { admitted: false, key: 'k', dimension: 'usd', limit: 1, committed: 1 },
    settle: async (_requestId: string, _actual: { tokens: number; usd: number }) => {},
    release: async (_requestId: string) => {},
    usage: async (_key: string, _options?: BudgetUsageOptions): Promise<BudgetUsage> => ({
      tokens: 0,
      usd: 0,
      byModel: { m: { tokens: 0, usd: 0 } },
    }),
    prune: async (_options: BudgetPruneOptions): Promise<BudgetPruneResult> => ({
      requests: 0,
      buckets: 0,
    }),
    holds: async (_query: BudgetHoldQuery): Promise<BudgetHold[]> => [
      { requestId: 'r', modelId: 'm', tokens: 0, usd: 0, reservedAt: 0, keys: ['k'] },
    ],
    sweep: async (_options: BudgetSweepOptions): Promise<BudgetSweepResult> => ({
      settled: 0,
      released: 0,
      skipped: 0,
    }),
  };
  const execution = createExecutionContext({
    budget: { usd: 1, tokens: 10_000, unknownPrice: 'reject' },
    admission: {
      store,
      scopes: [{ key: 'org', limits: { usd: 10 }, window: { ms: 86_400_000 }, warnAtPercent: 80 }],
      warnAtPercent: 90,
      onWarning: (_warning) => {},
    },
    policy: { allowedTools: ['search'], maxDepth: 2, requireApproval: false },
    scopeId: 'org',
  });
  expectTypeOf(execution).not.toBeAny();
  expectTypeOf(createBudgetLedger({ budget: { usd: 1 } })).toHaveProperty('reserve');
});

test('a GoalStore', async () => {
  const goals = new Map<string, GoalRecord>();
  const store: GoalStore = {
    load: (goalId: string) => goals.get(goalId),
    save: async (record: GoalRecord) => {
      goals.set(record.goalId, record);
    },
    list: async (query?: GoalListQuery): Promise<GoalListPage> => ({
      goals: [...goals.values()].slice(0, query?.limit),
      cursor: undefined,
    }),
  };
  await store.save(createGoal({ goalId: 'g', scope: 's', objective: 'o' }, { now: 0 }));
  expectTypeOf(await store.load('g')).toEqualTypeOf<GoalRecord | undefined>();
  expectTypeOf(goal.goalId).toBeString();
});

test('a ScheduleClaim (scheduler and signal dedupe)', () => {
  const claimed = new Set<string>();
  const claim: ScheduleClaim = Object.assign(
    async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    { release: (key: string) => claimed.delete(key) },
  );
  const scheduler = createScheduler({
    schedules: [{ id: 'nightly', cron: '0 3 * * *', run: () => {} }],
    claim,
    catchUp: 'latest',
  });
  expectTypeOf(scheduler.tick()).resolves.toHaveProperty('occurrences');
  expectTypeOf(handleSignal).toBeFunction();
});

test('a SwarmStore', () => {
  const capability: SwarmStoreCapability = 'spawn';
  const store: SwarmStore = {
    capabilities: [capability, 'channels', 'list'],
    create: async (
      _snapshot: SwarmSnapshot,
      _events: readonly SwarmEventInput[],
    ): Promise<SwarmRunRecord> => ({}) as SwarmRunRecord,
    load: async (_key: SwarmKey): Promise<SwarmSnapshot | undefined> => undefined,
    head: async (_key: SwarmKey): Promise<SwarmRunRecord | undefined> => undefined,
    commit: async (_change: SwarmCommit): Promise<SwarmRunRecord> => ({}) as SwarmRunRecord,
    readChannel: async (
      _key: SwarmKey,
      _channel: string,
      _afterSequence: number,
      _limit: number,
    ): Promise<SwarmChannelEntry[]> => [],
    readEvents: async (
      _key: SwarmKey,
      _afterSequence: number,
      _limit: number,
    ): Promise<SwarmEvent[]> => [],
    listRuns: async (_query: SwarmRunQuery): Promise<SwarmRunRecord[]> => [],
    prune: async (_options: SwarmPruneOptions) => 0,
  };
  expectTypeOf(createSwarm).parameter(0).toHaveProperty('store');
  expectTypeOf(store).toExtend<SwarmStore>();
});

test('a PopulationStore (evolve)', () => {
  const store: PopulationStore = {
    createRun: async (_run: EvolveRunRecord) => {},
    loadRun: async (_key: EvolveKey): Promise<EvolveRunRecord | undefined> => undefined,
    putCandidate: async (_candidate: EvolveCandidate) => true,
    listCandidates: async (
      _key: EvolveKey,
      _query?: EvolveCandidateQuery,
    ): Promise<EvolveCandidate[]> => [],
    commitGeneration: async (_commit: EvolveGenerationCommit) => {},
    saveRun: async (_run: EvolveRunRecord) => {},
  };
  expectTypeOf(store).toExtend<PopulationStore>();
});

test('an A2ATaskStore', () => {
  const tasks = new Map<string, A2ATask>();
  const store: A2ATaskStore = {
    load: (taskId: string, _scope: A2ATaskScope) => tasks.get(taskId),
    save: async (task: A2ATask, _scope: A2ATaskScope) => {
      tasks.set(task.id, task);
    },
  };
  expectTypeOf(createA2AHandler).parameter(0).toHaveProperty('taskStore');
  expectTypeOf(store).toExtend<A2ATaskStore>();
});

test('a BatchJobStore', () => {
  const jobs = new Map<string, BatchJob>();
  const store: BatchJobStore = {
    put: async (job: BatchJob) => {
      jobs.set(job.id, job);
    },
    get: async (id: string) => jobs.get(id),
    list: async () => [...jobs.values()],
    delete: async (id: string) => {
      jobs.delete(id);
    },
  };
  expectTypeOf(createBatchClient({ model, store })).toHaveProperty('submit');
});

test('an MCP TokenStore', () => {
  const tokens = new Map<string, string>();
  const store: TokenStore = {
    get: (key: string) => tokens.get(key),
    set: async (key: string, value: string) => {
      tokens.set(key, value);
    },
    delete: (key: string) => {
      tokens.delete(key);
    },
  };
  expectTypeOf(store).toExtend<TokenStore>();
});

test('an McpClient passed to the loop as { client }', async () => {
  const status: McpConnectionStatus = 'connected';
  const client: McpClient = {
    listTools: async (_namespace?: string) => ({}),
    callTool: async (_name: string, _args: unknown) => null,
    listResources: async (): Promise<McpResource[]> => [],
    readResource: async (_uri: string): Promise<McpResourceContent[]> => [],
    listPrompts: async (): Promise<McpPrompt[]> => [],
    getPrompt: async (_name: string, _args?: Record<string, string>): Promise<McpGetPromptResult> =>
      ({}) as McpGetPromptResult,
    status: () => status,
    serverInfo: () => ({ name: 'server', version: '1' }),
    protocolVersion: () => '2025-06-18',
    sdk: (): McpSdkLine | undefined => undefined,
    onToolListChanged: (_cb: () => void) => () => {},
    close: async () => {},
  };
  await generateText({ model, prompt: 'hi', mcp: [{ client, namespace: 'docs' }] });
  await runAgent({ model, prompt: 'hi', mcp: [{ client }] });
});

test('an ApprovalSigner', async () => {
  const signer: ApprovalSigner = {
    sign: async (request: ToolApprovalRequest, _context?: { runId?: string }) => request.approvalId,
    verify: async (
      _token: string,
      _options?: { maxAgeMs?: number },
    ): Promise<SignedApprovalPayload | null> => null,
  };
  await generateText({ model, prompt: 'hi', approvalSigner: signer, approvalMaxAgeMs: 60_000 });
});

test('a ComputeSandbox', () => {
  const run = async (_request: CodeExecutionRequest): Promise<CodeExecutionResult> => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
  });
  const sandbox: ComputeSandbox = {
    runCode: run,
    runShell: async (request: ShellExecutionRequest): Promise<ShellExecutionResult> =>
      run({ language: 'sh', code: request.command }),
  };
  expectTypeOf(codeActTool(sandbox, { name: 'runCode' })).toBeObject();
  expectTypeOf(shellTool(sandbox)).toBeObject();
});

test('the RAG seams: Embedder, VectorStore, Reranker, DocumentParser', async () => {
  const embedder: RagEmbedder = {
    embed: async (texts: string[]) => texts.map(() => [0.1]),
    dims: 1,
  };
  const items: EmbeddedChunk[] = [];
  const store: VectorStore = {
    upsert: async (input: EmbeddedChunk[]) => {
      items.push(...input);
    },
    query: async (_vector: number[], topK: number): Promise<ScoredChunk[]> =>
      items.slice(0, topK).map((c) => ({ text: c.text, index: c.index, score: 1 })),
  };
  const reranker: Reranker = {
    rerank: async (_query: string, candidates: ScoredChunk[], topN: number) =>
      candidates.slice(0, topN),
  };
  const parser: DocumentParser = async (_input): Promise<ParsedDocument> => ({}) as ParsedDocument;
  await indexChunks([{ text: 't', index: 0 }], { embedder, store });
  expectTypeOf(retrieve('q', { embedder, store, reranker }, { topK: 4 })).resolves.toBeArray();
  expectTypeOf(createParserRegistry).toBeFunction();
  expectTypeOf(parser).toBeFunction();
});

// ---------------------------------------------------------------------------
// Client handles a consumer passes to the node store factories
// ---------------------------------------------------------------------------

test('a query-only Postgres client works with every 2.3 Postgres factory', () => {
  // The 2.3 contract is one method. New 2.4 stores may ask for more; these may not.
  const client: PgClientLike = {
    query: async (_sql: string, _params?: unknown[]) => ({ rows: [] }),
  };
  expectTypeOf(createPostgresStores({ client, schema: 'app', pgvector: 'off' })).toHaveProperty(
    'migrate',
  );
  expectTypeOf(createPostgresStores({ connectionString: 'postgres://x' })).toHaveProperty('memory');
  expectTypeOf(createPostgresOpsStore({ client, schema: 'app' })).toHaveProperty('agentRuns');
  expectTypeOf(createPostgresBudgetStore({ client, schema: 'app' })).toHaveProperty('reserve');
  expectTypeOf(createPostgresSwarmStore({ client, schema: 'app' })).toHaveProperty('commit');
});

test('a four-member SQLite handle works with every 2.3 SQLite factory', () => {
  const database: SqliteDatabaseLike = {
    prepare: (_sql: string) => ({
      run: (..._params: unknown[]) => undefined,
      get: (..._params: unknown[]) => undefined,
      all: (..._params: unknown[]) => [],
    }),
    exec: (_sql: string) => {},
    close: () => {},
  };
  expectTypeOf(
    createSqliteStores({ path: ':memory:', database, wal: false, fts: true }),
  ).toHaveProperty('sessions');
  expectTypeOf(createSqliteOpsStore({ path: 'ops.db', database })).toHaveProperty('leases');
  expectTypeOf(createSqliteBudgetStore({ path: 'ops.db', database })).toHaveProperty('usage');
  expectTypeOf(createSqliteSwarmStore({ path: 'swarm.db', database })).toHaveProperty('load');
  expectTypeOf(createSqlitePopulationStore({ path: 'evolve.db', database })).toHaveProperty(
    'loadRun',
  );
});

declare const ioredis: IoredisClientLike;
declare const nodeRedis: RedisClientLike;

test('the Redis clients a consumer passes', () => {
  const scripts: RedisScriptClient = {
    eval: async (_script: string, _options: { keys: string[]; arguments: string[] }) => null,
  };
  expectTypeOf(createRedisStores({ client: nodeRedis, prefix: 'app' })).toHaveProperty('chats');
  expectTypeOf(createRedisStores({ client: wrapIoredisClient(ioredis) })).toHaveProperty('memory');
  expectTypeOf(createRedisStores({ url: 'redis://localhost' })).toHaveProperty('runs');
  expectTypeOf(createRedisOpsStore({ client: scripts, prefix: 'app' })).toHaveProperty('leases');
  expectTypeOf(createRedisBudgetStore({ client: scripts })).toHaveProperty('reserve');
  expectTypeOf(createRedisSwarmStore({ client: scripts })).toHaveProperty('commit');
  expectTypeOf(createRedisOpsStore({ url: 'redis://localhost' })).toHaveProperty('agentRuns');
});

test('stream parts a store or observer receives keep their 2.3 shape', () => {
  expectTypeOf<StreamPart>().toHaveProperty('type');
});
