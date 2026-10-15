/**
 * native-v3-forget.test.ts (2.4, spec §4.4 "Context paketleri ve forget") —
 * `forget` on a versioned memory session, wired to a V3 run store with
 * `onForget`, end to end through native V3 runs:
 *
 * - a terminal run keeps no copy of the forgotten record's retrieval block:
 *   not in its history, its checkpoints or its stored `result.messages`;
 * - a forget during a running leg reaches the run's terminal record too (the
 *   leg's next requests still carry the block it already holds in memory: a
 *   running leg is not interrupted);
 * - a run that crashed is resumed after the forget: the reopened step is
 *   compiled again (`redacted` in its manifest), the next request carries no
 *   forgotten text and the stored record holds none.
 *
 * On the in-memory, SQLite and Postgres (PGlite and, with
 * DEUZ_TEST_POSTGRES_URL, a live server) V3 run stores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { resumeAgent, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createMemoryContextSource } from '../src/context/sources';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { PgPoolLike } from '../src/node/pg-tx';
import { createPostgresAgentRunStoreV3 } from '../src/node/runs-v3-postgres';
import { createSqliteAgentRunStoreV3 } from '../src/node/runs-v3-sqlite';
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import { recordingStoreV3, scriptedModel, wireText, type ScriptedCall } from './fixtures/native-v3';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const FORGOTTEN = 'The deploy key is under the mat.';
const KEPT = 'Deploy target is eu-west.';
const parameters = { type: 'object', properties: { q: { type: 'string' } } };
const TOOL_THEN_DONE: ScriptedCall[] = [
  { toolCalls: [{ toolName: 'lookup', id: 'l1', args: { q: 'x' } }] },
  { text: 'done' },
];

interface Harness {
  store: AgentRunStoreV3;
  cleanup?(): Promise<void>;
}

/** A memory session whose forgets reach `runs`, holding the forgotten and the kept fact. */
async function memoryFor(runs: AgentRunStoreV3) {
  const session = createMemorySession({
    store: createInMemoryVersionedMemoryStore(),
    scope: { userId: 'u-1' },
    onForget: async (event) => {
      await runs.redactForgotten(event);
    },
  });
  const forgotten = (await session.remember({ text: FORGOTTEN })).records[0]!;
  await session.remember({ text: KEPT });
  return { session, forgottenId: forgotten.id, source: createMemoryContextSource({ session }) };
}

function optionsFor(
  store: AgentRunStoreV3,
  runId: string,
  model: AgentRunOptionsV3['model'],
  source: ReturnType<typeof createMemoryContextSource>,
  lookup: () => unknown = () => 'found',
): AgentRunOptionsV3 {
  return {
    model,
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store, runId, scope: 'tenant' },
    tools: { lookup: { description: 'Look things up.', parameters, execute: lookup } },
    context: { sources: [source] },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
  };
}

const sent = (request: { messages: { content?: unknown }[] }) =>
  request.messages.map((message) => wireText(message)).join('\n');

function forgetContract(name: string, make: () => Promise<Harness>): void {
  const withHarness = (fn: (harness: Harness) => Promise<void>) => async () => {
    const harness = await make();
    try {
      await fn(harness);
    } finally {
      await harness.cleanup?.();
    }
  };

  // Every store, the in-memory one included: the file's first run pays for
  // loading the native V3 path, past vitest's 5 s default on a Linux runner
  // (5.8 s on node 22).
  describe(name, { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
    it(
      "leaves no copy of the forgotten record in a terminal run, its result's messages included",
      withHarness(async ({ store }) => {
        const memory = await memoryFor(store);
        const scripted = scriptedModel(TOOL_THEN_DONE);
        const result = await runAgent(optionsFor(store, 'run-t', scripted.model, memory.source));
        expect(result).toMatchObject({ status: 'completed', output: 'done' });
        // Before the forget the block is stored: in the history and the result.
        const before = (await store.load('run-t'))!;
        expect(before.phase).toBe('terminal');
        expect(sent({ messages: before.result!.messages })).toContain(FORGOTTEN);

        const forgot = await memory.session.forget(memory.forgottenId);
        expect(forgot.redaction).toBe('complete');

        const after = (await store.load('run-t'))!;
        expect(JSON.stringify(after)).not.toContain(FORGOTTEN);
        expect(after.revision).toBe(before.revision);
        expect(after.result?.messages).toHaveLength(before.result!.messages.length);
        // The kept fact was in the same package, so its copy went with it.
        expect(after.context?.steps.some((step) => step.manifest.redacted === true)).toBe(true);
      }),
    );

    it(
      'redacts the terminal record of a leg that was running during the forget',
      withHarness(async ({ store }) => {
        const memory = await memoryFor(store);
        const scripted = scriptedModel(TOOL_THEN_DONE);
        // The forget lands while the run waits on its tool, after step 0's
        // block joined the history.
        const result = await runAgent(
          optionsFor(store, 'run-live', scripted.model, memory.source, async () => {
            await memory.session.forget(memory.forgottenId);
            return 'found';
          }),
        );
        expect(result.status).toBe('completed');
        const stored = (await store.load('run-live'))!;
        expect(stored.phase).toBe('terminal');
        expect(JSON.stringify(stored)).not.toContain(FORGOTTEN);
        expect(stored.result?.messages.length).toBeGreaterThan(2);
      }),
    );

    it(
      'resumes a crashed run after the forget: the step is compiled again and nothing forgotten is sent',
      withHarness(async ({ store }) => {
        const memory = await memoryFor(store);
        const scripted = scriptedModel(TOOL_THEN_DONE);
        const first = recordingStoreV3(store);
        // The process dies once the second model call was sent: step 0's block
        // is in the stored history, step 1's answer never saved.
        const fetch = scripted.fetch.getMockImplementation()!;
        let calls = 0;
        scripted.fetch.mockImplementation(async (input, init) => {
          calls += 1;
          if (calls === 2) first.failFromSave(1);
          return fetch(input, init);
        });
        await runAgent(optionsFor(first, 'run-c', scripted.model, memory.source));
        expect(sent(scripted.requests()[1]!)).toContain(FORGOTTEN);

        expect((await memory.session.forget(memory.forgottenId)).redaction).toBe('complete');
        // At rest, before any resume, the crashed record holds no forgotten text.
        expect(JSON.stringify(await store.load('run-c'))).not.toContain(FORGOTTEN);

        const second = recordingStoreV3(store);
        const resumed = await resumeAgent(
          optionsFor(second, 'run-c', scripted.model, memory.source),
        );
        expect(resumed.status).toBe('completed');
        const last = scripted.requests().at(-1)!;
        expect(sent(last)).not.toContain(FORGOTTEN);
        expect(sent(last)).toContain(KEPT);
        const stored = (await store.load('run-c'))!;
        expect(JSON.stringify(stored)).not.toContain(FORGOTTEN);
        expect(stored.context?.steps.at(-1)!.manifest).toMatchObject({
          refresh: 'redacted',
          redacted: true,
          cachePrefixChanged: true,
        });
      }),
    );
  });
}

forgetContract('in-memory V3 run store', async () => ({
  store: createInMemoryAgentRunStoreV3(),
}));

forgetContract('SQLite V3 run store (:memory:)', async () => {
  const store = createSqliteAgentRunStoreV3({ path: ':memory:' });
  return { store, cleanup: () => store.close() };
});

describe('Postgres V3 run store (PGlite pool)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const db = new PGlite();
  beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });
  const pool = pglitePool(db);
  let schemas = 0;
  forgetContract('native runs', async () => {
    const schema = `e2_forget_${++schemas}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    const store = createPostgresAgentRunStoreV3({ pool, schema });
    return { store, cleanup: () => store.close() };
  });
});

const liveUrl = postgresUrl();

describe.skipIf(!liveUrl)('Postgres V3 run store (live server)', () => {
  let pool: pg.Pool;
  const prefix = `deuz_e2_forget_${Date.now().toString(36)}`;
  const schemas: string[] = [];
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: liveUrl, max: 4 });
  }, SLOW_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  }, SLOW_HOOK_TIMEOUT_MS);
  forgetContract('native runs', async () => {
    const schema = `${prefix}_${schemas.length + 1}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${schema}`);
    const store = createPostgresAgentRunStoreV3({ pool: pool as unknown as PgPoolLike, schema });
    return { store, cleanup: () => store.close() };
  });
});
