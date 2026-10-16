import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent-run';
import { createContextCompiler } from '../src/context/compiler';
import {
  candidate,
  fakeSource,
  recordingStoreV3,
  scriptedModel,
  spyCompiler,
} from './fixtures/native-v3';
import type { AgentRunOptionsV3 } from '../src/types/agent-run-v3';

// Context reservation must track the call's output setting, not a catalog default.
describe('context reservation uses the effective output cap', () => {
  it.each([1024, 8192])(
    'reserves an explicit %i-token output budget in native tool steps',
    async (maxOutputTokens) => {
      const source = fakeSource('docs', 'rag', [candidate('record', 'Context for a task')]);
      const spy = spyCompiler(createContextCompiler({ sources: [source.source] }));
      const store = recordingStoreV3();
      const scripted = scriptedModel([{ text: 'done' }]);
      const result = await runAgent({
        model: scripted.model,
        prompt: 'Explain',
        checkpointVersion: 3,
        session: { store, runId: `budget-${maxOutputTokens}`, scope: 'tenant' },
        context: spy.compiler,
        capabilities: { contextWindow: 100_000, maxOutput: 4096 },
        maxOutputTokens,
        tools: {
          lookup: { parameters: { type: 'object', properties: {} }, execute: () => 'done' },
        },
      });
      expect(result.status).toBe('completed');
      expect(spy.inputs[0]!.model.maxOutputTokens).toBe(maxOutputTokens);
      expect(scripted.requests()[0]!.max_tokens).toBe(maxOutputTokens);
    },
  );

  it('reserves the final structured answer call cap too', async () => {
    const source = fakeSource('docs', 'rag', [candidate('record', 'The answer is yes')]);
    const spy = spyCompiler(createContextCompiler({ sources: [source.source] }));
    const store = recordingStoreV3();
    const scripted = scriptedModel([{ text: '{"answer":"yes"}' }]);
    const output = {
      mode: 'json',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      validate: (value: unknown) => value,
    } as AgentRunOptionsV3['output'];
    await runAgent({
      model: scripted.model,
      prompt: 'Answer',
      checkpointVersion: 3,
      session: { store, runId: 'budget-final', scope: 'tenant' },
      context: spy.compiler,
      capabilities: { contextWindow: 100_000, maxOutput: 4096 },
      maxOutputTokens: 8192,
      output,
    });
    expect(spy.inputs[0]!.model.maxOutputTokens).toBe(8192);
    expect(scripted.requests()[0]!.max_tokens).toBe(8192);
  });
});
