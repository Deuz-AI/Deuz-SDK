/**
 * native-v3-telemetry.test.ts (2.4, spec §3.6) — the `deuz.context.compile`
 * span of a V3 run's step nests under that step's span and shares the run's
 * ids, instead of reporting a leg of its own; its attributes carry counts,
 * digests and token numbers, never content.
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import { createMemoryObserver } from '../src/observe';
import type { ObserveEvent } from '../src/types/observe';
import { candidate, fakeSource, recordingStoreV3, scriptedModel } from './fixtures/native-v3';

const parameters = { type: 'object', properties: {} };
const SECRET = 'The vault code is 4242.';

describe('the context compile span of a V3 run', () => {
  it('nests under the step it compiles for, with no content in its attributes', async () => {
    const observer = createMemoryObserver();
    const rag = fakeSource('docs', 'rag', [candidate('doc-1', SECRET)]);
    const { model } = scriptedModel([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'done' },
    ]);
    const result = await runAgent({
      model,
      prompt: 'Open the vault',
      checkpointVersion: 3,
      session: { store: recordingStoreV3(), runId: 'run-tel', scope: 'tenant' },
      tools: { lookup: { parameters, execute: () => 'ok' } },
      context: { sources: [rag.source] },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
      deps: { observer },
    });
    expect(result.status).toBe('completed');
    const events = observer.events();
    const steps = events.filter(
      (event): event is Extract<ObserveEvent, { type: 'step.started' }> =>
        event.type === 'step.started',
    );
    const compiles = events.filter(
      (event): event is Extract<ObserveEvent, { type: 'operation.started' }> =>
        event.type === 'operation.started' && event.operation === 'deuz.context.compile',
    );
    expect(steps).toHaveLength(2);
    expect(compiles).toHaveLength(2);
    compiles.forEach((compile, index) => {
      expect(compile.parentSpanId).toBe(steps[index]!.spanId);
      expect(compile.runId).toBe(steps[index]!.runId);
      expect(compile.executionId).toBe(steps[index]!.executionId);
    });
    const completed = events.filter(
      (event): event is Extract<ObserveEvent, { type: 'operation.completed' }> =>
        event.type === 'operation.completed' && event.operation === 'deuz.context.compile',
    );
    expect(completed[0]!.attributes).toMatchObject({
      'deuz.context.selected': 1,
      'deuz.context.refresh_reason': 'initial',
      'deuz.context.cache_prefix_changed': false,
    });
    expect(JSON.stringify(completed)).not.toContain('vault code');
  });
});

describe('the overflow recompile span', () => {
  it('nests under the same step span as the compile it replaces', async () => {
    const observer = createMemoryObserver();
    const docs = Array.from({ length: 4 }, (_, index) =>
      candidate(`doc-${index}`, `Fact ${index}: ${'mind the cutover. '.repeat(6)}`),
    );
    const { model } = scriptedModel(['overflow', { text: 'done' }]);
    const result = await runAgent({
      model,
      prompt: 'Cut over',
      checkpointVersion: 3,
      session: { store: recordingStoreV3(), runId: 'run-tel-of', scope: 'tenant' },
      context: { sources: [fakeSource('docs', 'rag', docs).source] },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
      deps: { observer },
    });
    expect(result.status).toBe('completed');
    const events = observer.events();
    const step = events.find((event) => event.type === 'step.started')!;
    const compiles = events.filter(
      (event): event is Extract<ObserveEvent, { type: 'operation.started' }> =>
        event.type === 'operation.started' && event.operation === 'deuz.context.compile',
    );
    expect(compiles).toHaveLength(2);
    for (const compile of compiles) expect(compile.parentSpanId).toBe(step.spanId);
  });
});
