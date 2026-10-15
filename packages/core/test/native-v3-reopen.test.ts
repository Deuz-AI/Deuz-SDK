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
import type { ContextCandidate } from '../src/context/types';
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
