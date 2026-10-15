/**
 * native-v3-injection.test.ts (2.4, spec §2.3 "Kaynakların bugünkü durumu",
 * "Kaynak ve devam etme kuralları") — when the context compiler places
 * memory, the legacy automatic recall is off; a run configured with both (a
 * memory source and `memory` whose recall is on) would inject the same
 * memories twice, and is refused at configuration time, before any read,
 * write or model call.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent-run';
import { createContextCompiler } from '../src/context/compiler';
import { createInMemoryMemoryStore, type MemorySeams } from '../src/memory';
import type { AgentRunOptionsV3 } from '../src/types/agent-run-v3';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  wireText,
} from './fixtures/native-v3';

function legacyMemory() {
  const store = createInMemoryMemoryStore();
  void store.upsert([
    {
      id: 'seed-1',
      text: 'likes green tea',
      hash: 'h:likes green tea',
      kind: 'semantic',
      scope: { userId: 'ada' },
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  const search = vi.spyOn(store, 'search');
  let n = 0;
  const seams: MemorySeams = {
    store,
    llm: vi.fn<MemorySeams['llm']>(async () => '{"facts":[]}'),
    clock: { now: () => 5_000, setTimeout: () => () => {} },
    generateId: () => `mem-${n++}`,
    hashFn: async (text) => `h:${text}`,
  };
  return { seams, search };
}

function run(extra: Partial<AgentRunOptionsV3>) {
  const store = recordingStoreV3();
  const scripted = scriptedModel([{ text: 'done' }]);
  const options: AgentRunOptionsV3 = {
    model: scripted.model,
    prompt: 'what do I drink?',
    checkpointVersion: 3,
    session: { store, runId: 'run-inj', scope: 'tenant' },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    ...extra,
  };
  return { ...scripted, store, options };
}

const isRecall = (message: { role?: string; content?: unknown }) =>
  message.role === 'system' && wireText(message).startsWith('Relevant memories:');

describe('memory injected by the compiler or by the legacy recall, never both', () => {
  it('refuses a memory source with the legacy recall on, before anything runs', async () => {
    const memory = legacyMemory();
    const source = fakeSource('memory', 'memory', [candidate('m-1', 'likes green tea')]);
    for (const context of [
      { sources: [source.source] },
      createContextCompiler({ sources: [source.source] }),
    ]) {
      const { options, fetch, store } = run({
        context,
        memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false },
      });
      const result = await runAgent(options);
      expect(result).toMatchObject({
        status: 'failed',
        error: { name: 'TypeError', message: expect.stringMatching(/injected twice/) },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(store.saves).toEqual([]);
    }
    expect(memory.search).not.toHaveBeenCalled();
    expect(source.requests).toHaveLength(0);
  });

  it('with recall off, only the compiler places memory', async () => {
    const memory = legacyMemory();
    const source = fakeSource('memory', 'memory', [candidate('m-1', 'likes green tea')]);
    const { options, requests } = run({
      context: { sources: [source.source] },
      memory: { seams: memory.seams, scope: { userId: 'ada' }, recall: false, extract: false },
    });
    expect(await runAgent(options)).toMatchObject({ status: 'completed' });
    const sent = requests()[0]!.messages;
    expect(sent.some(isRecall)).toBe(false);
    expect(sent.filter((m) => wireText(m).startsWith('<deuz_context '))).toHaveLength(1);
    expect(memory.search).not.toHaveBeenCalled();
  });

  it('without a memory source, the legacy recall stays as in 2.3 beside the compiler', async () => {
    const memory = legacyMemory();
    const rag = fakeSource('docs', 'rag', [candidate('d-1', 'Tea is stored on shelf 2.')]);
    const { options, requests } = run({
      context: { sources: [rag.source] },
      memory: { seams: memory.seams, scope: { userId: 'ada' }, extract: false },
    });
    expect(await runAgent(options)).toMatchObject({ status: 'completed' });
    const sent = requests()[0]!.messages;
    expect(sent.filter(isRecall)).toHaveLength(1);
    expect(sent.filter((m) => wireText(m).startsWith('<deuz_context '))).toHaveLength(1);
  });
});
