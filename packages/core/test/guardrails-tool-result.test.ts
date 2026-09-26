import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createMockModel, type MockResponse } from '../src/testing';
import { readConfig } from '../src/internal/config-symbol';
import { createInMemoryAgentRunStore, runAgent } from '../src/agent-run';
import type { Message } from '../src/types/message';
import type { JSONSchema } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import type { ToolResultGuardrail, ToolResultGuardrailContext } from '../src/types/guardrails';
import { maxToolResultLength } from '../src/guardrails';

type GuardrailStreamPart = Extract<StreamPart, { type: 'guardrail' }>;
type ToolResultStreamPart = Extract<StreamPart, { type: 'tool-result' }>;

const USER: Message[] = [{ role: 'user', content: 'hello' }];
const PATH_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

/** A mock model whose wire bodies are recorded, so a test sees what the model was fed. */
function recorded(responses: MockResponse[]) {
  const model = createMockModel({ responses });
  const config = readConfig(model)!;
  const fetch = vi.fn(config.fetch!);
  config.fetch = fetch;
  const bodies = (): string[] => fetch.mock.calls.map(([, init]) => String(init?.body));
  return { model, bodies };
}

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const deuz = (meta: Record<string, unknown> | undefined): Record<string, unknown> =>
  (meta?.deuz ?? {}) as Record<string, unknown>;

function readTool(output: unknown = 'SECRET=hunter2 and the file body') {
  return {
    read: {
      description: 'reads a file',
      parameters: PATH_SCHEMA,
      execute: async (): Promise<unknown> => output,
    },
  };
}

describe('guardrails: onToolResult (generateText)', () => {
  it('a pass (or undefined) is silent and leaves the result untouched', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'done' },
    ]);
    const res = await generateText({
      model,
      messages: USER,
      tools: readTool('plain body'),
      maxSteps: 3,
      guardrails: { onToolResult: [() => undefined, () => ({ action: 'pass' })] },
    });
    expect(res.steps![0]!.toolResults[0]).toMatchObject({ result: 'plain body' });
    expect(bodies()[1]).toContain('plain body');
    expect(deuz(res.providerMetadata).guardrails).toBeUndefined();
  });

  it('a rewrite replaces what the model sees, and is logged', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'done' },
    ]);
    const redact: ToolResultGuardrail = (ctx) =>
      typeof ctx.result === 'string' && ctx.result.includes('SECRET=')
        ? { action: 'rewrite', result: ctx.result.replace(/SECRET=\S+/, 'SECRET=[redacted]') }
        : undefined;
    const res = await generateText({
      model,
      messages: USER,
      tools: readTool(),
      maxSteps: 3,
      guardrails: { onToolResult: redact },
    });
    expect(bodies()[1]).toContain('SECRET=[redacted]');
    expect(bodies()[1]).not.toContain('hunter2');
    expect(res.steps![0]!.toolResults[0]).toMatchObject({
      toolName: 'read',
      result: 'SECRET=[redacted] and the file body',
    });
    expect(res.steps![0]!.toolResults[0]!.isError).toBeUndefined();
    expect(JSON.stringify(res.response?.messages ?? [])).not.toContain('hunter2');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      {
        hook: 'tool-result',
        action: 'rewrite',
        name: 'redact',
        toolCallId: 'call_1',
        stepIndex: 0,
      },
    ]);
  });

  it('a block becomes an is_error result carrying the reason, and the run continues', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'recovered' },
    ]);
    const noSecrets: ToolResultGuardrail = () => ({ action: 'block', reason: 'contains a secret' });
    const res = await generateText({
      model,
      messages: USER,
      tools: readTool(),
      maxSteps: 3,
      guardrails: { onToolResult: noSecrets },
    });
    const result = res.steps![0]!.toolResults[0]!;
    expect(result.isError).toBe(true);
    expect(result.result).toBe("Blocked by guardrail 'noSecrets': contains a secret");
    expect(bodies()[1]).not.toContain('hunter2');
    expect(bodies()[1]).toContain('contains a secret');
    expect(res.text).toBe('recovered');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      {
        hook: 'tool-result',
        action: 'block',
        name: 'noSecrets',
        reason: 'contains a secret',
        toolCallId: 'call_1',
        stepIndex: 0,
      },
    ]);
  });

  it('runs in order, chains rewrites, and the first block short-circuits', async () => {
    const { model } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'done' },
    ]);
    const seen: unknown[] = [];
    const first: ToolResultGuardrail = (ctx) => {
      seen.push(ctx.result);
      return { action: 'rewrite', result: `${String(ctx.result)}+1` };
    };
    const second: ToolResultGuardrail = (ctx) => {
      seen.push(ctx.result);
      return { action: 'block' };
    };
    const third: ToolResultGuardrail = (ctx) => {
      seen.push(ctx.result);
      return undefined;
    };
    const res = await generateText({
      model,
      messages: USER,
      tools: readTool('x'),
      maxSteps: 3,
      guardrails: { onToolResult: [first, second, third] },
    });
    expect(seen).toEqual(['x', 'x+1']);
    expect(res.steps![0]!.toolResults[0]).toMatchObject({
      isError: true,
      result: "Blocked by guardrail 'second'.",
    });
  });

  it('sees the call, the result, the error flag, the history and the runtimeContext', async () => {
    const { model } = recorded([
      {
        toolCalls: [
          { toolName: 'read', args: { path: 'a' } },
          { toolName: 'boom', args: {} },
        ],
      },
      { text: 'done' },
    ]);
    const contexts: ToolResultGuardrailContext[] = [];
    await generateText({
      model,
      messages: USER,
      tools: {
        ...readTool('body'),
        boom: {
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            throw new Error('disk on fire');
          },
        },
      },
      maxSteps: 3,
      runtimeContext: { tenant: 't1' },
      guardrails: {
        onToolResult: (ctx) => {
          contexts.push(ctx);
          return undefined;
        },
      },
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      toolCall: { toolName: 'read', args: { path: 'a' }, toolCallId: 'call_1' },
      result: 'body',
      isError: false,
      runtimeContext: { tenant: 't1' },
      stepIndex: 0,
    });
    expect(contexts[0]!.messages.at(-1)?.role).toBe('assistant');
    expect(contexts[1]).toMatchObject({ toolCall: { toolName: 'boom' }, isError: true });
    expect(String(contexts[1]!.result)).toContain('disk on fire');
  });

  it('never runs for SDK-authored results: denials and unknown tools', async () => {
    const { model } = recorded([
      {
        toolCalls: [
          { toolName: 'read', args: { path: 'a' } },
          { toolName: 'ghost', args: {} },
        ],
      },
      { text: 'done' },
    ]);
    const guard = vi.fn(() => undefined);
    await generateText({
      model,
      messages: USER,
      tools: readTool(),
      maxSteps: 3,
      guardrails: { onToolCall: () => ({ action: 'block', reason: 'no' }), onToolResult: guard },
    });
    expect(guard).not.toHaveBeenCalled();
  });

  it('a throwing guardrail propagates instead of being swallowed', async () => {
    const { model } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'done' },
    ]);
    await expect(
      generateText({
        model,
        messages: USER,
        tools: readTool(),
        maxSteps: 3,
        guardrails: {
          onToolResult: () => {
            throw new Error('guard exploded');
          },
        },
      }),
    ).rejects.toThrow('guard exploded');
  });
});

describe('guardrails: onToolResult (streamChat)', () => {
  it('emits a guardrail part, streams the rewritten output, and logs it on finish', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'done' },
    ]);
    const parts = await collect(
      streamChat({
        model,
        messages: USER,
        tools: readTool(),
        maxSteps: 3,
        guardrails: {
          onToolResult: (ctx) => ({ action: 'rewrite', result: { safe: typeof ctx.result } }),
        },
      }).fullStream,
    );
    const guardrails = parts.filter((p): p is GuardrailStreamPart => p.type === 'guardrail');
    expect(guardrails).toHaveLength(1);
    expect(guardrails[0]).toMatchObject({
      hook: 'tool-result',
      action: 'rewrite',
      toolCallId: 'call_1',
      stepIndex: 0,
    });
    const results = parts.filter((p): p is ToolResultStreamPart => p.type === 'tool-result');
    expect(results[0]).toMatchObject({ output: { safe: 'string' } });
    // the guardrail verdict is announced before the result it acted on
    expect(parts.indexOf(guardrails[0]!)).toBeLessThan(parts.indexOf(results[0]!));
    expect(bodies()[1]).not.toContain('hunter2');
    const finish = parts.find((p) => p.type === 'finish') as
      | { providerMetadata?: Record<string, unknown> }
      | undefined;
    expect(deuz(finish?.providerMetadata).guardrails).toEqual([
      {
        hook: 'tool-result',
        action: 'rewrite',
        name: 'onToolResult',
        toolCallId: 'call_1',
        stepIndex: 0,
      },
    ]);
  });

  it('a block streams as an error result', async () => {
    const { model } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'recovered' },
    ]);
    const parts = await collect(
      streamChat({
        model,
        messages: USER,
        tools: readTool(),
        maxSteps: 3,
        guardrails: { onToolResult: () => ({ action: 'block', reason: 'nope' }) },
      }).fullStream,
    );
    const results = parts.filter((p): p is ToolResultStreamPart => p.type === 'tool-result');
    expect(results[0]).toMatchObject({ isError: true });
    expect(String(results[0]!.output)).toContain('nope');
  });
});

describe('guardrails: onToolResult (native runAgent)', () => {
  it('acts on the model-facing projection while the raw result stays in the receipt', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'finished' },
    ]);
    const store = createInMemoryAgentRunStore();
    const seen: unknown[] = [];
    const result = await runAgent({
      model,
      prompt: 'look it up',
      session: { store, runId: 'guarded', scope: 'tenant' },
      tools: {
        lookup: {
          parameters: { type: 'object', properties: {} },
          execute: () => ({ answer: 7, token: 'raw-secret' }),
          toModelOutput: (value: { answer: number; token: string }) => ({
            answer: value.answer,
            note: `token ${value.token}`,
          }),
        },
      },
      guardrails: {
        onToolResult: (ctx) => {
          seen.push(ctx.result);
          return { action: 'rewrite', result: { answer: 7 } };
        },
      },
    });
    expect(result).toMatchObject({ status: 'completed' });
    // the guardrail saw the projection, not the raw value
    expect(seen).toEqual([{ answer: 7, note: 'token raw-secret' }]);
    // the model was fed the rewrite
    expect(bodies()[1]).not.toContain('raw-secret');
    expect(bodies()[1]).toContain('"answer\\":7');
    // the receipt keeps the raw result and the projection the tool produced
    const receipts = Object.values((await store.load('guarded'))!.toolResults!);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      stage: 'completed',
      rawResult: { answer: 7, token: 'raw-secret' },
      modelOutput: { answer: 7, note: 'token raw-secret' },
    });
  });

  it('a block reaches the native model as an error result', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'lookup', id: 'l1', args: {} }] },
      { text: 'finished' },
    ]);
    const result = await runAgent({
      model,
      prompt: 'look it up',
      tools: {
        lookup: {
          parameters: { type: 'object', properties: {} },
          execute: () => 'raw-secret',
        },
      },
      guardrails: { onToolResult: () => ({ action: 'block', reason: 'untrusted' }) },
    });
    expect(result).toMatchObject({ status: 'completed' });
    expect(bodies()[1]).not.toContain('raw-secret');
    expect(bodies()[1]).toContain('untrusted');
  });
});

describe('maxToolResultLength (built-in onToolResult guardrail)', () => {
  const ctx = (result: unknown): ToolResultGuardrailContext => ({
    toolCall: { toolCallId: 'c', toolName: 'read', args: {} },
    result,
    isError: false,
    messages: USER,
  });

  it('passes results within the cap and names itself', async () => {
    const guard = maxToolResultLength(10);
    expect(guard.name).toBe('maxToolResultLength');
    expect(await guard(ctx('short'))).toEqual({ action: 'pass' });
    expect(await guard(ctx({ a: 1 }))).toEqual({ action: 'pass' });
  });

  it('truncates an over-long string with a notice the model can read', async () => {
    expect(await maxToolResultLength(5)(ctx('abcdefghij'))).toEqual({
      action: 'rewrite',
      result: 'abcde\n[truncated: 5 of 10 characters shown]',
    });
  });

  it('measures and truncates non-string results by their JSON text', async () => {
    const verdict = await maxToolResultLength(8)(ctx({ body: 'x'.repeat(20) }));
    expect(verdict).toEqual({
      action: 'rewrite',
      result: '{"body":\n[truncated: 8 of 31 characters shown]',
    });
  });

  it("mode 'block' refuses instead, and a bad cap clamps to 0", async () => {
    expect(await maxToolResultLength(3, { mode: 'block' })(ctx('abcd'))).toEqual({
      action: 'block',
      reason: 'Tool result exceeded 3 characters (4).',
    });
    expect(await maxToolResultLength(Number.NaN)(ctx('a'))).toMatchObject({ action: 'rewrite' });
  });

  it('works end to end in generateText', async () => {
    const { model, bodies } = recorded([
      { toolCalls: [{ toolName: 'read', args: { path: 'a' } }] },
      { text: 'done' },
    ]);
    await generateText({
      model,
      messages: USER,
      tools: readTool('y'.repeat(100)),
      maxSteps: 3,
      guardrails: { onToolResult: maxToolResultLength(10) },
    });
    expect(bodies()[1]).toContain('[truncated: 10 of 100 characters shown]');
    expect(bodies()[1]).not.toContain('y'.repeat(11));
  });
});
