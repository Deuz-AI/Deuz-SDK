import { describe, expect, it, vi } from 'vitest';
import { createInMemoryAgentRunStore, resumeAgent, runAgent, streamAgent } from '../src/agent-run';
import type { AgentEvent, AgentRunOptions, AgentRunStore } from '../src/types/agent-run';
import { createMockModel, type MockResponse } from '../src/testing';
import { readConfig } from '../src/internal/config-symbol';
import { completedArrayElements } from '../src/inference/agent-output';
import { createDeferred } from '../src/internal/async-iter';

const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
const output = {
  schema,
  mode: 'json' as const,
  validate(value: unknown): { answer: number } {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { answer?: unknown }).answer !== 'number'
    )
      throw new Error('answer must be a number');
    return value as { answer: number };
  },
};
const parameters = { type: 'object', properties: {} };

function mocked(responses: MockResponse[]) {
  const model = createMockModel({ responses });
  const config = readConfig(model)!;
  const fetch = vi.fn(config.fetch!);
  config.fetch = fetch;
  const requests = () =>
    fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  return { model, fetch, requests };
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('native agent execution', () => {
  it('allows one executor per store/run for both start and resume', async () => {
    const { model, fetch } = mocked([
      { toolCalls: [{ toolName: 'work', id: 'w', args: {} }] },
      { text: 'done' },
    ]);
    const store = createInMemoryAgentRunStore();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const execute = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return 'worked';
    });
    const options = {
      model,
      prompt: 'x',
      session: { store, runId: 'single', scope: 'tenant' },
      tools: { work: { parameters, execute, needsApproval: true } },
    };
    const first = runAgent(options);
    expect(await runAgent(options)).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('active executor') },
    });
    expect((await first).status).toBe('suspended');
    const resumed = resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: 'w', approved: true }],
    });
    await entered.promise;
    expect(
      await resumeAgent({ ...options, approvalResponses: [{ approvalId: 'w', approved: true }] }),
    ).toMatchObject({ status: 'failed' });
    release.resolve();
    expect((await resumed).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('scopes receipts to the model turn when providers reuse a call ID', async () => {
    const { model } = mocked([
      { toolCalls: [{ toolName: 'work', id: 'reused', args: {} }] },
      { toolCalls: [{ toolName: 'work', id: 'reused', args: {} }] },
      { toolCalls: [{ toolName: 'other', id: 'reused', args: {} }] },
      { text: 'done' },
    ]);
    const execute = vi.fn(() => 'work');
    const other = vi.fn(() => 'other');
    const store = createInMemoryAgentRunStore();
    const result = await runAgent({
      model,
      prompt: 'x',
      session: { store, scope: 'tenant', runId: 'ids' },
      tools: { work: { parameters, execute }, other: { parameters, execute: other } },
    });
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
    expect(Object.values((await store.load('ids'))!.toolResults!)).toHaveLength(3);
  });
  it('is synchronous and cold until consumed; all streams share one execution', async () => {
    const { model, fetch } = mocked([{ text: 'hello' }]);
    const stream = streamAgent({ model, prompt: 'Hi' });
    expect(fetch).not.toHaveBeenCalled();
    const events = collect(stream.events);
    const text = collect(stream.textStream);
    const result = await stream.result;
    expect(result).toMatchObject({
      status: 'completed',
      output: 'hello',
      modelSteps: 1,
      usage: { totalTokens: 15 },
    });
    expect(await text).toEqual(['hel', 'lo']);
    expect((await events).at(-1)).toMatchObject({
      type: 'result',
      result: { status: 'completed' },
    });
    expect(await stream.consume()).toBe(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates raw JSON Schema contracts before any network call', async () => {
    const { model, fetch } = mocked([{ text: '{}' }]);
    const result = await runAgent({
      model,
      prompt: 'x',
      output: { schema },
    } as unknown as AgentRunOptions<unknown>);
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('runtime validator') },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs structured-only output in one call and repairs invalid output within the shared step budget', async () => {
    const { model, fetch } = mocked([{ text: '{"answer":"bad"}' }, { text: '{"answer":42}' }]);
    const result = await runAgent({ model, prompt: 'answer', output, maxSteps: 2 });
    expect(result).toMatchObject({
      status: 'completed',
      output: { answer: 42 },
      modelSteps: 2,
      usage: { totalTokens: 30 },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never brands a malformed candidate as completed and bounds repair', async () => {
    const { model, fetch } = mocked([{ text: '{"answer":"bad"}' }]);
    const result = await runAgent({ model, prompt: 'answer', output });
    expect(result).toMatchObject({ status: 'stopped', reason: 'invalid-output', modelSteps: 2 });
    expect(result).not.toHaveProperty('output');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the canonical tool loop then a tools-disabled finalizer', async () => {
    const { model, requests } = mocked([
      { toolCalls: [{ toolName: 'lookup', args: {} }] },
      { text: 'I found it.' },
      { text: '{"answer":7}' },
    ]);
    const execute = vi.fn(() => ({ answer: 7, private: 'secret' }));
    const events: AgentEvent<{ answer: number }>[] = [];
    const stream = streamAgent({
      model,
      prompt: 'Find answer',
      output,
      tools: {
        lookup: { parameters, execute, toModelOutput: (value) => ({ answer: value.answer }) },
      },
    });
    for await (const event of stream.events) events.push(event);
    expect(await stream.result).toMatchObject({
      status: 'completed',
      output: { answer: 7 },
      modelSteps: 3,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests()[0]).toHaveProperty('tools');
    expect(requests()[2]).not.toHaveProperty('tools');
    expect(JSON.stringify(requests()[1])).not.toContain('secret');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-output',
        rawResult: { answer: 7, private: 'secret' },
        modelOutput: { answer: 7 },
      }),
    );
  });

  it('applies the same maxSteps to tool work and finalization', async () => {
    const { model, fetch } = mocked([
      { toolCalls: [{ toolName: 'work', args: {} }] },
      { text: 'ready' },
      { text: '{"answer":1}' },
    ]);
    const result = await runAgent({
      model,
      prompt: 'x',
      output,
      maxSteps: 2,
      tools: { work: { parameters, execute: () => 'ok' } },
    });
    expect(result).toMatchObject({ status: 'stopped', reason: 'max-steps', modelSteps: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not finalize while approval is pending; resumes once without repeating the tool', async () => {
    const { model, fetch } = mocked([
      { toolCalls: [{ toolName: 'work', args: {}, id: 'work1' }] },
      { text: 'ready' },
      { text: '{"answer":1}' },
    ]);
    const store = createInMemoryAgentRunStore();
    const session = { store, scope: 'tenant', runId: 'approval' };
    const execute = vi.fn(() => 'ok');
    const options = {
      model,
      prompt: 'x',
      output,
      session,
      tools: { work: { parameters, needsApproval: true, execute } },
    };
    const first = await runAgent(options);
    expect(first.status).toBe('suspended');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect((await resumeAgent(options)).status).toBe('suspended');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    const result = await resumeAgent({
      ...options,
      approvalResponses: [{ approvalId: 'work1', approved: true }],
    });
    expect(result).toMatchObject({
      status: 'completed',
      output: { answer: 1 },
      modelSteps: 3,
      usage: { totalTokens: 45 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await resumeAgent(options)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejected verification is bounded and inconclusive or checker errors never accept', async () => {
    for (const verify of [
      vi.fn(() => ({ status: 'inconclusive' as const })),
      vi.fn(() => {
        throw new Error('checker down');
      }),
    ]) {
      const { model, fetch } = mocked([{ text: 'candidate' }]);
      const result = await runAgent({ model, prompt: 'x', verify });
      expect(result).toMatchObject({
        status: 'stopped',
        reason: 'verification-inconclusive',
        verification: 'inconclusive',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const { model, fetch } = mocked([{ text: 'candidate' }]);
    const verify = vi.fn(() => ({ status: 'rejected' as const, feedback: 'Try harder' }));
    const result = await runAgent({ model, prompt: 'x', verify, maxVerifyAttempts: 2 });
    expect(result).toMatchObject({
      status: 'stopped',
      verification: 'rejected',
      reason: 'verification-attempts-exhausted',
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('verifies the schema-valid rewritten candidate and exposes shared accounting', async () => {
    const { model } = mocked([{ text: '{"answer":1}' }]);
    const verify = vi.fn(() => ({ status: 'verified' as const }));
    const result = await runAgent({
      model,
      prompt: 'x',
      output,
      verify,
      guardrails: { onOutput: () => ({ action: 'rewrite', text: '{"answer":2}' }) },
    });
    expect(result).toMatchObject({
      status: 'completed',
      output: { answer: 2 },
      verification: 'verified',
      accounting: { spent: { tokens: 15 }, unknownUsd: 1 },
    });
    expect(verify.mock.calls).toHaveLength(1);
    expect(result.messages.at(-1)?.content).toBe('{"answer":2}');
  });

  it('streams untrusted drafts separately from independently validated complete array elements', async () => {
    const { model } = mocked([{ text: '[{"answer":1},{"answer":2}]' }]);
    const stream = streamAgent({
      model,
      prompt: 'x',
      output: {
        schema: { type: 'array', items: schema },
        mode: 'json',
        validate: (value: unknown) => {
          if (!Array.isArray(value)) throw new Error('array');
          return value.map(output.validate);
        },
        element: output,
      },
    });
    const elements = collect(stream.elementStream);
    const drafts = collect(stream.partialOutputStream);
    expect((await stream.result).status).toBe('completed');
    expect(await elements).toEqual([
      { attempt: 0, index: 0, value: { answer: 1 } },
      { attempt: 0, index: 1, value: { answer: 2 } },
    ]);
    expect((await drafts).length).toBeGreaterThan(0);
    expect(completedArrayElements('[1')).toEqual([]);
    expect(completedArrayElements('[1,2')).toEqual([1]);
    expect(completedArrayElements('[{"x":"a\\\"b"},')).toEqual([{ x: 'a"b' }]);
  });

  it('fails persistence before effect dispatch and never publishes completion', async () => {
    const { model, fetch } = mocked([{ text: 'done' }]);
    const store: AgentRunStore = {
      load: () => undefined,
      save: () => {
        throw new Error('disk full');
      },
    };
    const result = await runAgent({
      model,
      prompt: 'x',
      session: { store, scope: 'tenant', runId: 'r' },
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers the atomic completed-loop outcome without repeating tool work', async () => {
    const { model, fetch } = mocked([
      { toolCalls: [{ toolName: 'work', args: {} }] },
      { text: 'ready' },
      { text: '{"answer":3}' },
    ]);
    const memory = createInMemoryAgentRunStore();
    let fail = true;
    const store: AgentRunStore = {
      load: memory.load,
      save: async (envelope) => {
        if (fail && envelope.phase === 'finalizing') {
          fail = false;
          throw new Error('crash at transition');
        }
        await memory.save(envelope);
      },
    };
    const execute = vi.fn(() => 'worked');
    const options = {
      model,
      prompt: 'x',
      output,
      session: { store, scope: 'tenant', runId: 'recover' },
      tools: { work: { parameters, execute } },
    };
    expect((await runAgent(options)).status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await resumeAgent(options)).toMatchObject({
      status: 'completed',
      output: { answer: 3 },
      modelSteps: 3,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('recovers a persisted final candidate without another paid call', async () => {
    const { model, fetch } = mocked([{ text: '{"answer":9}' }]);
    const memory = createInMemoryAgentRunStore();
    let fail = true;
    const store: AgentRunStore = {
      load: memory.load,
      save: async (envelope) => {
        if (fail && envelope.phase === 'terminal') {
          fail = false;
          throw new Error('terminal commit failed');
        }
        await memory.save(envelope);
      },
    };
    const options = {
      model,
      prompt: 'x',
      output,
      session: { store, scope: 'tenant', runId: 'candidate' },
    };
    expect((await runAgent(options)).status).toBe('failed');
    expect(await resumeAgent(options)).toMatchObject({
      status: 'completed',
      output: { answer: 9 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects scope or model binding mismatches without corrupting a completed result', async () => {
    const { model, fetch } = mocked([{ text: 'done' }]);
    const store = createInMemoryAgentRunStore();
    const options = { model, prompt: 'x', session: { store, scope: 'tenant', runId: 'binding' } };
    const result = await runAgent(options);
    expect(
      (await resumeAgent({ ...options, session: { ...options.session, scope: 'other' } })).status,
    ).toBe('failed');
    expect((await resumeAgent({ ...options, bindingId: 'new-revision' })).status).toBe('failed');
    expect(await resumeAgent(options)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps client tools suspended until exact results arrive and validates/projects them through the executor', async () => {
    const { model, fetch, requests } = mocked([
      { toolCalls: [{ toolName: 'browser', id: 'client1', args: {} }] },
      { text: 'done' },
    ]);
    const session = { store: createInMemoryAgentRunStore(), scope: 'tenant', runId: 'client' };
    const options = {
      model,
      prompt: 'x',
      session,
      tools: {
        browser: {
          parameters,
          outputSchema: schema,
          validateResult: output.validate,
          toModelOutput: (value: { answer: number }) => ({ safe: value.answer }),
        },
      },
    };
    expect(await runAgent(options)).toMatchObject({
      status: 'suspended',
      pendingClientCalls: [{ toolCallId: 'client1' }],
    });
    expect((await resumeAgent(options)).status).toBe('suspended');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (await resumeAgent({ ...options, clientToolResults: [{ toolCallId: 'wrong', output: {} }] }))
        .status,
    ).toBe('failed');
    const result = await resumeAgent({
      ...options,
      clientToolResults: [{ toolCallId: 'client1', output: { answer: 4, hidden: 'private' } }],
    });
    expect(result).toMatchObject({ status: 'completed', output: 'done' });
    expect(JSON.stringify(requests()[1])).toContain('safe');
    expect(JSON.stringify(requests()[1])).not.toContain('private');
  });

  it('honors input guardrails and canonical preparation while structured finalization disables tools', async () => {
    const blocked = mocked([{ text: 'unused' }]);
    expect(
      await runAgent({
        model: blocked.model,
        prompt: 'x',
        output,
        guardrails: { onInput: () => ({ action: 'block', reason: 'blocked' }) },
      }),
    ).toMatchObject({ status: 'stopped', reason: 'guardrail:input' });
    expect(blocked.fetch).not.toHaveBeenCalled();
    const { model, requests } = mocked([{ text: 'ready' }, { text: '{"answer":2}' }]);
    const prepareStep = vi.fn(() => ({
      messages: [{ role: 'user' as const, content: 'prepared context' }],
      activeTools: [],
    }));
    expect(
      await runAgent({
        model,
        prompt: 'x',
        output,
        prepareStep,
        tools: { unused: { parameters, execute: () => 'unused' } },
      }),
    ).toMatchObject({ status: 'completed' });
    expect(prepareStep).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests()[0])).toContain('prepared context');
    expect(JSON.stringify(requests()[1])).toContain('prepared context');
  });

  it('fails closed on unsupported native options instead of silently ignoring them', async () => {
    const { model, fetch } = mocked([{ text: 'unused' }]);
    const result = await runAgent({ model, prompt: 'x', memory: {} } as unknown as AgentRunOptions);
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('do not yet support') },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
