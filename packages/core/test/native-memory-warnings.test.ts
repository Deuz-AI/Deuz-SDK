/**
 * native-memory-warnings.test.ts (2.4, spec §2.2, §3.1) — a native run's
 * built-in memory reports its 2.4 warnings on the run (an
 * `embedding-mismatch` from the recall, `unaccounted-usage` from a memory
 * LLM that reports no usage) and charges the memory LLM and embedder to the
 * run's execution context; the legacy loops' recall reports to `warnings`.
 */
import { describe, expect, it, vi } from 'vitest';
import { streamAgent } from '../src/agent-run';
import { streamChat } from '../src/index';
import { createInMemoryMemoryStore, type MemoryRecord, type MemorySeams } from '../src/memory';
import type { CallWarning } from '../src/types/methods';
import { scriptedModel } from './fixtures/native-v3';
import { createInMemoryAgentRunStore } from '../src/agent-run';

const scope = { userId: 'u1' };

function record(id: string, text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    text,
    hash: `h-${id}`,
    kind: 'semantic',
    scope,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

async function seams(): Promise<MemorySeams> {
  const store = createInMemoryMemoryStore();
  await store.upsert([
    record('fresh', 'embedded by the current model', {
      embedding: [1, 0, 0],
      embeddingModelId: 'model-new',
    }),
    record('old', 'the user drinks tea', { embedding: [1, 0, 0], embeddingModelId: 'model-old' }),
  ]);
  let n = 0;
  return {
    store,
    embedder: {
      async embed(texts) {
        return { vectors: texts.map(() => [1, 0, 0]), model: 'model-new' };
      },
    },
    llm: vi.fn<MemorySeams['llm']>(async ({ system }) =>
      system.includes('extract')
        ? '{"facts":["prefers tea"]}'
        : '{"memory":[{"event":"ADD","text":"prefers tea"}]}',
    ),
    clock: { now: () => 1_000_000, setTimeout: () => () => {} },
    generateId: () => `mem-${n++}`,
  };
}

async function warningsOf(stream: ReturnType<typeof streamAgent>): Promise<CallWarning[]> {
  const warnings: CallWarning[] = [];
  for await (const event of stream.events)
    if (event.type === 'part' && event.part.type === 'warning') warnings.push(event.part.warning);
  return warnings;
}

describe('native memory reports on the run', () => {
  it("streams the recall's embedding-mismatch warning", async () => {
    const { model } = scriptedModel([{ text: 'noted' }]);
    const warnings = await warningsOf(
      streamAgent({
        model,
        prompt: 'what do I drink?',
        memory: { seams: await seams(), scope, extract: false },
      }),
    );
    expect(warnings.filter((warning) => warning.type === 'embedding-mismatch')).toHaveLength(1);
  });

  it('charges the memory calls to the run and reports a callback without usage once', async () => {
    const { model } = scriptedModel([{ text: 'noted' }]);
    const store = createInMemoryAgentRunStore();
    const stream = streamAgent({
      model,
      prompt: 'I prefer tea',
      memory: { seams: await seams(), scope, recall: false },
      session: { store, runId: 'charged', scope: 'tenant' },
    });
    const warnings = await warningsOf(stream);
    const result = await stream.result;
    expect(result.status).toBe('completed');
    const saved = (await store.load('charged'))!;
    expect(saved.memory?.extraction?.status).toBe('completed');
    const memoryCalls = saved.execution!.ledger.reservations.filter(
      (entry) => entry.kind === 'memory-llm',
    );
    expect(memoryCalls.length).toBeGreaterThan(0);
    expect(memoryCalls.every((entry) => entry.modelId === 'memory-llm')).toBe(true);
    // One per kind of call (the memory LLM, the embedder), however many calls.
    const unaccounted = warnings.filter((warning) => warning.type === 'unaccounted-usage');
    expect(unaccounted.map((warning) => warning.message.split(' reports')[0])).toEqual([
      'The memory LLM callback',
      'The memory embedder',
    ]);
  });
});

describe('legacy loop memory reports to warnings', () => {
  it("puts the recall's embedding-mismatch in result.warnings", async () => {
    const { model } = scriptedModel([{ text: 'noted' }]);
    const result = streamChat({
      model,
      prompt: 'what do I drink?',
      memory: { seams: await seams(), scope, extract: false },
    });
    await result.consume!();
    const warnings = (await result.warnings) ?? [];
    expect(warnings.filter((warning) => warning.type === 'embedding-mismatch')).toHaveLength(1);
  });
});
