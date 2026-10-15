/**
 * Lane L3b's 2.4 acceptance scenarios (new.txt §5.1, area `context`): the
 * context compiler and working memory in the native loop of a V3 run.
 *
 * - decision-preservation (§2.5, §5.2 "karar korunumu"): the working memory's
 *   decisions reach every request, before and after two compactions, from the
 *   V3 state and never from a summary.
 * - compaction-boundary (§2.3 "Yerleşim"): old context blocks leave only at a
 *   compaction boundary; the compiler places what was removed again and the
 *   manifest of that step, and only that step, says the cache prefix changed.
 * - cache-safe-placement (§2.3): a retrieval refresh appends only what is new;
 *   every request starts with the previous one (its tail aside), the system
 *   message and tools never change, and every manifest says the prefix held.
 * - overflow-recompile (§2.3 step 8, fault): on a provider overflow the step's
 *   context is compiled again under the smaller budget and the retry succeeds.
 * - double-injection-rejected (§2.3): compiler memory and the legacy recall
 *   together are refused at configuration time, before anything runs.
 */
import { expect, vi } from 'vitest';
import { runAgent, streamAgent } from '../../src/agent-run';
import { createContextCompiler } from '../../src/context/compiler';
import { applyWorkingMemoryPatch, createWorkingMemory } from '../../src/context/working-memory';
import { createInMemoryMemoryStore, type MemorySeams } from '../../src/memory';
import { createMockModel } from '../../src/testing';
import type { ContextCandidate } from '../../src/context/types';
import type { AgentRunOptionsV3 } from '../../src/types/agent-run-v3';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  wireText,
  type ScriptedCall,
  type WireRequest,
} from '../fixtures/native-v3';
import { scenario } from './registry';

const parameters = { type: 'object', properties: { q: { type: 'string' } } };
const isBlock = (message: { content?: unknown }) => wireText(message).startsWith('<deuz_context ');
const isTail = (message: { content?: unknown }) =>
  wireText(message).startsWith('<deuz_working_memory ');
const call = (id: string): ScriptedCall => ({
  toolCalls: [{ toolName: 'lookup', id, args: { q: id } }],
});

/** A working memory with two decisions the host accepted. */
function decided() {
  const created = createWorkingMemory({ scope: 'tenant', goal: 'Migrate the database', now: 1 });
  const patched = applyWorkingMemoryPatch(
    created,
    {
      operationId: 'host-decisions',
      expectedRevision: 0,
      writer: 'host',
      operations: [
        { op: 'add-decision', text: 'Use Postgres 16', rationale: 'LTS' },
        { op: 'add-decision', text: 'Freeze writes during the cutover' },
      ],
    },
    { now: 2 },
  );
  if (patched.status !== 'applied') throw new Error('host patch refused');
  return patched.snapshot;
}

/** A run whose history outgrows a small window, so compaction summarizes old turns. */
function compactingRun(steps: number, answer: ContextCandidate[]) {
  const store = recordingStoreV3();
  const script = [...Array.from({ length: steps }, (_, i) => call(`c${i}`)), { text: 'done' }];
  const main = scriptedModel(script);
  const summarizer = createMockModel({ responses: [{ text: 'Earlier turns: lookups ran.' }] });
  const docs = fakeSource('docs', 'rag', answer);
  const options: AgentRunOptionsV3 = {
    model: main.model,
    prompt: 'Plan the migration',
    checkpointVersion: 3,
    session: { store, runId: 'run-compact', scope: 'tenant' },
    tools: { lookup: { parameters, execute: () => 'row '.repeat(500) } },
    maxSteps: steps + 2,
    capabilities: { contextWindow: 3_000, maxOutput: 200 },
    compaction: {
      threshold: 0.3,
      keepRecentSteps: 1,
      layers: ['summarize'],
      summarizeModel: summarizer,
    },
    context: { sources: [docs.source] },
    workingMemory: { snapshot: decided() },
  };
  return { store, options, requests: main.requests };
}

scenario('context', 'decision-preservation', async () => {
  const run = compactingRun(6, [candidate('doc-1', 'Postgres 16 supports logical replication.')]);
  const stream = streamAgent(run.options);
  let compactions = 0;
  for await (const event of stream.events)
    if (event.type === 'part' && event.part.type === 'compaction') compactions++;
  expect((await stream.result).status).toBe('completed');
  expect(compactions).toBeGreaterThanOrEqual(2);
  const requests = run.requests();
  // Every request ends with the current working memory, both decisions in it.
  for (const request of requests) {
    const tail = request.messages.at(-1)!;
    expect(isTail(tail)).toBe(true);
    expect(wireText(tail)).toContain('Use Postgres 16');
    expect(wireText(tail)).toContain('Freeze writes during the cutover');
    // Exactly one tail: earlier copies are never history.
    expect(request.messages.filter(isTail)).toHaveLength(1);
  }
  // Two compactions happened, and neither summary carried the working memory.
  const stored = (await run.store.load('run-compact'))!;
  for (const message of stored.messages) expect(isTail(message)).toBe(false);
  const summaries = requests.flatMap((request) =>
    request.messages.filter((message) => wireText(message).includes('Earlier turns')),
  );
  expect(summaries.length).toBeGreaterThan(0);
});

scenario('context', 'compaction-boundary', async () => {
  const run = compactingRun(6, [candidate('doc-1', 'Postgres 16 supports logical replication.')]);
  expect((await runAgent(run.options)).status).toBe('completed');
  const requests = run.requests();
  const steps = (await run.store.load('run-compact'))!.context!.steps;
  expect(steps).toHaveLength(requests.length);
  const changed = steps.filter((step) => step.manifest.cachePrefixChanged).map((s) => s.step);
  expect(changed.length).toBeGreaterThan(0);
  for (const step of steps) {
    const request = requests[step.step]!;
    const previous = requests[step.step - 1];
    // The prefix changed exactly where the previous request's history was rewritten.
    const kept =
      previous !== undefined &&
      JSON.stringify(request.messages.slice(0, previous.messages.length - 1)) ===
        JSON.stringify(previous.messages.slice(0, -1));
    expect(step.manifest.cachePrefixChanged).toBe(step.step > 0 && !kept);
  }
  // After each boundary the retrieval the summary removed is placed again,
  // and the working memory tail is there, from the V3 state.
  for (const at of changed) {
    const request = requests[at]!;
    expect(request.messages.filter(isBlock).map(wireText).join('')).toContain(
      'logical replication',
    );
    expect(isTail(request.messages.at(-1)!)).toBe(true);
  }
});

scenario('context', 'cache-safe-placement', async () => {
  const store = recordingStoreV3();
  const answer = [candidate('doc-1', 'Deploys go to eu-west.')];
  const docs = fakeSource('docs', 'rag', answer);
  const compiler = createContextCompiler({ sources: [docs.source] });
  const main = scriptedModel([call('a'), call('b'), call('c'), { text: 'done' }]);
  const result = await runAgent({
    model: main.model,
    instructions: 'Be careful.',
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store, runId: 'run-cache', scope: 'tenant' },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    tools: {
      lookup: {
        parameters,
        execute: (args: { q?: string }) => {
          // After the first lookup the host learns more and asks for a refresh.
          if (args.q === 'a') {
            answer.push(candidate('doc-2', 'The deploy window is 02:00 UTC.'));
            compiler.requestRefresh();
          }
          return 'ok';
        },
      },
    },
    context: compiler,
    workingMemory: { create: { scope: 'tenant', goal: 'Deploy safely', now: 1 } },
  });
  expect(result.status).toBe('completed');
  const requests: WireRequest[] = main.requests();
  for (let k = 1; k < requests.length; k++) {
    const before = requests[k - 1]!.messages;
    const after = requests[k]!.messages;
    // The next request starts with the previous one, its ephemeral tail aside.
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after[0]).toEqual(before[0]);
    expect(requests[k]!.tools).toEqual(requests[0]!.tools);
  }
  const steps = (await store.load('run-cache'))!.context!.steps;
  expect(steps.every((step) => !step.manifest.cachePrefixChanged)).toBe(true);
  const refreshed = steps.find((step) => step.manifest.refresh === 'host-request')!;
  expect(refreshed.manifest.pass).toBe(2);
  const reasons = Object.fromEntries(
    refreshed.manifest.entries
      .filter((entry) => entry.source === 'docs')
      .map((entry) => [entry.recordId, entry.reason]),
  );
  expect(reasons).toEqual({ 'doc-1': 'already-placed', 'doc-2': 'ranked' });
  // The refresh appended only the new record, in a block of its own.
  const blocks = requests.at(-1)!.messages.filter(isBlock).map(wireText);
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toContain('02:00 UTC');
  expect(blocks[1]).not.toContain('eu-west');
});

scenario(
  'context',
  'overflow-recompile',
  async () => {
    const store = recordingStoreV3();
    const docs = Array.from({ length: 6 }, (_, index) =>
      candidate(`doc-${index}`, `Fact ${index}: ${'the cutover needs care. '.repeat(6)}`),
    );
    const source = fakeSource('docs', 'rag', docs);
    const main = scriptedModel(['overflow', { text: 'done' }]);
    const prepared = vi.fn(() => undefined);
    const result = await runAgent({
      model: main.model,
      prompt: 'Plan the cutover',
      checkpointVersion: 3,
      session: { store, runId: 'run-overflow', scope: 'tenant' },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
      prepareStep: prepared,
      context: { sources: [source.source] },
      workingMemory: { create: { scope: 'tenant', goal: 'Cut over safely', now: 1 } },
    });
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    const [failed, retried] = main.requests();
    const records = (request: WireRequest) =>
      request.messages
        .filter(isBlock)
        .map((message) => (wireText(message).match(/<record /g) ?? []).length)
        .reduce((sum, n) => sum + n, 0);
    expect(records(failed!)).toBe(6);
    expect(records(retried!)).toBeLessThan(6);
    expect(wireText(retried!.messages.at(-1)!)).toContain('Cut over safely');
    expect(prepared).toHaveBeenCalledTimes(1);
    const steps = (await store.load('run-overflow'))!.context!.steps;
    expect(steps.map((step) => step.manifest.refresh)).toEqual(['overflow-retry']);
    expect(source.requests).toHaveLength(1);
  },
  { fault: true },
);

scenario('context', 'double-injection-rejected', async () => {
  const legacy = createInMemoryMemoryStore();
  const search = vi.spyOn(legacy, 'search');
  const seams: MemorySeams = {
    store: legacy,
    llm: async () => '{"facts":[]}',
    clock: { now: () => 1, setTimeout: () => () => {} },
    generateId: () => 'm',
  };
  const memorySource = fakeSource('memory', 'memory', [candidate('m-1', 'likes tea')]);
  const store = recordingStoreV3();
  const main = scriptedModel([{ text: 'never' }]);
  const result = await runAgent({
    model: main.model,
    prompt: 'what do I drink?',
    checkpointVersion: 3,
    session: { store, runId: 'run-double', scope: 'tenant' },
    context: { sources: [memorySource.source] },
    memory: { seams, scope: { userId: 'ada' } },
  });
  expect(result).toMatchObject({
    status: 'failed',
    error: { name: 'TypeError', message: expect.stringMatching(/injected twice/) },
  });
  expect(main.fetch).not.toHaveBeenCalled();
  expect(store.saves).toEqual([]);
  expect(search).not.toHaveBeenCalled();
  expect(memorySource.requests).toHaveLength(0);
});
