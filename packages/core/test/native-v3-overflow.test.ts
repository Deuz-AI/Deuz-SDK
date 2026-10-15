/**
 * native-v3-overflow.test.ts (2.4, spec §2.3 step 8) — on a provider
 * overflow, 2.3 compacts again without re-running prepareStep; a V3 run's
 * compiler then places its context again under the smaller budget the
 * overflow proved (the step's package is replaced, refresh
 * `'overflow-retry'`). Mandatory content that cannot fit fails the run with
 * `context_budget_exceeded`; a step whose package placed nothing keeps the
 * 2.3 outcome (the provider's overflow).
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import type { AgentRunOptionsV3 } from '../src/types/agent-run-v3';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  wireText,
  type ScriptedCall,
} from './fixtures/native-v3';

const docs = Array.from({ length: 6 }, (_, index) =>
  candidate(`doc-${index}`, `Fact ${index}: ${'the deploy needs care. '.repeat(6)}`),
);

function overflowRun(script: ScriptedCall[], extra: Partial<AgentRunOptionsV3> = {}) {
  const store = recordingStoreV3();
  const scripted = scriptedModel(script);
  const prepared: number[] = [];
  const options: AgentRunOptionsV3 = {
    model: scripted.model,
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store, runId: 'run-of', scope: 'tenant' },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    prepareStep: ({ stepIndex }) => {
      prepared.push(stepIndex);
      return undefined;
    },
    ...extra,
  };
  return { ...scripted, store, options, prepared };
}

const records = (message: { content?: unknown }) =>
  (wireText(message).match(/<record /g) ?? []).length;

describe('a V3 run on a provider overflow', () => {
  it('recompiles the step under the smaller budget and retries once, without prepareStep', async () => {
    const rag = fakeSource('docs', 'rag', docs);
    const run = overflowRun(['overflow', { text: 'done' }], {
      context: { sources: [rag.source] },
      workingMemory: { create: { scope: 'tenant', goal: 'Ship the service', now: 1 } },
    });
    const result = await runAgent(run.options);
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    const [failed, retried] = run.requests();
    const block = (request: typeof failed) =>
      request!.messages.find((m) => wireText(m).startsWith('<deuz_context '));
    expect(records(block(failed)!)).toBe(docs.length);
    // The retry carries less retrieval, and the working memory tail still.
    expect(block(retried) ? records(block(retried)!) : 0).toBeLessThan(docs.length);
    expect(wireText(retried!.messages.at(-1)!)).toContain('Ship the service');
    // prepareStep ran once (2.3: the retry re-compacts, never re-prepares).
    expect(run.prepared).toEqual([0]);
    // The step's package was replaced, and says why.
    const stored = (await run.store.load('run-of'))!;
    expect(stored.context?.steps).toHaveLength(1);
    expect(stored.context?.steps[0]!.manifest.refresh).toBe('overflow-retry');
    // The source was asked once: the recompile reuses what the step retrieved.
    expect(rag.requests).toHaveLength(1);
    // The history holds the retried block, once.
    const blocks = stored.messages.filter((m) => wireText(m).startsWith('<deuz_context '));
    expect(blocks.length).toBeLessThanOrEqual(1);
  });

  it('fails with context_budget_exceeded when mandatory content cannot fit', async () => {
    const run = overflowRun(['overflow', { text: 'never' }], {
      workingMemory: {
        create: { scope: 'tenant', goal: `Ship ${'with every check. '.repeat(200)}`, now: 1 },
      },
    });
    const result = await runAgent(run.options);
    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'ContextBudgetExceededError', code: 'context_budget_exceeded' },
    });
    expect(run.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider overflow when the package placed nothing and nothing compacted', async () => {
    const empty = fakeSource('docs', 'rag', []);
    const run = overflowRun(['overflow', { text: 'never' }], {
      context: { sources: [empty.source] },
    });
    const result = await runAgent(run.options);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'context_overflow' } });
    expect(run.fetch).toHaveBeenCalledTimes(1);
  });
});
