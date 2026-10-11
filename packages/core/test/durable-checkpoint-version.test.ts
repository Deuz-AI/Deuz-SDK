import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CheckpointNotFoundError,
  CheckpointVersionError,
  createInMemorySessionStore,
  deserializeCheckpoint,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
  serializeCheckpoint,
} from '../src/durable';
import { createPostgresStores } from '../src/node/store-postgres';
import { createSqliteStores } from '../src/node/store-sqlite';
import { createRedisStores, type RedisClientLike } from '../src/node/store-redis';
import type { PgClientLike } from '../src/node/store-postgres';
import type { StreamPart } from '../src/types/stream';
import type { AgentCheckpoint, SessionStore } from '../src/types/session';
import type { AgentRunEnvelope, AgentRunStore } from '../src/types/agent-run';
import { createAnthropic } from '../src/anthropic';
import { createInMemoryAgentRunStore, resumeAgent, runAgent } from '../src/agent-run';
import { agentTool } from '../src/inference/agent-tool';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';

// AgentCheckpoint.version (1.5) is the legacy loops' forward-compatibility
// gate, but nothing read it: a checkpoint written by a newer SDK resumed as if
// this build understood it. 2.3 refuses one it cannot read, on every read path.

function checkpoint(version: unknown, runId = 'run-v'): AgentCheckpoint {
  return {
    version,
    runId,
    stepId: `${runId}#1`,
    stepIndex: 1,
    status: 'suspended',
    messages: [{ role: 'user', content: 'hello' }],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 2,
    },
    createdAt: 1,
  } as unknown as AgentCheckpoint;
}

function storeWith(saved: AgentCheckpoint): SessionStore {
  const store = createInMemorySessionStore();
  store.save(saved);
  return store;
}

/** A model whose every request the test can count: a refused resume sends none. */
function untouchedModel() {
  const spy = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
  return { model: createAnthropic({ apiKey: 'k', fetch: spy })('claude-opus-4-8'), spy };
}

describe('checkpoint version (2.3)', () => {
  it('reads version 1 and a checkpoint without a version, unchanged', () => {
    expect(deserializeCheckpoint(serializeCheckpoint(checkpoint(1)))).toEqual(checkpoint(1));
    const legacy = checkpoint(undefined);
    expect(deserializeCheckpoint(JSON.stringify(legacy))).toEqual(
      JSON.parse(JSON.stringify(legacy)),
    );
  });

  it('refuses to deserialize a version it does not know', () => {
    for (const version of [2, 0, '1', null]) {
      let caught: unknown;
      try {
        deserializeCheckpoint(serializeCheckpoint(checkpoint(version, 'run-next')));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CheckpointVersionError);
      expect(caught).toMatchObject({
        code: 'checkpoint_version_unsupported',
        version,
        runId: 'run-next',
      });
    }
    expect(() => deserializeCheckpoint(serializeCheckpoint(checkpoint(2)))).toThrow(
      /version 2; this build reads version 1/,
    );
  });

  it('refuses to resume a newer checkpoint before calling the model', async () => {
    const { model, spy } = untouchedModel();
    const store = storeWith(checkpoint(2, 'run-r'));
    const failure = resumeFromCheckpoint(store, 'run-r', { model, maxSteps: 3 });
    await expect(failure).rejects.toBeInstanceOf(CheckpointVersionError);
    await expect(failure).rejects.toMatchObject({ runId: 'run-r', version: 2 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a newer checkpoint as an error part on the streaming resume', async () => {
    const { model, spy } = untouchedModel();
    const store = storeWith(checkpoint(2, 'run-s'));
    const result = resumeStreamFromCheckpoint(store, 'run-s', { model, maxSteps: 3 });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    const error = parts.find((part) => part.type === 'error');
    expect(error && 'error' in error && error.error).toBeInstanceOf(CheckpointVersionError);
    await expect(result.usage).rejects.toBeInstanceOf(CheckpointVersionError);
    expect(spy).not.toHaveBeenCalled();
  });

  describe('through the Postgres store pack', () => {
    const db = new PGlite();
    beforeAll(() => db.waitReady, 60_000);
    afterAll(async () => {
      await db.close();
    });
    // The pack's migration is a parameterless batch, which PGlite runs with exec().
    const client: PgClientLike = {
      async query(sql, params) {
        if (params === undefined && sql.includes(';')) {
          const results = await db.exec(sql);
          return { rows: (results.at(-1)?.rows ?? []) as Record<string, unknown>[] };
        }
        return db.query<Record<string, unknown>>(sql, params);
      },
    };

    it('reports the version, not a missing run', async () => {
      await client.query('CREATE SCHEMA durable_version');
      const stores = createPostgresStores({ client, schema: 'durable_version', pgvector: 'off' });
      await stores.sessions.save(checkpoint(2, 'run-pg'));
      const { model, spy } = untouchedModel();
      const failure = resumeFromCheckpoint(stores.sessions, 'run-pg', { model, maxSteps: 3 });
      await expect(failure).rejects.toBeInstanceOf(CheckpointVersionError);
      await expect(failure).rejects.not.toBeInstanceOf(CheckpointNotFoundError);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('reports the version through the SQLite store pack, not a missing run', async () => {
    const stores = createSqliteStores({ path: ':memory:' });
    try {
      await stores.sessions.save(checkpoint(2, 'run-sqlite'));
      await expect(stores.sessions.load('run-sqlite')).rejects.toBeInstanceOf(
        CheckpointVersionError,
      );
      const { model, spy } = untouchedModel();
      const failure = resumeFromCheckpoint(stores.sessions, 'run-sqlite', { model, maxSteps: 3 });
      await expect(failure).rejects.toBeInstanceOf(CheckpointVersionError);
      expect(spy).not.toHaveBeenCalled();
      await stores.sessions.save(checkpoint(1, 'run-ok'));
      expect((await stores.sessions.load('run-ok'))?.runId).toBe('run-ok');
    } finally {
      await stores.close();
    }
  });

  it('reports the version through the Redis store pack, not a missing run', async () => {
    const values = new Map<string, string>();
    const client = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => void values.set(key, value),
      sAdd: async () => 1,
    } as unknown as RedisClientLike;
    const stores = createRedisStores({ client });
    await stores.sessions.save(checkpoint(2, 'run-redis'));
    await expect(stores.sessions.load('run-redis')).rejects.toBeInstanceOf(CheckpointVersionError);
    // A record that is not a checkpoint at all still reads as missing.
    await stores.sessions.save(checkpoint(1, 'run-junk'));
    const [junkKey] = [...values.keys()].filter((key) => key.includes('run-junk'));
    values.set(junkKey!, '{not json');
    expect(await stores.sessions.load('run-junk')).toBeUndefined();
  });
});

// A native run keeps its loop and sub-agent checkpoints inside its envelope.
// One a newer SDK wrote fails the resume BEFORE the run is admitted, exactly as
// a newer envelope does, so the stored run stays resumable by that SDK.
describe('checkpoint version in native runs (2.3)', () => {
  const parameters = { type: 'object' as const, properties: {} };

  function counted(responses: MockResponse[]) {
    const base = createMockModel({ responses });
    const config = readConfig(base)!;
    const fetch = vi.fn(config.fetch!);
    return { model: attachConfig({ ...base }, { ...config, fetch }), fetch };
  }

  /** Edit the stored envelope the way another writer would, revision fence included. */
  async function rewrite(
    store: AgentRunStore,
    runId: string,
    edit: (envelope: AgentRunEnvelope) => void,
  ): Promise<void> {
    const next = structuredClone((await store.load(runId))!);
    edit(next);
    next.revision = (next.revision ?? 0) + 1;
    await store.save(next);
  }

  /** A parent whose `worker` sub-agent suspends on an approval-gated `pay`. */
  function delegation(runId: string) {
    const pay = vi.fn(() => 'paid');
    const child = counted([
      { toolCalls: [{ toolName: 'pay', id: 'pay-child', args: {} }] },
      { text: 'paid' },
    ]);
    const parent = counted([
      { toolCalls: [{ toolName: 'worker', id: 'delegate', args: { prompt: 'pay' } }] },
      { text: 'done' },
    ]);
    const store = createInMemoryAgentRunStore();
    const options = {
      model: parent.model,
      prompt: 'pay',
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'worker',
          model: child.model,
          tools: { pay: { parameters, execute: pay, needsApproval: true } },
        }),
      },
      session: { store, runId, scope: 'tenant' },
      approvalResponses: [{ approvalId: 'pay-child', approved: true }],
    };
    return { pay, child, store, options };
  }

  it('control: a newer envelope fails the resume and leaves the stored run resumable', async () => {
    const { store, options } = delegation('native-root');
    expect((await runAgent(options)).status).toBe('suspended');
    await rewrite(store, 'native-root', (envelope) => {
      (envelope as { version: number }).version = 2;
    });
    expect((await resumeAgent(options)).status).toBe('failed');
    expect((await store.load('native-root'))?.phase).toBe('running');
  });

  it('a newer sub-agent checkpoint fails the resume without ending the stored run', async () => {
    const { pay, child, store, options } = delegation('native-child');
    expect((await runAgent(options)).status).toBe('suspended');
    // A native child is keyed by its call id and root model step (2.3).
    const childKey = Object.keys((await store.load('native-child'))!.checkpoints).find((key) =>
      key.startsWith('native-child::worker#delegate@'),
    )!;
    expect((await store.load('native-child'))?.checkpoints[childKey]).toBeDefined();
    await rewrite(store, 'native-child', (envelope) => {
      (envelope.checkpoints[childKey] as unknown as { version: number }).version = 2;
    });
    const resumed = await resumeAgent(options);
    expect(resumed).toMatchObject({
      status: 'failed',
      error: { code: 'checkpoint_version_unsupported' },
    });
    // 2.3-W1 stored the failure as terminal, so the newer SDK could never resume it.
    const stored = await store.load('native-child');
    expect({ phase: stored?.phase, result: stored?.result?.status }).toEqual({
      phase: 'running',
      result: 'suspended',
    });
    expect(pay).not.toHaveBeenCalled();
    expect(child.fetch).toHaveBeenCalledTimes(1);
  });
});
