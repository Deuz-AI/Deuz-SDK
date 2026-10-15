import { describe, expect, it } from 'vitest';
import { resumeAgent, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
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
const call = (id: string): ScriptedCall => ({
  toolCalls: [{ toolName: 'lookup', id, args: { q: id } }],
});
const FACT = 'The cutover window is 02:00 UTC on Sunday.';

describe('review S1: crash during an overflow retry', () => {
  it('a restart keeps the context the reopened step had', async () => {
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const docs = fakeSource('docs', 'rag', [candidate('doc-1', FACT)]);
    const script: ScriptedCall[] = [
      call('c0'),
      call('c1'),
      'overflow',
      { text: 'done' },
      'overflow',
      { text: 'done' },
    ];
    const scripted = scriptedModel(script);
    const summarizer = createMockModel({
      responses: [{ text: 'Earlier turns: lookups ran.' }, { text: 'Earlier turns: lookups ran.' }],
    });
    const options = (store: AgentRunStoreV3): AgentRunOptionsV3 => ({
      model: scripted.model,
      prompt: 'Plan the cutover',
      checkpointVersion: 3,
      session: { store, runId: 'run-ovc', scope: 'tenant' },
      tools: { lookup: { parameters, execute: () => 'row '.repeat(3000) } },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
      compaction: {
        threshold: 0.99,
        keepRecentSteps: 1,
        layers: ['summarize'],
        summarizeModel: summarizer,
      },
      context: { sources: [docs.source] },
    });
    // The process dies once the overflow retry (the 4th call) was sent.
    const fetch = scripted.fetch.getMockImplementation()!;
    let calls = 0;
    scripted.fetch.mockImplementation(async (input, init) => {
      calls += 1;
      if (calls === 4) first.failFromSave(1);
      return fetch(input, init);
    });
    const crashed = await runAgent(options(first));
    // eslint-disable-next-line no-console
    console.log('crashed:', crashed.status);
    const stored = (await inner.load('run-ovc'))!;
    // eslint-disable-next-line no-console
    console.log(
      'stored steps:',
      JSON.stringify(stored.context?.steps.map((s) => [s.step, s.manifest.refresh, s.input?.slice(0, 15)])),
    );
    // eslint-disable-next-line no-console
    console.log('step2 manifest:', JSON.stringify({ entries: stored.context?.steps[2]?.manifest.entries, budget: stored.context?.steps[2]?.manifest.budget, placement: stored.context?.steps[2]?.manifest.placement }));
    // eslint-disable-next-line no-console
    console.log('req3:', JSON.stringify(scripted.requests()[3]!.messages.map((m) => [m.role, wireText(m).slice(0, 80)])));
    // eslint-disable-next-line no-console
    console.log('req2:', JSON.stringify(scripted.requests()[2]!.messages.map((m) => [m.role, wireText(m).slice(0, 80)])));
    const second = recordingStoreV3(inner);
    const resumed = await resumeAgent(options(second));
    // eslint-disable-next-line no-console
    console.log('resumed:', resumed.status);
    const requests = scripted.requests();
    const has = (k: number) =>
      requests[k]!.messages.map((m) => wireText(m)).join('\n').includes(FACT);
    // eslint-disable-next-line no-console
    console.log(
      'requests:',
      requests.length,
      requests.map((_, k) => has(k)),
      'summaries in retry:',
      requests.map((r) => r.messages.some((m) => wireText(m).includes('Earlier turns'))),
    );
    // The original overflow retry (request 3) carried the fact; so must the
    // retry of the reopened step after the restart (request 5).
    expect(has(3)).toBe(true);
    expect(has(5)).toBe(true);
  });
});
