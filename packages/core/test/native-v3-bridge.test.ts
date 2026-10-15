/**
 * native-v3-bridge.test.ts (2.4, spec §4.1) — the native UI bridge and run
 * inspection take a V3 run: `toDeuzAgentStreamResponse` serializes a V3
 * stream exactly as it does a 2.3 one (the V3 events stay on `eventsV3`, and
 * neither the compiled context nor the working memory tail reaches the
 * wire), and `inspectRun` reports a stored V3 run without a model call.
 */
import { describe, expect, it } from 'vitest';
import { streamAgent } from '../src/agent-run';
import { inspectRun } from '../src/node/headless';
import type { AgentRunStore } from '../src/types/agent-run';
import { readDeuzStream, toDeuzAgentStreamResponse, type DeuzUIPart } from '../src/ui';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  type ScriptedCall,
} from './fixtures/native-v3';

const parameters = { type: 'object' as const, properties: {} };

async function partsOf(response: Response): Promise<DeuzUIPart[]> {
  const parts: DeuzUIPart[] = [];
  for await (const part of readDeuzStream(response)) parts.push(part);
  return parts;
}

/** A part list without the per-run noise (ids, timings), for comparing two runs. */
function shape(parts: DeuzUIPart[]): unknown[] {
  return parts.map((part) => {
    const { type } = part;
    if (type !== 'data-agent') return type;
    const { kind, status } = (part as { payload: { kind: string; status?: string } }).payload;
    return `agent:${kind}${status ? `:${status}` : ''}`;
  });
}

describe('a V3 run on the native UI wire', () => {
  it('frames like a 2.3 run, with nothing of its context on the wire', async () => {
    const script: ScriptedCall[] = [
      { toolCalls: [{ toolName: 'work', id: 'w1', args: {} }] },
      { text: 'all done' },
    ];
    const legacy = scriptedModel(script);
    const v3 = scriptedModel(script);
    const tools = { work: { parameters, execute: () => 'worked' } };
    const before = await partsOf(
      toDeuzAgentStreamResponse(streamAgent({ model: legacy.model, prompt: 'go', tools }), {
        runId: 'run-b',
      }),
    );
    const store = recordingStoreV3();
    const stream = streamAgent({
      model: v3.model,
      prompt: 'go',
      tools,
      checkpointVersion: 3,
      session: { store, runId: 'run-b', scope: 'tenant' },
      context: {
        sources: [fakeSource('docs', 'rag', [candidate('d1', 'Secret doc text.')]).source],
      },
      workingMemory: { create: { scope: 'tenant', goal: 'Finish the work', now: 1 } },
    });
    const after = await partsOf(toDeuzAgentStreamResponse(stream, { runId: 'run-b' }));
    expect(shape(after)).toEqual(shape(before));
    const wire = JSON.stringify(after);
    expect(wire).not.toContain('Secret doc text.');
    expect(wire).not.toContain('Finish the work');
    expect(wire).toContain('"status":"completed"');
  });

  it('inspectRun reports a stored V3 run with no model call', async () => {
    const run = scriptedModel([{ text: 'done' }]);
    const store = recordingStoreV3();
    await streamAgent({
      model: run.model,
      prompt: 'go',
      checkpointVersion: 3,
      session: { store, runId: 'run-i', scope: 'tenant' },
    }).result;
    const calls = run.fetch.mock.calls.length;
    // inspectRun's signature takes a 2.3 store today (wiring request: accept AgentRunStoreV3).
    const report = await inspectRun(store as unknown as AgentRunStore, 'run-i');
    expect(report).toMatchObject({ runId: 'run-i', scope: 'tenant', status: 'completed' });
    expect(run.fetch.mock.calls.length).toBe(calls);
  });
});
