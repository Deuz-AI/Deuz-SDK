import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../src/agent';
import type { AgentDef } from '../src/agent';
import { createMockModel } from '../src/testing';
import { createAnthropic } from '../src/anthropic';
import { stepCountIs } from '../src/index';
import type { StreamPart } from '../src/types/stream';
import type { JSONSchema } from '../src/types/schema';
import type { Message } from '../src/types/message';
import type { Usage } from '../src/types/usage';
import type { UsageMeta } from '../src/types/deps';
import type { ToolExecuteContext } from '../src/types/tool';

const PING_SCHEMA: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };

const CITY_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

describe('createAgent — the def as a value', () => {
  it('runs a def-only call (no per-call options beyond the input)', async () => {
    const agent = createAgent({
      name: 'support',
      model: createMockModel({ responses: [{ text: 'answer from the def' }] }),
      instructions: 'Be terse.',
      temperature: 0,
    });
    const res = await agent.generateText({ prompt: 'hi' });
    expect(res.text).toBe('answer from the def');
    expect(agent.def.name).toBe('support');
  });

  it('is a frozen plain object, not a class instance', () => {
    const agent = createAgent({ model: createMockModel({ responses: [] }) });
    expect(Object.isFrozen(agent)).toBe(true);
    // A plain object literal: its prototype is Object.prototype, so there is no
    // class/prototype chain to inherit from (the whole point of 4.1).
    expect(Object.getPrototypeOf(agent)).toBe(Object.prototype);
    expect(typeof agent.generateText).toBe('function');
    expect(typeof agent.streamChat).toBe('function');
    expect(typeof agent.asTool).toBe('function');
    expect(typeof agent.with).toBe('function');
  });

  it('per-call options override the def (model + maxSteps)', async () => {
    const defModel = createMockModel({ responses: [{ text: 'from the def model' }] });
    const callModel = createMockModel({ responses: [{ text: 'from the call model' }] });
    const agent = createAgent({ model: defModel, maxSteps: 1 });

    const overridden = await agent.generateText({ prompt: 'x', model: callModel });
    expect(overridden.text).toBe('from the call model');
    // The def is untouched by the override.
    expect(agent.def.model).toBe(defModel);
    expect((await agent.generateText({ prompt: 'x' })).text).toBe('from the def model');

    // maxSteps: def 1 vs. per-call 3, against a model that always calls a tool.
    const ping = vi.fn(async () => 'pong');
    const looper = createAgent({
      model: createMockModel({ responses: [{ toolCalls: [{ toolName: 'ping', args: {} }] }] }),
      tools: { ping: { parameters: PING_SCHEMA, execute: ping } },
      maxSteps: 1,
    });
    const capped = await looper.generateText({ prompt: 'go' });
    expect(capped.steps).toHaveLength(1);
    expect(ping).toHaveBeenCalledTimes(1);

    ping.mockClear();
    const raised = await looper.generateText({ prompt: 'go', maxSteps: 3 });
    expect(raised.steps).toHaveLength(3);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('replaces (never merges) tools / deps / stopWhen — the documented rule', async () => {
    const defTool = vi.fn(async () => 'def');
    const callTool = vi.fn(async () => 'call');
    const agent = createAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'callOnly', args: {} }] }, { text: 'done' }],
      }),
      tools: { defOnly: { parameters: PING_SCHEMA, execute: defTool } },
      maxSteps: 3,
    });
    // Per-call `tools` REPLACES the def's set wholesale: `defOnly` is gone, so
    // only `callOnly` is callable this turn.
    const res = await agent.generateText({
      prompt: 'go',
      tools: { callOnly: { parameters: PING_SCHEMA, execute: callTool } },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(defTool).not.toHaveBeenCalled();
    expect(res.text).toBe('done');

    // And an explicitly-undefined per-call value UNSETS the def's field: a
    // tool-less one-off from an agentic agent.
    const single = await agent.generateText({
      prompt: 'go',
      tools: undefined,
      maxSteps: undefined,
    });
    expect(single.steps ?? []).toHaveLength(0); // single-turn, never entered the loop
  });

  it('freezes a COPY of the def: neither the def nor the caller object can change behaviour', async () => {
    const ping = vi.fn(async () => 'pong');
    const input: AgentDef = {
      model: createMockModel({ responses: [{ toolCalls: [{ toolName: 'ping', args: {} }] }] }),
      tools: { ping: { parameters: PING_SCHEMA, execute: ping } },
      maxSteps: 2,
    };
    const agent = createAgent(input);
    expect(Object.isFrozen(agent.def)).toBe(true);
    // The caller's own object is NOT frozen (freezing an argument would be a
    // surprising side effect) — but the agent kept a copy.
    expect(Object.isFrozen(input)).toBe(false);

    // Mutating the frozen def throws in strict mode; either way it must not take.
    try {
      (agent.def as { maxSteps?: number }).maxSteps = 99;
    } catch {
      /* strict-mode TypeError — the assertion below is the real contract */
    }
    // Mutating the ORIGINAL def object afterwards must not leak in either.
    input.maxSteps = 99;

    expect(agent.def.maxSteps).toBe(2);
    const res = await agent.generateText({ prompt: 'go' });
    expect(res.steps).toHaveLength(2); // still the def's 2, not 99
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe('createAgent — with()', () => {
  it('returns a NEW frozen agent and leaves the original untouched', async () => {
    const baseModel = createMockModel({ responses: [{ text: 'base model' }] });
    const variantModel = createMockModel({ responses: [{ text: 'variant model' }] });
    const base = createAgent({
      name: 'base',
      model: baseModel,
      instructions: 'shared',
      maxSteps: 4,
    });
    const variant = base.with({ name: 'variant', model: variantModel, temperature: 0.9 });

    expect(variant).not.toBe(base);
    expect(Object.isFrozen(variant)).toBe(true);
    expect(Object.isFrozen(variant.def)).toBe(true);
    // Overridden…
    expect(variant.def.name).toBe('variant');
    expect(variant.def.model).toBe(variantModel);
    expect(variant.def.temperature).toBe(0.9);
    // …inherited…
    expect(variant.def.instructions).toBe('shared');
    expect(variant.def.maxSteps).toBe(4);
    // …and the original is byte-for-byte what it was.
    expect(base.def.name).toBe('base');
    expect(base.def.model).toBe(baseModel);
    expect(base.def.temperature).toBeUndefined();

    expect((await base.generateText({ prompt: 'x' })).text).toBe('base model');
    expect((await variant.generateText({ prompt: 'x' })).text).toBe('variant model');
  });

  it('chains, and its own with() does not disturb its parent', () => {
    const model = createMockModel({ responses: [] });
    const a = createAgent({ model, maxSteps: 2 });
    const b = a.with({ maxSteps: 5 });
    const c = b.with({ maxSteps: 9, instructions: 'deep' });
    expect([a.def.maxSteps, b.def.maxSteps, c.def.maxSteps]).toEqual([2, 5, 9]);
    expect(b.def.instructions).toBeUndefined();
    expect(c.def.instructions).toBe('deep');
  });
});

describe('createAgent — G2: streamChat returns synchronously and never throws', () => {
  it('returns the result object before any await, with a lazy pump', async () => {
    let fetches = 0;
    const fetch = (async () => {
      fetches += 1;
      throw new TypeError('connect failed');
    }) as typeof globalThis.fetch;
    const agent = createAgent({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      maxRetries: 0,
    });

    const res = agent.streamChat({ prompt: 'hi' });
    // SYNCHRONOUS: a full StreamChatResult, not a promise, and nothing dialed yet.
    expect(res).not.toBeInstanceOf(Promise);
    expect(typeof res.fullStream[Symbol.asyncIterator]).toBe('function');
    expect(typeof res.textStream[Symbol.asyncIterator]).toBe('function');
    expect(fetches).toBe(0);

    const usage = res.usage.catch((error: unknown) => error);
    const errors: unknown[] = [];
    for await (const part of res.fullStream) {
      if (part.type === 'error') errors.push(part.error);
    }
    expect(fetches).toBe(1); // the pump started on first pull, not on the call
    expect(errors).toHaveLength(1);
    expect(await usage).toBe(errors[0]);
  });

  it('reports an invalid input shape as an error part, not a synchronous throw', async () => {
    const agent = createAgent({ model: createMockModel({ responses: [{ text: 'never' }] }) });

    // No input at all: the def cannot carry `messages`/`prompt` by design.
    const res = agent.streamChat();
    expect(res).not.toBeInstanceOf(Promise);
    const parts: StreamPart[] = [];
    for await (const part of res.fullStream) parts.push(part);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('error');
    await expect(res.usage).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(res.finishReason).rejects.toThrow(/no input/);

    // prompt + messages together: same never-throw path.
    const both = agent.streamChat({
      prompt: 'hi',
      messages: [{ role: 'user', content: 'yo' }],
    });
    const bothParts: StreamPart[] = [];
    for await (const part of both.fullStream) bothParts.push(part);
    expect(bothParts.map((p) => p.type)).toEqual(['error']);
    await expect(both.usage).rejects.toThrow(/EITHER/);
  });

  it('streams a normal run through to finish', async () => {
    const agent = createAgent({
      model: createMockModel({ responses: [{ text: 'Hello world' }] }),
      instructions: 'Be terse.',
    });
    const res = agent.streamChat({ prompt: 'hi' });
    let text = '';
    for await (const chunk of res.textStream) text += chunk;
    expect(text).toBe('Hello world');
    expect(await res.finishReason).toBe('stop');
  });
});

describe('createAgent — prompt / instructions (Sprint 2 parity)', () => {
  it('accepts `prompt` and folds the def `instructions` in as the system turn', async () => {
    let seen: Message[] = [];
    const agent = createAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'peek', args: {} }] }, { text: 'ok' }],
      }),
      instructions: 'You are terse.',
      // A tool is the cheapest window onto the canonical history the loop built.
      tools: {
        peek: {
          parameters: PING_SCHEMA,
          execute: async (_args: unknown, ctx: ToolExecuteContext) => {
            seen = ctx.messages;
            return 'peeked';
          },
        },
      },
      maxSteps: 3,
    });
    const res = await agent.generateText({ prompt: 'hi there' });
    expect(res.text).toBe('ok');
    expect(seen[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(seen[1]).toEqual({ role: 'user', content: 'hi there' });
  });

  it('rejects prompt + messages exactly like the free function', async () => {
    const agent = createAgent({ model: createMockModel({ responses: [{ text: 'never' }] }) });
    await expect(
      agent.generateText({ prompt: 'hi', messages: [{ role: 'user', content: 'yo' }] }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // The free function's own wording — the guard lives in src/generate.ts only.
    await expect(
      agent.generateText({ prompt: 'hi', messages: [{ role: 'user', content: 'yo' }] }),
    ).rejects.toThrow(/generateText: pass EITHER/);
  });

  it('takes `messages` per call, and a per-call `instructions` replaces the def one', async () => {
    let seen: Message[] = [];
    const agent = createAgent({
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'peek', args: {} }] }, { text: 'ok' }],
      }),
      instructions: 'def system',
      tools: {
        peek: {
          parameters: PING_SCHEMA,
          execute: async (_args: unknown, ctx: ToolExecuteContext) => {
            seen = ctx.messages;
            return 'peeked';
          },
        },
      },
      maxSteps: 3,
    });
    await agent.generateText({
      messages: [{ role: 'user', content: 'turn one' }],
      instructions: 'call system',
    });
    expect(seen[0]).toEqual({ role: 'system', content: 'call system' });
    expect(seen[1]).toEqual({ role: 'user', content: 'turn one' });
  });
});

describe('createAgent — def fields reach the loop', () => {
  it('def `tools` + `maxSteps` drive the real loop', async () => {
    const lookup = vi.fn(async (args: unknown) => ({ id: (args as { id: string }).id, ok: true }));
    const agent = createAgent({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'lookupOrder', args: { id: '12' } }] },
          { text: 'order 12 shipped' },
        ],
      }),
      tools: {
        lookupOrder: {
          description: 'Look an order up',
          parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          execute: lookup,
        },
      },
      maxSteps: 5,
    });
    const res = await agent.generateText({ prompt: 'where is order 12?' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![0]).toEqual({ id: '12' }); // args parsed off the wire
    expect(res.steps).toHaveLength(2);
    expect(res.text).toBe('order 12 shipped');
  });

  it('def `stopWhen` bounds the loop and is named in providerMetadata', async () => {
    const ping = vi.fn(async () => 'pong');
    const agent = createAgent({
      model: createMockModel({ responses: [{ toolCalls: [{ toolName: 'ping', args: {} }] }] }),
      tools: { ping: { parameters: PING_SCHEMA, execute: ping } },
      maxSteps: 10,
      stopWhen: stepCountIs(2),
    });
    const res = await agent.generateText({ prompt: 'go' });
    expect(res.steps).toHaveLength(2);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(res.providerMetadata?.deuz).toMatchObject({ stoppedBy: 'stepCountIs' });
  });

  it('def `verifyStep` re-drives the loop and marks the verdict', async () => {
    const attempts: number[] = [];
    const agent = createAgent({
      model: createMockModel({ responses: [{ text: 'draft' }, { text: 'final answer' }] }),
      verifyStep: (ctx) => {
        attempts.push(ctx.attempt);
        return ctx.attempt === 0 ? { ok: false, feedback: 'be more precise' } : { ok: true };
      },
    });
    const res = await agent.generateText({ prompt: 'answer me' });
    expect(attempts).toEqual([0, 1]);
    expect(res.text).toBe('final answer');
    expect(res.providerMetadata?.deuz?.verified).toBe(true);
    expect(
      res.response.messages.some((m) => m.role === 'user' && m.content === 'be more precise'),
    ).toBe(true);
  });
});

describe('createAgent — structured output', () => {
  it('generateObject works from a def with no loop options', async () => {
    const agent = createAgent({
      model: createMockModel({ responses: [{ text: '{"city":"Paris"}' }] }),
      instructions: 'Answer as JSON.',
    });
    const res = await agent.generateObject<{ city: string }>({
      schema: CITY_SCHEMA,
      mode: 'json',
      prompt: 'capital of France?',
    });
    expect(res.object).toEqual({ city: 'Paris' });
  });

  it('an agentic def is REFUSED (Sprint 1 guard), and unsetting the fields is the fix', async () => {
    const agent = createAgent({
      model: createMockModel({ responses: [{ text: '{"city":"Paris"}' }] }),
      tools: { ping: { parameters: PING_SCHEMA, execute: async () => 'pong' } },
      maxSteps: 5,
    });
    // The def's loop options are real requests, so the object call refuses them
    // loudly instead of dropping them in silence.
    await expect(
      agent.generateObject({ schema: CITY_SCHEMA, mode: 'json', prompt: 'capital of France?' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    // The documented escape — the merge rule's own `undefined` = unset.
    const res = await agent.generateObject<{ city: string }>({
      schema: CITY_SCHEMA,
      mode: 'json',
      prompt: 'capital of France?',
      tools: undefined,
      maxSteps: undefined,
    });
    expect(res.object).toEqual({ city: 'Paris' });

    // …or once, up front, as a variant.
    const extractor = agent.with({ tools: undefined, maxSteps: undefined });
    const viaVariant = await extractor.generateObject<{ city: string }>({
      schema: CITY_SCHEMA,
      mode: 'json',
      prompt: 'capital of France?',
    });
    expect(viaVariant.object).toEqual({ city: 'Paris' });
  });

  it('streamObject returns synchronously (G2)', async () => {
    const agent = createAgent({
      model: createMockModel({ responses: [{ text: '{"city":"Paris"}' }] }),
    });
    const res = agent.streamObject<{ city: string }>({
      schema: CITY_SCHEMA,
      mode: 'json',
      prompt: 'capital of France?',
    });
    expect(res).not.toBeInstanceOf(Promise);
    expect(typeof res.partialObjectStream[Symbol.asyncIterator]).toBe('function');
    expect(await res.object).toEqual({ city: 'Paris' });
  });
});

describe('createAgent — asTool (delegates to agentTool)', () => {
  it('runs as a sub-agent inside a parent loop with usage folded into the parent', async () => {
    const helper = createAgent({
      name: 'helper',
      model: createMockModel({ responses: [{ text: 'sub answer' }] }),
      instructions: 'You are the helper.',
    });
    const parent = createAgent({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'helper', args: { prompt: 'summarise X' } }] },
          { text: 'final' },
        ],
      }),
      tools: { helper: helper.asTool({ description: 'Delegates research' }) },
      maxSteps: 5,
    });

    const tagged: string[][] = [];
    const onUsage = (_u: Usage, m: UsageMeta) => {
      if (m.agentPath) tagged.push(m.agentPath);
    };
    const res = await parent.generateText({ prompt: 'go', onUsage });

    expect(res.text).toBe('final');
    // The sub-agent's answer came back as the parent's tool result.
    expect(res.steps![0]!.toolResults[0]).toMatchObject({
      toolName: 'helper',
      result: 'sub answer',
    });
    // Usage folded: parent step 0 (15) + sub-agent (15) + parent step 1 (15).
    expect(res.usage.totalTokens).toBe(45);
    // …and the def's `name` became the sub-agent's agentPath segment.
    expect(tagged).toContainEqual(['helper']);
  });

  it('names and describes the tool from the def, with per-call overrides', () => {
    const named = createAgent({ name: 'researcher', model: createMockModel({ responses: [] }) });
    const fromDef = named.asTool();
    expect(fromDef.description).toContain('researcher');
    expect(fromDef.parameters).toMatchObject({ required: ['prompt'] }); // agentTool's schema
    expect(typeof fromDef.execute).toBe('function');

    const overridden = named.asTool({ name: 'scout', description: 'Scouts ahead' });
    expect(overridden.description).toBe('Scouts ahead');

    // A nameless def still produces a usable tool.
    const anonymous = createAgent({ model: createMockModel({ responses: [] }) }).asTool();
    expect(anonymous.description).toContain('agent');
  });

  it('forwards the def tools/instructions/maxSteps into the sub-agent loop', async () => {
    const probe = vi.fn(async () => 'probed');
    let seen: Message[] = [];
    const helper = createAgent({
      name: 'helper',
      model: createMockModel({
        responses: [{ toolCalls: [{ toolName: 'probe', args: {} }] }, { text: 'helper done' }],
      }),
      instructions: 'You are the helper.',
      tools: {
        probe: {
          parameters: PING_SCHEMA,
          execute: async (_args: unknown, ctx: ToolExecuteContext) => {
            seen = ctx.messages;
            return probe();
          },
        },
      },
      maxSteps: 4,
    });
    const parent = createAgent({
      model: createMockModel({
        responses: [
          { toolCalls: [{ toolName: 'helper', args: { prompt: 'dig' } }] },
          { text: 'final' },
        ],
      }),
      tools: { helper: helper.asTool() },
      maxSteps: 5,
    });

    const res = await parent.generateText({ prompt: 'go' });
    expect(res.text).toBe('final');
    expect(probe).toHaveBeenCalledTimes(1); // the def's own tool ran, one level down
    expect(res.steps![0]!.toolResults[0]!.result).toBe('helper done');
    // `instructions` became the sub-agent's `system`, and the sub-agent saw the
    // prompt the parent model chose.
    expect(seen[0]).toEqual({ role: 'system', content: 'You are the helper.' });
    expect(seen[1]).toEqual({ role: 'user', content: 'dig' });
  });
});
