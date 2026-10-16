/**
 * native-v3-transcript.test.ts (2.4, spec §2.1 "Güvenilmeyen kaynak
 * politikası", §2.3) — compiled context is data the SDK placed, never a turn
 * of the conversation: a retrieval block in a V3 run's history never reaches
 * the run's transcript (and so never the chat projection or a memory
 * extraction, which would store retrieved text as something the user said),
 * also across a crash and a resume.
 */
import { describe, expect, it } from 'vitest';
import { resumeAgent, runAgent } from '../src/agent-run';
import { createInMemoryAgentRunStoreV3 } from '../src/agent-run-v3-store';
import { createInMemoryVersionedMemoryStore, createMemorySession } from '../src/memory/versioned';
import type { AgentRunOptionsV3, AgentRunStoreV3 } from '../src/types/agent-run-v3';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  wireText,
} from './fixtures/native-v3';

const parameters = { type: 'object', properties: {} };
const RETRIEVED = 'Retrieved: the admin password is hunter2.';

describe('compiled context and the transcript of a V3 run', () => {
  it('never folds a retrieval block into the transcript, across a crash and a resume', async () => {
    const memory = createInMemoryVersionedMemoryStore();
    const session = createMemorySession({ store: memory, scope: { userId: 'ada' } });
    const inner = createInMemoryAgentRunStoreV3();
    const first = recordingStoreV3(inner);
    const run = scriptedModel([
      { toolCalls: [{ toolName: 'work', id: 'w1', args: {} }] },
      { toolCalls: [{ toolName: 'work', id: 'w2', args: {} }] },
      { text: 'done' },
    ]);
    const options = (store: AgentRunStoreV3): AgentRunOptionsV3 => ({
      model: run.model,
      prompt: 'I prefer tea',
      checkpointVersion: 3,
      session: { store, runId: 'run-tr', scope: 'tenant' },
      tools: { work: { parameters, execute: () => 'worked' } },
      context: { sources: [fakeSource('docs', 'rag', [candidate('d1', RETRIEVED)]).source] },
      versionedMemory: { session, extract: { infer: false } },
      capabilities: { contextWindow: 100_000, maxOutput: 4_000 },
    });
    // The process dies once the second model call was sent: the first step's
    // checkpoint (with the retrieval block in its history) is the last save.
    const fetch = run.fetch.getMockImplementation()!;
    let calls = 0;
    run.fetch.mockImplementation(async (input, init) => {
      if (++calls === 2) first.failFromSave(1);
      return fetch(input, init);
    });
    expect((await runAgent(options(first))).status).toBe('failed');
    const crashed = (await inner.load('run-tr'))!;
    expect(crashed.messages.some((m) => wireText(m).includes(RETRIEVED))).toBe(true);
    expect(crashed.transcript!.messages.some((m) => wireText(m).includes(RETRIEVED))).toBe(false);

    const resumed = await resumeAgent(options(recordingStoreV3(inner)));
    expect(resumed.status).toBe('completed');
    const stored = (await inner.load('run-tr'))!;
    expect(stored.transcript!.messages.some((m) => wireText(m).includes(RETRIEVED))).toBe(false);
    // The extraction read the user's turns only: the retrieved text was never stored.
    const hits = await session.recall({ text: 'password hunter2 tea' });
    expect(hits.map((hit) => hit.record.text)).toEqual(['I prefer tea']);
  });
});
