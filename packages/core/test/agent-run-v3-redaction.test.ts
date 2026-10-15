/**
 * agent-run-v3-redaction.test.ts (2.4, spec §4.4 "Context paketleri ve
 * forget") — a forget reaches every stored copy of a redacted retrieval block
 * in a V3 run store, not only the package blob: the run's history, every
 * checkpoint and the stored result's messages (a terminal run's
 * `result.messages` included). Each copy becomes a content-free stand-in that
 * keeps the block's marker, so a resumed run still drops it and compiles the
 * step again (the one documented exception), while the run's revision and
 * last-save time stay. A run saved after the forget is stored redacted too.
 *
 * On the in-memory, SQLite and Postgres (PGlite and, with
 * DEUZ_TEST_POSTGRES_URL, a live server) stores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import {
  contextPackageBlob,
  redactedRetrievalBlock,
  retrievalBlockMarker,
  type ContextPackageBlob,
} from '../src/agent-run-v3-context';
import {
  isContextMessage,
  messageText,
  placedBlocks,
  renderRecord,
  retrievalOpening,
  RETRIEVAL_CLOSING,
} from '../src/context/render';
import type { PgPoolLike } from '../src/node/pg-tx';
import { createPostgresAgentRunStoreV3 } from '../src/node/runs-v3-postgres';
import { createSqliteAgentRunStoreV3 } from '../src/node/runs-v3-sqlite';
import type { AgentResult } from '../src/types/agent-run';
import type { AgentRunEnvelopeV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import type { Message } from '../src/types/message';
import type { AgentCheckpoint } from '../src/types/session';
import { stepFor } from './fixtures/agent-run-store-v3-conformance';
import { contextPackage, envelopeV3 } from './fixtures/agent-run-v3';
import { manualClock } from './fixtures/manual-clock';
import { pglitePool } from './fixtures/pg-pool';
import { postgresUrl } from './fixtures/services';
import { SLOW_HOOK_TIMEOUT_MS, SLOW_TEST_TIMEOUT_MS } from './fixtures/timeouts';

const FORGOTTEN = 'The deploy key is under the mat.';
const KEPT = 'Deploy target is eu-west.';

/** A retrieval block as the compiler appends it to the history. */
function block(pass: number, step: number, recordId: string, revision: number, text: string) {
  return {
    role: 'user' as const,
    content: `${retrievalOpening(pass, step)}${renderRecord({ source: 'memory', kind: 'memory', recordId, revision }, text)}${RETRIEVAL_CLOSING}`,
  };
}

const prompt: Message = { role: 'user', content: 'Deploy the service' };
const block0 = block(1, 0, 'mem-a', 2, FORGOTTEN);
const block1 = block(1, 1, 'mem-b', 1, KEPT);
const call: Message = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: {} }],
};
const answer: Message = { role: 'assistant', content: 'done' };

function checkpoint(runId: string, index: number, messages: Message[]): AgentCheckpoint {
  return {
    version: 1,
    runId,
    stepId: `${runId}#${index}`,
    stepIndex: index,
    status: 'running',
    messages,
    usage: envelopeV3(runId, 1).usage,
  } as AgentCheckpoint;
}

/**
 * A run that compiled two packages: step 0's `held` places mem-a@2 (the
 * forgotten text), step 1's `kept` places mem-a@5 and mem-b. Both blocks are
 * in the history, the checkpoints and, once terminal, the result.
 */
function runWith(
  runId: string,
  revision: number,
  held: ContextPackageBlob,
  kept: ContextPackageBlob,
  phase: AgentRunEnvelopeV3['phase'] = 'terminal',
): AgentRunEnvelopeV3 {
  const messages = [prompt, block0, call, block1, answer];
  const result: AgentResult<unknown> | undefined =
    phase === 'terminal'
      ? {
          runId,
          status: 'completed',
          output: 'done',
          text: 'done',
          messages,
          usage: envelopeV3(runId, 1).usage,
          modelSteps: 2,
        }
      : undefined;
  return envelopeV3(runId, revision, {
    phase,
    messages,
    modelSteps: 2,
    checkpoints: {
      [`${runId}#1`]: checkpoint(runId, 1, [prompt, block0, call]),
      [`${runId}#2`]: checkpoint(runId, 2, messages),
    },
    context: { steps: [stepFor(0, held), stepFor(1, kept)] },
    ...(result ? { result } : {}),
  });
}

const FORGET = { scope: { userId: 'u' }, recordId: 'mem-a', revisions: [1, 2], operationId: 'f1' };

const texts = (messages: readonly Message[] | undefined) =>
  (messages ?? []).map((message) =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  );

/** Every stored message list of a run: history, checkpoints, result. */
function everyCopy(envelope: AgentRunEnvelopeV3): string[][] {
  return [
    texts(envelope.messages),
    ...Object.values(envelope.checkpoints).map((entry) => texts(entry.messages)),
    ...(envelope.result ? [texts(envelope.result.messages)] : []),
  ];
}

describe('the stand-in of a redacted retrieval block', () => {
  it('reads as the block the renderer wrote: same marker and closing, no record', () => {
    const marker = retrievalBlockMarker(3, 7);
    expect(retrievalOpening(3, 7).startsWith(`${marker}\n`)).toBe(true);
    const standIn = { role: 'user' as const, content: redactedRetrievalBlock(marker) };
    expect(standIn.content.endsWith(RETRIEVAL_CLOSING)).toBe(true);
    expect(standIn.content).not.toContain('<record');
    // The compiler still sees which block it was (a resume drops it first).
    expect(isContextMessage(standIn)).toBe(true);
    expect([...placedBlocks([standIn])]).toEqual(['3:7']);
    expect(messageText(standIn)).toBe(standIn.content);
  });
});

interface Harness {
  store: AgentRunStoreV3;
  cleanup?(): Promise<void>;
}

function redactionContract(name: string, make: () => Promise<Harness>, slow = false): void {
  const options = slow ? { timeout: SLOW_TEST_TIMEOUT_MS } : {};
  const withHarness = (fn: (harness: Harness) => Promise<void>) => async () => {
    const harness = await make();
    try {
      await fn(harness);
    } finally {
      await harness.cleanup?.();
    }
  };

  describe(name, options, () => {
    it(
      'replaces every stored copy of a redacted retrieval block, in place',
      withHarness(async ({ store }) => {
        const held = await contextPackageBlob(contextPackage(0, 'held', 2));
        const kept = await contextPackageBlob(contextPackage(1, 'kept', 5));
        await store.putBlob(held);
        await store.putBlob(kept);
        await store.save(runWith('run', 1, held, kept));
        const [before] = (await store.list()).runs;

        expect(await store.redactForgotten(FORGET)).toBe(1);

        const loaded = (await store.load('run'))!;
        const copies = everyCopy(loaded);
        expect(copies).toHaveLength(4);
        for (const copy of copies) {
          expect(copy.join('\n')).not.toContain(FORGOTTEN);
          // The kept block is untouched, the prompt and the turns too.
          expect(copy).toContain(prompt.content);
          // The stand-in keeps the block's marker, and only that.
          const standIn = copy.find((text) => text.startsWith('<deuz_context pass="1" step="0">'));
          expect(standIn).toBeDefined();
          expect(standIn).not.toContain('<record');
        }
        expect(texts(loaded.messages)).toContain(block1.content);
        expect(texts(loaded.result!.messages)).toContain(block1.content);
        // The same messages, roles and order: only the block's content changed.
        expect(loaded.messages.map((message) => message.role)).toEqual([
          'user',
          'user',
          'assistant',
          'user',
          'assistant',
        ]);
        expect(loaded.revision).toBe(1);
        expect(loaded.context?.steps.map((step) => step.manifest.redacted ?? false)).toEqual([
          true,
          false,
        ]);
        // A maintenance rewrite is not a save: the run keeps its place for retention.
        expect((await store.list()).runs[0]).toEqual(before);
        // The executor's next save still fits the stored revision.
        await store.save({ ...loaded, revision: 2 });
        expect(JSON.stringify(await store.load('run'))).not.toContain(FORGOTTEN);
      }),
    );

    it(
      'redacts a running run at rest as well, keeping the marker a resume drops',
      withHarness(async ({ store }) => {
        const held = await contextPackageBlob(contextPackage(0, 'held', 2));
        const kept = await contextPackageBlob(contextPackage(1, 'kept', 5));
        await store.putBlob(held);
        await store.putBlob(kept);
        await store.save(runWith('crashed', 1, held, kept, 'running'));
        await store.redactForgotten(FORGET);
        const loaded = (await store.load('crashed'))!;
        expect(loaded.phase).toBe('running');
        expect(loaded.revision).toBe(1);
        expect(JSON.stringify(loaded)).not.toContain(FORGOTTEN);
        expect(texts(loaded.messages)[1]).toMatch(/^<deuz_context pass="1" step="0">/);
      }),
    );

    it(
      'stores a run saved after the forget redacted, also when a live leg still held the block',
      withHarness(async ({ store }) => {
        const held = await contextPackageBlob(contextPackage(0, 'held', 2));
        const kept = await contextPackageBlob(contextPackage(1, 'kept', 5));
        await store.putBlob(held);
        await store.putBlob(kept);
        await store.save(runWith('live', 1, held, kept, 'running'));
        await store.redactForgotten(FORGET);
        // The executor of a leg that was running during the forget still has
        // the block in memory; its terminal save must not bring it back.
        await store.save(runWith('live', 2, held, kept));
        const loaded = (await store.load('live'))!;
        expect(loaded.phase).toBe('terminal');
        for (const copy of everyCopy(loaded)) expect(copy.join('\n')).not.toContain(FORGOTTEN);
        expect(texts(loaded.result!.messages)).toContain(block1.content);

        // A package put after its forget is redacted at once; a run pointing
        // to it is stored redacted on its first save.
        const late = await contextPackageBlob(contextPackage(0, 'late', 2));
        await store.putBlob(late);
        await store.save(runWith('late', 1, late, kept));
        expect(JSON.stringify(await store.load('late'))).not.toContain(FORGOTTEN);
      }),
    );

    it(
      'leaves runs without a redacted package byte for byte, and a repeated forget changes nothing',
      withHarness(async ({ store }) => {
        const held = await contextPackageBlob(contextPackage(0, 'held', 2));
        const kept = await contextPackageBlob(contextPackage(1, 'kept', 5));
        await store.putBlob(held);
        await store.putBlob(kept);
        const other = runWith('other', 1, kept, kept);
        await store.save(other);
        await store.save(runWith('run', 1, held, kept));
        await store.redactForgotten(FORGET);
        expect(await store.load('other')).toEqual(other);

        const once = await store.load('run');
        // A retried forget (the session reruns its listeners) finds nothing new.
        expect(await store.redactForgotten(FORGET)).toBe(0);
        expect(await store.load('run')).toEqual(once);
      }),
    );

    it(
      'keeps a block whose step placed nothing in the history (no append block)',
      withHarness(async ({ store }) => {
        const held = await contextPackageBlob(contextPackage(0, 'held', 2));
        await store.putBlob(held);
        const step = stepFor(0, held);
        step.manifest = { ...step.manifest, placement: { append: false, tail: true } };
        const envelope = envelopeV3('tail', 1, {
          messages: [prompt, block0],
          context: { steps: [step] },
        });
        await store.save(envelope);
        await store.redactForgotten(FORGET);
        // Only blocks the step appended are its copies; this message is not one.
        expect(texts((await store.load('tail'))!.messages)).toContain(block0.content);
      }),
    );
  });
}

redactionContract('in-memory V3 run store', async () => {
  const { clock } = manualClock();
  return { store: createInMemoryAgentRunStoreV3({ deps: { clock } }) };
});

redactionContract(
  'SQLite V3 run store (:memory:)',
  async () => {
    const { clock } = manualClock();
    const store = createSqliteAgentRunStoreV3({ path: ':memory:', clock });
    return { store, cleanup: () => store.close() };
  },
  true,
);

describe('Postgres V3 run store (PGlite pool)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const db = new PGlite();
  beforeAll(() => db.waitReady, SLOW_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await db.close();
  });
  const pool = pglitePool(db);
  let schemas = 0;
  redactionContract(
    'contract',
    async () => {
      const schema = `e2_redact_${++schemas}`;
      await pool.query(`CREATE SCHEMA ${schema}`);
      const store = createPostgresAgentRunStoreV3({ pool, schema });
      return { store, cleanup: () => store.close() };
    },
    true,
  );
});

const liveUrl = postgresUrl();

describe.skipIf(!liveUrl)('Postgres V3 run store (live server)', () => {
  let pool: pg.Pool;
  const prefix = `deuz_e2_redact_${Date.now().toString(36)}`;
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
  redactionContract(
    'contract',
    async () => {
      const schema = `${prefix}_${schemas.length + 1}`;
      schemas.push(schema);
      await pool.query(`CREATE SCHEMA ${schema}`);
      const store = createPostgresAgentRunStoreV3({ pool: pool as unknown as PgPoolLike, schema });
      return { store, cleanup: () => store.close() };
    },
    true,
  );

  it(
    'never stores a forgotten block when a save races the forget',
    { timeout: SLOW_TEST_TIMEOUT_MS },
    async () => {
      const schema = `${prefix}_${schemas.length + 1}`;
      schemas.push(schema);
      await pool.query(`CREATE SCHEMA ${schema}`);
      const writer = createPostgresAgentRunStoreV3({ pool: pool as unknown as PgPoolLike, schema });
      const forgetter = createPostgresAgentRunStoreV3({
        pool: pool as unknown as PgPoolLike,
        schema,
      });
      await writer.migrate();
      try {
        for (let round = 0; round < 8; round++) {
          const revision = 100 + round;
          const secret = `Secret number ${round} is ${revision}.`;
          const held = await contextPackageBlob(contextPackage(0, `race-${round}`, revision));
          await writer.putBlob(held);
          const envelope = envelopeV3(`race-${round}`, 1, {
            phase: 'terminal',
            messages: [prompt, block(1, 0, 'mem-a', revision, secret), answer],
            context: { steps: [stepFor(0, held)] },
          });
          await Promise.all([
            writer.save(envelope),
            forgetter.redactForgotten({
              scope: {},
              recordId: 'mem-a',
              revisions: [revision],
              operationId: `f-${round}`,
            }),
          ]);
          expect(JSON.stringify(await writer.load(`race-${round}`))).not.toContain(secret);
        }
      } finally {
        await writer.close();
        await forgetter.close();
      }
    },
  );
});
