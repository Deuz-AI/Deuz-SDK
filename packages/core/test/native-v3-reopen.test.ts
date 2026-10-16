/**
 * native-v3-reopen.test.ts (2.4, spec §2.3 "Kaynak ve devam etme
 * kuralları", §4.4 "Context paketleri ve forget") — a checkpointed step that
 * is reopened after a restart uses the same context: the stored package, byte
 * for byte, without asking the sources again. The one exception is a package
 * a `forget` redacted: that step is compiled again (`redacted` in its
 * manifest), and the retrieval blocks of redacted packages leave the run's
 * history before the next request, so a forgotten record is never sent again.
 */
import { describe, expect, it } from 'vitest';
import { resumeAgent, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createContextCompiler } from '../src/context/compiler';
import type {
  ContextCandidate,
  ContextCompiler,
  CreateContextCompilerOptions,
} from '../src/context/types';
import { createMockModel } from '../src/testing';
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  wireText,
  type ScriptedCall,
} from './fixtures/native-v3';

const parameters = { type: 'object', properties: { q: { type: 'string' } } };
const FORGOTTEN = 'The deploy key is under the mat.';

function memories(): ContextCandidate[] {
  return [
    candidate('mem-a', FORGOTTEN, 2, { revision: 1 }),
    candidate('mem-b', 'Deploys go to eu-west.', 1, { revision: 3 }),
  ];
}

function setup(script: ScriptedCall[], answer: ContextCandidate[]) {
  const inner = createInMemoryAgentRunStoreV3();
  const first = recordingStoreV3(inner);
  const memory = fakeSource('memory', 'memory', answer);
  const scripted = scriptedModel(script);
  const options = (store: AgentRunStoreV3): AgentRunOptionsV3 => ({
    model: scripted.model,
    prompt: 'Deploy the service',
    checkpointVersion: 3,
    session: { store, runId: 'run-re', scope: 'tenant' },
    tools: { lookup: { description: 'Look things up.', parameters, execute: () => 'found' } },
    context: { sources: [memory.source] },
    capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
  });
  return { inner, first, memory, ...scripted, options };
}

/** The process dies once the `call`-th model call was sent: no later save lands. */
function crashAtCall(run: ReturnType<typeof setup>, call: number): void {
  const fetch = run.fetch.getMockImplementation()!;
  let calls = 0;
  run.fetch.mockImplementation(async (input, init) => {
    calls += 1;
    if (calls === call) run.first.failFromSave(1);
    return fetch(input, init);
  });
}
const sent = (request: { messages: { content?: unknown }[] }) =>
  request.messages.map((message) => wireText(message)).join('\n');

describe('reopening a checkpointed step', () => {
  it('uses its stored package again, without asking the sources', async () => {
    const run = setup([{ text: 'done' }], memories());
    // The process dies once the step's call was sent, its answer never saved.
    crashAtCall(run, 1);
    const crashed = await runAgent(run.options(run.first));
    expect(crashed.status).toBe('failed');

    const second = recordingStoreV3(run.inner);
    const resumed = await resumeAgent(run.options(second));
    expect(resumed).toMatchObject({ status: 'completed', output: 'done' });
    const [before, after] = run.requests();
    // The model call repeats, with the same request bytes.
    expect(after).toEqual(before);
    expect(run.memory.requests).toHaveLength(1);
    expect(second.blobs).toEqual([]);
    const stored = (await second.load('run-re'))!;
    expect(stored.context?.steps).toHaveLength(1);
    expect(stored.context?.steps[0]!.manifest.refresh).toBe('initial');
  });

  it('compiles a step whose package a forget redacted again, and says so', async () => {
    const answer = memories();
    const run = setup([{ text: 'done' }], answer);
    crashAtCall(run, 1);
    await runAgent(run.options(run.first));
    expect(sent(run.requests()[0]!)).toContain(FORGOTTEN);

    // The record is forgotten while the run is down; its source no longer has it.
    await run.inner.redactForgotten({
      scope: { userId: 'u' },
      recordId: 'mem-a',
      revisions: [1],
      operationId: 'forget-1',
    });
    answer.splice(0, 1);
    const second = recordingStoreV3(run.inner);
    const resumed = await resumeAgent(run.options(second));
    expect(resumed.status).toBe('completed');
    expect(sent(run.requests()[1]!)).not.toContain(FORGOTTEN);
    expect(sent(run.requests()[1]!)).toContain('Deploys go to eu-west.');
    const stored = (await second.load('run-re'))!;
    expect(stored.context?.steps).toHaveLength(1);
    expect(stored.context?.steps[0]!.manifest).toMatchObject({
      refresh: 'redacted',
      redacted: true,
    });
    expect(run.memory.requests).toHaveLength(2);
  });

  it('drops the retrieval blocks of redacted packages from the history before the next request', async () => {
    const answer = memories();
    const run = setup(
      [{ toolCalls: [{ toolName: 'lookup', id: 'l1', args: { q: 'x' } }] }, { text: 'done' }],
      answer,
    );
    // Step 0 ran (its block is in the history); the process dies once step 1's
    // package is recorded, before its answer.
    crashAtCall(run, 2);
    await runAgent(run.options(run.first));
    expect(sent(run.requests()[1]!)).toContain(FORGOTTEN);

    await run.inner.redactForgotten({
      scope: { userId: 'u' },
      recordId: 'mem-a',
      revisions: [1],
      operationId: 'forget-1',
    });
    answer.splice(0, 1);
    const second = recordingStoreV3(run.inner);
    const resumed = await resumeAgent(run.options(second));
    expect(resumed.status).toBe('completed');
    const last = run.requests().at(-1)!;
    expect(sent(last)).not.toContain(FORGOTTEN);
    // The surviving record is placed again by a fresh retrieval.
    expect(sent(last)).toContain('Deploys go to eu-west.');
    const stored = (await second.load('run-re'))!;
    expect(stored.messages.map((message) => wireText(message)).join('\n')).not.toContain(FORGOTTEN);
    expect(stored.context?.steps.at(-1)!.manifest).toMatchObject({
      refresh: 'redacted',
      redacted: true,
      cachePrefixChanged: true,
    });
  });
});

describe('a step reopened after a crash during its overflow retry (S1-3)', () => {
  const FACT1 = 'The cutover window is 02:00 UTC on Sunday.';
  const FACT2 = 'The rollback owner is the platform team.';
  const call = (id: string): ScriptedCall => ({
    toolCalls: [{ toolName: 'lookup', id, args: { q: id } }],
  });

  /**
   * Steps 0 and 1 call `lookup` (its result is long); step 2 overflows, the
   * loop compacts and the step's context is placed again, and the process
   * dies once that retry (the 4th call) was sent. `refreshAt` makes the
   * second lookup add FACT2 to the source and ask for a refresh, so step 2
   * retrieves it fresh.
   */
  function crashedRetry(refreshAt?: number) {
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const answer = [candidate('doc-1', FACT1)];
    const docs = fakeSource('docs', 'rag', answer);
    const compiler = createContextCompiler({ sources: [docs.source] });
    const scripted = scriptedModel([
      call('c0'),
      call('c1'),
      'overflow',
      { text: 'done' },
      'overflow',
      { text: 'done' },
    ]);
    const summary = { text: 'Earlier turns: lookups ran.' };
    const summarizer = createMockModel({ responses: [summary, summary, summary] });
    let lookups = 0;
    const options = (
      store: AgentRunStoreV3,
      context: ContextCompiler | CreateContextCompilerOptions,
    ): AgentRunOptionsV3 => ({
      model: scripted.model,
      prompt: 'Plan the cutover',
      checkpointVersion: 3,
      session: { store, runId: 'run-ovc', scope: 'tenant' },
      tools: {
        lookup: {
          parameters,
          execute: () => {
            if (++lookups === refreshAt) {
              answer.push(candidate('doc-2', FACT2));
              compiler.requestRefresh();
            }
            return 'row '.repeat(3000);
          },
        },
      },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
      compaction: {
        threshold: 0.99,
        keepRecentSteps: 1,
        layers: ['summarize'],
        summarizeModel: summarizer,
      },
      context,
    });
    const fetch = scripted.fetch.getMockImplementation()!;
    let calls = 0;
    scripted.fetch.mockImplementation(async (input, init) => {
      calls += 1;
      if (calls === 4) first.failFromSave(1);
      return fetch(input, init);
    });
    const has = (k: number, fact: string) => sent(scripted.requests()[k]!).includes(fact);
    return { inner, first, docs, compiler, scripted, options, has };
  }

  it('sends the retrieval of the step before the crash again, attempt and retry', async () => {
    const run = crashedRetry();
    await runAgent(run.options(run.first, run.compiler));
    const resumed = await resumeAgent(
      run.options(recordingStoreV3(run.inner), { sources: [run.docs.source] }),
    );
    expect(resumed.status).toBe('completed');
    const facts = run.scripted.requests().map((_, k) => run.has(k, FACT1));
    // Requests 2 and 3: the step's attempt and its retry before the crash;
    // 4 and 5: the same attempt and retry after the restart.
    expect(facts).toEqual([true, true, true, true, true, true]);
    const stored = (await run.inner.load('run-ovc'))!;
    // The reopened step stays step 2: no new step was compiled for it.
    expect(stored.context!.steps.map((step) => step.step)).toEqual([0, 1, 2]);
  });

  it('keeps a refreshed retrieval when the reopened step is sent again', async () => {
    const run = crashedRetry(2);
    await runAgent(run.options(run.first, run.compiler));
    const resumed = await resumeAgent(
      run.options(recordingStoreV3(run.inner), { sources: [run.docs.source] }),
    );
    expect(resumed.status).toBe('completed');
    const requests = run.scripted.requests();
    // Request 2 (the step's first attempt) and request 4 (the same step
    // reopened from the same checkpointed history) carry the same context.
    expect(run.has(2, FACT2)).toBe(true);
    expect(run.has(4, FACT2)).toBe(true);
    expect(sent(requests[4]!)).toBe(sent(requests[2]!));
    // So do the retries before and after the restart.
    expect(sent(requests[5]!)).toBe(sent(requests[3]!));
  });
});
