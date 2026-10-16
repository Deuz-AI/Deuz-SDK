/**
 * createVersionedMemoryTools (2.4, spec §2.1): the model's memory tools are
 * bound to the session's scope. The model can read and propose within that
 * scope only: every write is inferred, cites the tool call, and can never
 * change a record's scope, origin or source kinds, nor touch an asserted
 * record. Operation ids derive from the model step and tool call id, so a
 * replayed call never applies twice. There is no forget tool.
 */
import { describe, expect, it } from 'vitest';
import { InvalidRequestError } from '../src/errors';
import { sha256Digest } from '../src/internal/digest';
import {
  createInMemoryVersionedMemoryStore,
  createMemorySession,
  createVersionedMemoryTools,
} from '../src/memory/versioned';
import type { MemorySession, VersionedMemoryStore } from '../src/memory/versioned';
import type { AgentToolContext, AgentToolSet } from '../src/types/agent-run';
import type { MemoryScope } from '../src/memory';
import { seed } from './fixtures/versioned-memory-session';

const USER: MemoryScope = { userId: 'u1', chatId: 'c1' };

function context(toolCallId: string, modelStep = 1): AgentToolContext {
  return { toolCallId, modelStep, messages: [] } as unknown as AgentToolContext;
}

async function call(tools: AgentToolSet, name: string, args: unknown, ctx: AgentToolContext) {
  return tools[name]!.execute!(args, ctx);
}

function setup(): { store: VersionedMemoryStore; session: MemorySession; tools: AgentToolSet } {
  const store = createInMemoryVersionedMemoryStore();
  const session = createMemorySession({ store, scope: USER });
  return { store, session, tools: createVersionedMemoryTools(session) };
}

describe('createVersionedMemoryTools', () => {
  it('offers remember, recall, revise and retract, never forget', () => {
    const { session, tools } = setup();
    expect(Object.keys(tools).sort()).toEqual([
      'memory_recall',
      'memory_remember',
      'memory_retract',
      'memory_revise',
    ]);
    for (const name of ['memory_remember', 'memory_revise', 'memory_retract'])
      expect(tools[name]!.replay).toBe('idempotent');
    expect(tools.memory_recall!.replay).toBeUndefined();
    const narrowed = createVersionedMemoryTools(session, { include: ['recall'], prefix: 'notes' });
    expect(Object.keys(narrowed)).toEqual(['notes_recall']);
    expect(() => createVersionedMemoryTools(session, { include: ['forget' as never] })).toThrow(
      InvalidRequestError,
    );
    expect(() => createVersionedMemoryTools({ scope: USER } as MemorySession)).toThrow(
      InvalidRequestError,
    );
  });

  it('remember writes an inferred record in the session scope that cites the tool call', async () => {
    const { store, tools } = setup();
    const result = (await call(
      tools,
      'memory_remember',
      {
        text: 'prefers window seats',
        kind: 'semantic',
        importance: 0.6,
        origin: 'asserted',
        scope: { userId: 'someone-else' },
        sources: [{ kind: 'host', digest: 'sha256:00' }],
      },
      context('call-1', 3),
    )) as { written: { id: string; revision: number }[]; replayed: boolean };
    expect(result.replayed).toBe(false);
    const record = await store.get(USER, result.written[0]!.id);
    expect(record).toMatchObject({
      text: 'prefers window seats',
      origin: 'inferred',
      scope: USER,
      importance: 0.6,
      sources: [
        {
          kind: 'assistant',
          chatId: 'c1',
          toolCallId: 'call-1',
          toolName: 'memory_remember',
          digest: await sha256Digest('prefers window seats'),
        },
      ],
    });
    const receipt = await store.receipt(record!.operationId);
    expect(receipt).toMatchObject({ actor: 'model' });
    expect(record!.operationId).toContain('call-1');
    expect(await store.scopeRevision({ userId: 'someone-else' })).toBe(0);
  });

  it('a replayed call with the same step and tool call id applies once', async () => {
    const { store, tools } = setup();
    const first = (await call(
      tools,
      'memory_remember',
      { text: 'likes tea' },
      context('call-7', 2),
    )) as { written: { id: string }[] };
    const again = (await call(
      tools,
      'memory_remember',
      { text: 'likes tea' },
      context('call-7', 2),
    )) as { written: { id: string }[]; replayed: boolean };
    expect(again.replayed).toBe(true);
    expect(again.written).toEqual(first.written);
    expect(await store.scopeRevision(USER)).toBe(1);
    // Another step with a recycled tool call id is another operation.
    await call(tools, 'memory_remember', { text: 'likes coffee' }, context('call-7', 5));
    expect(await store.scopeRevision(USER)).toBe(2);
  });

  it('recall returns the scope only, labelled with origin and source kinds as data', async () => {
    const { store, tools } = setup();
    await seed(store, USER, { id: 'host-1', text: 'is vegetarian', origin: 'asserted' });
    await seed(store, { userId: 'u2' }, { id: 'other-1', text: 'is vegetarian too' });
    const hits = (await call(
      tools,
      'memory_recall',
      { query: 'vegetarian', topK: 50 },
      context('call-2'),
    )) as unknown[];
    expect(hits).toEqual([
      {
        id: 'host-1',
        revision: 1,
        text: 'is vegetarian',
        kind: 'semantic',
        origin: 'asserted',
        sourceKinds: ['host'],
        status: 'active',
      },
    ]);
  });

  it('revise changes an inferred record and adds the tool call as a source', async () => {
    const { store, tools } = setup();
    await seed(store, USER, { id: 'm-1', text: 'likes tea', origin: 'inferred' });
    const result = await call(
      tools,
      'memory_revise',
      { id: 'm-1', expectedRevision: 1, text: 'likes green tea', origin: 'asserted' },
      context('call-3'),
    );
    expect(result).toEqual({ id: 'm-1', revision: 2, replayed: false });
    const record = await store.get(USER, 'm-1');
    expect(record).toMatchObject({ revision: 2, text: 'likes green tea', origin: 'inferred' });
    expect(record!.sources.map((source) => source.kind)).toEqual(['host', 'assistant']);
    expect(record!.sources[1]).toMatchObject({ toolCallId: 'call-3', toolName: 'memory_revise' });
  });

  it('refuses to revise or retract an asserted record', async () => {
    const { store, tools } = setup();
    await seed(store, USER, { id: 'host-1', text: 'lives in Paris', origin: 'asserted' });
    expect(
      await call(
        tools,
        'memory_revise',
        { id: 'host-1', expectedRevision: 1, text: 'lives in Rome' },
        context('call-4'),
      ),
    ).toMatchObject({ error: 'asserted_record' });
    expect(
      await call(tools, 'memory_retract', { id: 'host-1', expectedRevision: 1 }, context('call-5')),
    ).toMatchObject({ error: 'asserted_record' });
    expect(await store.get(USER, 'host-1')).toMatchObject({ revision: 1, text: 'lives in Paris' });
  });

  it('answers a stale revision and a missing record as data the model can act on', async () => {
    const { store, tools } = setup();
    await seed(store, USER, { id: 'm-1', text: 'likes tea', origin: 'inferred' });
    await call(tools, 'memory_retract', { id: 'm-1', expectedRevision: 1 }, context('call-6'));
    expect(await store.get(USER, 'm-1')).toBeUndefined();
    expect(
      await call(
        tools,
        'memory_revise',
        { id: 'm-1', expectedRevision: 1, text: 'x' },
        context('call-8'),
      ),
    ).toEqual({
      error: 'revision_conflict',
      message: expect.any(String),
      id: 'm-1',
      actualRevision: 2,
    });
    expect(
      await call(tools, 'memory_retract', { id: 'nope', expectedRevision: 1 }, context('call-9')),
    ).toMatchObject({ error: 'not_found', id: 'nope' });
    // A record of another scope is not found either.
    await seed(store, { userId: 'u2' }, { id: 'theirs', text: 'secret', origin: 'inferred' });
    expect(
      await call(tools, 'memory_retract', { id: 'theirs', expectedRevision: 1 }, context('c-10')),
    ).toMatchObject({ error: 'not_found' });
  });

  it('rejects malformed arguments', async () => {
    const { tools } = setup();
    await expect(call(tools, 'memory_remember', { text: '' }, context('c-1'))).rejects.toThrow();
    await expect(
      call(tools, 'memory_revise', { id: 'x', expectedRevision: 0, text: 'y' }, context('c-2')),
    ).rejects.toThrow();
    await expect(call(tools, 'memory_recall', {}, context('c-3'))).rejects.toThrow();
  });
});
