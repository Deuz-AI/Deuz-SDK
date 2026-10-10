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
import type { PgClientLike } from '../src/node/store-postgres';
import type { StreamPart } from '../src/types/stream';
import type { AgentCheckpoint, SessionStore } from '../src/types/session';
import { createAnthropic } from '../src/anthropic';

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
});
