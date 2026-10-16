/**
 * Ledger accounting of the memory session's own calls (2.4, the accounted-call
 * contract): with an execution context, each memory LLM and embedding call is
 * reserved before it runs and settled after. An accounted callback settles the
 * usage it reports; an unmarked one is charged as unaccounted at its estimate
 * (never as free) with one `unaccounted-usage` warning; a policy refuses the
 * call before the callback runs.
 */
import { describe, expect, it } from 'vitest';
import { createExecutionContext } from '../src/execution-policy';
import { defineAccountedMemoryLLM } from '../src/internal/accounting';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { AccountedMemoryEmbedder } from '../src/memory/versioned';
import type { MemoryScope } from '../src/memory';
import type { Usage } from '../src/types/usage';
import { keywordEmbedder, scriptedLLM, seed } from './fixtures/versioned-memory-session';

const USER: MemoryScope = { userId: 'u1' };

function usage(inputTokens: number, outputTokens: number): Usage {
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function logger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    },
  };
}

describe('memory session accounting', () => {
  it('settles the usage an accounted LLM and embedder report', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000_000 } });
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const llm = defineAccountedMemoryLLM(async () => ({
      text: JSON.stringify({ memory: [{ id: '0', event: 'UPDATE', text: 'likes green tea' }] }),
      usage: usage(120, 30),
      modelId: 'small-llm',
    }));
    const base = keywordEmbedder();
    const embedder: AccountedMemoryEmbedder = {
      accounted: true,
      async embed(texts, action) {
        const out = await base.embed(texts, action);
        return { ...out, usage: usage(7, 0), modelId: out.model };
      },
    };
    const log = logger();
    const session = createMemorySession({
      store,
      scope: USER,
      llm,
      embedder,
      execution,
      llmModelId: 'small-llm',
      deps: {
        logger: log.logger,
        priceProvider: { priceUsage: (_model, used) => used.totalTokens / 1_000_000 },
      },
    });
    await session.remember({ text: 'loves green tea' });
    const reservations = execution.ledger.snapshot().reservations;
    expect(reservations.map((item) => [item.kind, item.modelId, item.state])).toEqual([
      ['memory-llm', 'small-llm', 'settled'],
      ['memory-embedding', 'memory-embedder', 'settled'],
    ]);
    expect(reservations[0]!.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(reservations.every((item) => item.requestId.startsWith(execution.scopeId))).toBe(true);
    expect(log.warnings).toEqual([]);
    expect(execution.ledger.totals().spent).toEqual({ tokens: 157, usd: 157 / 1_000_000 });
  });

  it('charges an unmarked callback as unaccounted at its estimate, with one warning', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000_000 } });
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const script = scriptedLLM({
      reconcile: () => ({ memory: [{ id: '0', event: 'UPDATE', text: 'likes green tea' }] }),
    });
    const log = logger();
    const session = createMemorySession({
      store,
      scope: USER,
      llm: script.llm,
      embedder: keywordEmbedder(),
      execution,
      deps: { logger: log.logger },
    });
    await session.remember({ text: 'loves green tea' });
    await session.remember({ text: 'loves tea a lot' });
    const reservations = execution.ledger.snapshot().reservations;
    expect(reservations.length).toBeGreaterThanOrEqual(3);
    for (const reservation of reservations) {
      expect(reservation.state).toBe('unknown');
      expect(reservation.reservation.tokens).toBeGreaterThan(0);
    }
    expect(execution.ledger.totals().unknownTokens).toBeGreaterThan(0);
    expect(log.warnings.filter((message) => /usage/i.test(message))).toHaveLength(1);
  });

  it('refuses a call the policy forbids before the callback runs', async () => {
    const execution = createExecutionContext({ policy: { allowedModels: ['other-model'] } });
    const store = createInMemoryVersionedMemoryStore();
    const base = keywordEmbedder();
    const session = createMemorySession({
      store,
      scope: USER,
      embedder: base,
      execution,
      embedderModelId: 'kw-1',
    });
    await expect(session.remember({ text: 'likes tea' })).rejects.toMatchObject({
      code: 'model_not_allowed',
    });
    expect(base.calls).toEqual([]);
    expect(await store.scopeRevision(USER)).toBe(0);
  });

  it('charges re-embedding to the ledger under the new model', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000_000 } });
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const session = createMemorySession({ store, scope: USER, execution });
    await session.reembed({ embedder: keywordEmbedder(['tea'], 'kw-9'), modelId: 'kw-9', dims: 2 });
    const reservations = execution.ledger.snapshot().reservations;
    expect(reservations.map((item) => [item.kind, item.modelId])).toEqual([
      ['memory-embedding', 'kw-9'],
    ]);
  });

  it('marks a failed call unknown: it may have been billed', async () => {
    const execution = createExecutionContext({ budget: { tokens: 1_000_000 } });
    const store = createInMemoryVersionedMemoryStore();
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const session = createMemorySession({
      store,
      scope: USER,
      llm: async () => {
        throw new Error('provider down');
      },
      execution,
    });
    await expect(session.remember({ text: 'loves tea' })).rejects.toThrow('provider down');
    expect(execution.ledger.snapshot().reservations.map((item) => item.state)).toEqual(['unknown']);
  });

  it('runs bare without an execution context', async () => {
    const store = createInMemoryVersionedMemoryStore();
    const llm = defineAccountedMemoryLLM(async () => ({
      text: '{"memory":[]}',
      usage: usage(1, 1),
      modelId: 'm',
    }));
    await seed(store, USER, { id: 'r1', text: 'likes tea' });
    const session = createMemorySession({ store, scope: USER, llm });
    const result = await session.remember({ text: 'likes tea' });
    expect(result.records).toEqual([]);
  });
});
