/**
 * native-v3-rag-accounting.test.ts (2.4, spec §3.1 "muhasebe") — a RAG
 * context source's query embedding inside a V3 run is charged to the run's
 * ledger. The compiler hands each source query the run's execution context
 * (`request.accounting`, a request id of its own per query), the RAG source
 * passes it to the host's `retrieve` (which spreads it into `retrieve` /
 * `hybridRetrieve`), and the embedding is reserved on the run ledger before
 * the call: an accounted embedder settles its usage there, one without usage
 * stays held as unaccounted with one `unaccounted-usage` warning per run.
 */
import { describe, expect, it } from 'vitest';
import { runAgent, streamAgent } from '../src/agent-run';
import { createContextCompiler } from '../src/context/compiler';
import { createRagContextSource } from '../src/context/sources';
import { defineAccountedEmbedder } from '../src/internal/accounting';
import { createMemoryVectorStore, indexChunks, retrieve, type Embedder } from '../src/rag';
import type { AgentRunOptionsV3 } from '../src/types/agent-run-v3';
import type { CallWarning } from '../src/types/methods';
import type { Usage } from '../src/types/usage';
import { recordingStoreV3, scriptedModel, wireText, type ScriptedCall } from './fixtures/native-v3';

const usage: Usage = {
  inputTokens: 7,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 7,
};

const plain: Embedder = { dims: 2, embed: async (texts) => texts.map(() => [1, 0]) };
const accounted = defineAccountedEmbedder({
  dims: 2,
  embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), usage, modelId: 'embed-small' }),
});

async function corpus() {
  const store = createMemoryVectorStore();
  await indexChunks([{ text: 'The deploy target is eu-west.', index: 0 }], {
    embedder: plain,
    store,
  });
  return store;
}

const parameters = { type: 'object', properties: { q: { type: 'string' } } };

function v3Options(extra: Partial<AgentRunOptionsV3>, script: ScriptedCall[] = [{ text: 'done' }]) {
  const { model } = scriptedModel(script);
  const store = recordingStoreV3();
  const options: AgentRunOptionsV3 = {
    model,
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store, runId: 'run-rag', scope: 'tenant' },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    ...extra,
  };
  return { options, store };
}

describe('RAG context source accounting in a V3 run', () => {
  it("charges an accounted embedder's query embedding to the run ledger", async () => {
    const vectors = await corpus();
    const rag = createRagContextSource({
      retrieve: (query, topK, _signal, charge) =>
        retrieve(query, { embedder: accounted, store: vectors }, { topK, ...charge }),
    });
    const { options, store } = v3Options({ context: { sources: [rag] } });
    const result = await runAgent(options);
    expect(result.status).toBe('completed');
    expect(result.messages.some((m) => wireText(m).includes('eu-west'))).toBe(true);

    const saved = (await store.load('run-rag'))!;
    const embeddings = saved.execution!.ledger.reservations.filter(
      (entry) => entry.kind === 'embedding',
    );
    expect(embeddings).toHaveLength(1);
    // Settled with the reported usage (unpriced: tokens are accounted, USD is not).
    expect(embeddings[0]).toMatchObject({ modelId: 'rag-embedder', usage, actual: { tokens: 7 } });
    expect(embeddings[0]!.unaccounted).toBeUndefined();
    // The request id is the run's own scope, one per query.
    expect(embeddings[0]!.requestId.startsWith('run-rag/context/rag/')).toBe(true);
    expect(result.accounting?.spent.tokens).toBeGreaterThanOrEqual(7);
  });

  it("holds an embedder without usage as unaccounted, with a warning on the run's stream", async () => {
    const vectors = await corpus();
    const rag = createRagContextSource({
      retrieve: (query, topK, _signal, charge) =>
        retrieve(query, { embedder: plain, store: vectors }, { topK, ...charge }),
    });
    const { options, store } = v3Options({ context: { sources: [rag] } });
    const stream = streamAgent(options);
    const warnings: CallWarning[] = [];
    for await (const event of stream.events)
      if (event.type === 'part' && event.part.type === 'warning') warnings.push(event.part.warning);
    expect((await stream.result).status).toBe('completed');

    const saved = (await store.load('run-rag'))!;
    const embeddings = saved.execution!.ledger.reservations.filter(
      (entry) => entry.kind === 'embedding',
    );
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toMatchObject({ state: 'unknown', unaccounted: true });
    const unaccounted = warnings.filter((warning) => warning.type === 'unaccounted-usage');
    expect(unaccounted).toHaveLength(1);
    expect(unaccounted[0]!.message).toContain('RAG embedder');
  });

  it('charges every pass under its own request id and warns once per run', async () => {
    const vectors = await corpus();
    const rag = createRagContextSource({
      retrieve: (query, topK, _signal, charge) =>
        retrieve(query, { embedder: plain, store: vectors }, { topK, ...charge }),
    });
    const warnings: CallWarning[] = [];
    const compiler = createContextCompiler({
      sources: [rag],
      onWarning: (warning) => warnings.push(warning),
    });
    const { options, store } = v3Options(
      {
        context: compiler,
        tools: {
          lookup: {
            description: 'Look things up.',
            parameters,
            // A host refresh: the next step retrieves again.
            execute: () => {
              compiler.requestRefresh();
              return 'found';
            },
          },
        },
      },
      [{ toolCalls: [{ toolName: 'lookup', id: 'l1', args: { q: 'x' } }] }, { text: 'done' }],
    );
    expect((await runAgent(options)).status).toBe('completed');

    const saved = (await store.load('run-rag'))!;
    expect(saved.context?.compiler?.passes).toBe(2);
    const embeddings = saved.execution!.ledger.reservations.filter(
      (entry) => entry.kind === 'embedding',
    );
    // Two passes, two queries, two holds: never free.
    expect(embeddings).toHaveLength(2);
    expect(new Set(embeddings.map((entry) => entry.requestId)).size).toBe(2);
    for (const entry of embeddings)
      expect(entry).toMatchObject({ state: 'unknown', unaccounted: true });
    expect(warnings.filter((warning) => warning.type === 'unaccounted-usage')).toHaveLength(1);
  });

  it('hands the host retrieve no accounting outside a run, as before', async () => {
    const seen: unknown[][] = [];
    const rag = createRagContextSource({
      retrieve: async (...args) => {
        seen.push(args);
        return [];
      },
    });
    await rag.query({ text: 'deploy', limit: 3, budgetTokens: 100 });
    expect(seen).toEqual([['deploy', 3, undefined]]);
  });
});
