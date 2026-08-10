import { describe, it, expect } from 'vitest';
import { generateText, streamChat } from '../src/index';
import { createMockModel, type MockResponse } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { createInMemorySessionStore } from '../src/durable';
import { createInMemoryChatStore } from '../src/chat';
import {
  promptInjectionGuardrail,
  maxOutputLength,
  PROMPT_INJECTION_POLICY,
} from '../src/guardrails';
import type { LanguageModel } from '../src/types/model';
import type { Message, Part } from '../src/types/message';
import type { JSONSchema } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import type { InputGuardrail, OutputGuardrail, ToolCallGuardrail } from '../src/types/guardrails';

type GuardrailStreamPart = Extract<StreamPart, { type: 'guardrail' }>;
type ToolStatePart = Extract<StreamPart, { type: 'tool-state' }>;
type FinishPart = Extract<StreamPart, { type: 'finish' }>;

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/**
 * A {@link createMockModel} whose factory `fetch` is wrapped so a test can prove
 * how many model calls actually happened (an input guardrail that blocks must
 * produce ZERO) and inspect the wire body a rewrite produced.
 */
function countingModel(responses: MockResponse[]): {
  model: LanguageModel;
  calls: () => number;
  bodies: Record<string, unknown>[];
} {
  const base = createMockModel({ responses });
  const config = readConfig(base)!;
  const inner = config.fetch!;
  let n = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    n += 1;
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return inner(input, init);
  }) as typeof fetch;
  const model = attachConfig(
    { provider: 'mock', modelId: 'mock-model', surface: 'chat_completions' },
    { ...config, fetch: fetchImpl },
  );
  return { model, calls: () => n, bodies };
}

const PATH_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

const USER: Message[] = [{ role: 'user', content: 'hello' }];

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function toolUseOf(messages: Message[]): Extract<Part, { type: 'tool_use' }> | undefined {
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const part = m.content.find((p) => p.type === 'tool_use');
    if (part) return part;
  }
  return undefined;
}

/** Read `providerMetadata.deuz` off either a result or a `finish` part. */
const deuz = (meta: Record<string, unknown> | undefined): Record<string, unknown> =>
  (meta?.deuz ?? {}) as Record<string, unknown>;

// ===================================================================
// onInput — ordering, chaining, short-circuit
// ===================================================================

describe('guardrails: onInput', () => {
  it('runs in array order, chains rewrites, and stays silent on a pass', async () => {
    const seen: number[] = [];
    const prefixer: InputGuardrail = (ctx) => {
      seen.push(ctx.messages.length);
      return {
        action: 'rewrite',
        messages: [{ role: 'system', content: 'POLICY' }, ...ctx.messages],
      };
    };
    const observer: InputGuardrail = (ctx) => {
      seen.push(ctx.messages.length);
      return undefined; // pass — emits nothing at all
    };
    const { model, calls, bodies } = countingModel([{ text: 'ok' }]);

    const res = await generateText({
      model,
      messages: USER,
      guardrails: { onInput: [prefixer, observer] },
    });

    // The second guardrail saw the FIRST one's rewrite (1 message → 2).
    expect(seen).toEqual([1, 2]);
    expect(calls()).toBe(1);
    // The rewritten history is what actually reached the provider.
    expect(JSON.stringify(bodies[0])).toContain('POLICY');
    // A silent pass contributes no entry.
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      { hook: 'input', action: 'rewrite', name: 'prefixer' },
    ]);
  });

  it('short-circuits on the first block: no later guardrail, no model call', async () => {
    const order: string[] = [];
    const refuse: InputGuardrail = () => {
      order.push('refuse');
      return { action: 'block', reason: 'off-policy request' };
    };
    const never: InputGuardrail = () => {
      order.push('never');
      return { action: 'rewrite', messages: [] };
    };
    const { model, calls } = countingModel([{ text: 'must not be produced' }]);

    const res = await generateText({
      model,
      messages: USER,
      guardrails: { onInput: [refuse, never] },
    });

    expect(order).toEqual(['refuse']);
    expect(calls()).toBe(0);
    // A graceful stop — never a throw.
    expect(res.text).toBe('');
    expect(res.finishReason).toBe('stop');
    expect(res.steps).toHaveLength(0);
    expect(res.response.messages).toEqual([]);
    expect(res.usage.totalTokens).toBe(0);
    expect(deuz(res.providerMetadata).stoppedBy).toBe('guardrail:input');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      { hook: 'input', action: 'block', name: 'refuse', reason: 'off-policy request' },
    ]);
  });

  it('streaming: emits the guardrail part, then finish — and no step at all', async () => {
    const { model, calls } = countingModel([{ text: 'must not be produced' }]);
    const result = streamChat({
      model,
      messages: USER,
      guardrails: { onInput: () => ({ action: 'block', reason: 'off-policy request' }) },
    });

    const parts = await collect(result.fullStream);
    expect(parts.map((p) => p.type)).toEqual(['guardrail', 'finish']);
    expect(parts[0]).toMatchObject({
      type: 'guardrail',
      hook: 'input',
      action: 'block',
      reason: 'off-policy request',
    });
    const finish = parts[1] as FinishPart;
    expect(deuz(finish.providerMetadata).stoppedBy).toBe('guardrail:input');
    expect(deuz(finish.providerMetadata).guardrails).toHaveLength(1);
    expect(calls()).toBe(0);
    await expect(result.finishReason).resolves.toBe('stop');
    await expect(result.usage).resolves.toMatchObject({ totalTokens: 0 });
  });

  it('durable: a blocked run writes a COMPLETED checkpoint (nothing to resume)', async () => {
    const store = createInMemorySessionStore();
    const { model } = countingModel([{ text: 'x' }]);
    await generateText({
      model,
      messages: USER,
      session: { store, runId: 'blocked-run' },
      guardrails: { onInput: () => ({ action: 'block' }) },
    });
    const checkpoint = await store.load('blocked-run');
    expect(checkpoint?.status).toBe('completed');
    expect(checkpoint?.pendingApprovals).toBeUndefined();
  });

  it('a throwing guardrail propagates (buffered rejects, stream errors)', async () => {
    const { model } = countingModel([{ text: 'x' }]);
    const boom: InputGuardrail = () => {
      throw new Error('guardrail exploded');
    };
    await expect(
      generateText({ model, messages: USER, guardrails: { onInput: boom } }),
    ).rejects.toThrow('guardrail exploded');

    const result = streamChat({ model, messages: USER, guardrails: { onInput: boom } });
    const parts = await collect(result.fullStream);
    expect(parts.at(-1)).toMatchObject({ type: 'error' });
    await expect(result.usage).rejects.toThrow('guardrail exploded');
    await expect(result.finishReason).rejects.toThrow('guardrail exploded');
  });
});

// ===================================================================
// onToolCall — joins the denial machinery / rewrites execution args
// ===================================================================

describe('guardrails: onToolCall', () => {
  const toolSet = (record: (args: unknown) => void) => ({
    danger: {
      description: 'deletes a path',
      parameters: PATH_SCHEMA,
      execute: async (args: unknown): Promise<string> => {
        record(args);
        return 'deleted';
      },
    },
  });

  it('a block never executes, self-heals as an is_error result, and the loop continues', async () => {
    const ran: unknown[] = [];
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'danger', args: { path: '/etc' } }] },
        { text: 'recovered' },
      ],
    });
    const noDelete: ToolCallGuardrail = (ctx) =>
      ctx.toolCall.toolName === 'danger' ? { action: 'block', reason: 'destructive' } : undefined;

    const res = await generateText({
      model,
      messages: USER,
      tools: toolSet((a) => ran.push(a)),
      maxSteps: 5,
      guardrails: { onToolCall: noDelete },
    });

    expect(ran).toEqual([]); // never executed
    const first = res.steps![0]!;
    expect(first.toolResults[0]).toMatchObject({ toolName: 'danger', isError: true });
    expect(String(first.toolResults[0]!.result)).toContain(
      "Blocked by guardrail 'noDelete': destructive",
    );
    // The run KEEPS GOING — a blocked call is a verdict, not a run-killer.
    expect(res.text).toBe('recovered');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      {
        hook: 'tool-call',
        action: 'block',
        name: 'noDelete',
        reason: 'destructive',
        toolCallId: 'call_1',
        stepIndex: 0,
      },
    ]);
  });

  it('blocks do NOT count toward the runaway-tool-error guard', async () => {
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'danger', args: { path: '/a' } }] },
        { toolCalls: [{ toolName: 'danger', args: { path: '/b' } }] },
        { toolCalls: [{ toolName: 'danger', args: { path: '/c' } }] },
        { text: 'gave up on the tool' },
      ],
    });
    const res = await generateText({
      model,
      messages: USER,
      tools: toolSet(() => {}),
      maxSteps: 10,
      guardrails: { onToolCall: () => ({ action: 'block', reason: 'no' }) },
    });
    // MAX_SAME_TOOL_ERRORS is 3: had the blocks been counted the loop would have
    // hard-stopped after the third and never produced the final text.
    expect(res.steps).toHaveLength(4);
    expect(res.text).toBe('gave up on the tool');
  });

  it('streaming: a blocked call reports tool-state denied and never goes executing', async () => {
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'danger', args: { path: '/etc' } }] },
        { text: 'recovered' },
      ],
    });
    const parts = await collect(
      streamChat({
        model,
        messages: USER,
        tools: toolSet(() => {}),
        maxSteps: 5,
        guardrails: { onToolCall: () => ({ action: 'block', reason: 'destructive' }) },
      }).fullStream,
    );

    const states = parts.filter((p): p is ToolStatePart => p.type === 'tool-state');
    expect(states.map((p) => p.state)).toEqual(['input-streaming', 'input-complete', 'error']);
    expect(states.at(-1)).toMatchObject({ denied: true });
    expect(states.at(-1)!.deniedReason).toContain('Blocked by guardrail');

    const guardrails = parts.filter((p): p is GuardrailStreamPart => p.type === 'guardrail');
    expect(guardrails).toHaveLength(1);
    expect(guardrails[0]).toMatchObject({
      hook: 'tool-call',
      action: 'block',
      toolCallId: 'call_1',
      stepIndex: 0,
    });
  });

  it('a rewrite substitutes the EXECUTED args while history keeps the model’s own', async () => {
    const ran: unknown[] = [];
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'danger', args: { path: '/etc' } }] },
        { text: 'done' },
      ],
    });
    const confine: ToolCallGuardrail = (ctx) => {
      const args = ctx.toolCall.args as { path: string };
      return args.path.startsWith('/')
        ? { action: 'rewrite', args: { path: `.${args.path}` } }
        : undefined;
    };
    const suffix: ToolCallGuardrail = (ctx) => {
      const args = ctx.toolCall.args as { path: string };
      return { action: 'rewrite', args: { path: `${args.path}/scoped` } };
    };

    const res = await generateText({
      model,
      messages: USER,
      tools: toolSet((a) => ran.push(a)),
      maxSteps: 5,
      guardrails: { onToolCall: [confine, suffix] },
    });

    // Rewrites CHAIN: the second saw the first one's output.
    expect(ran).toEqual([{ path: './etc/scoped' }]);
    // …but the assistant turn in the history still says what the MODEL asked for.
    expect(toolUseOf(res.response.messages)?.input).toEqual({ path: '/etc' });
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      { hook: 'tool-call', action: 'rewrite', name: 'confine', toolCallId: 'call_1', stepIndex: 0 },
      { hook: 'tool-call', action: 'rewrite', name: 'suffix', toolCallId: 'call_1', stepIndex: 0 },
    ]);
  });

  it('a rewrite is what the approval gate and the approval request see', async () => {
    const model = createMockModel({
      responses: [
        { toolCalls: [{ toolName: 'danger', args: { path: '/etc' } }] },
        { text: 'done' },
      ],
    });
    const approved: unknown[] = [];
    const res = await generateText({
      model,
      messages: USER,
      tools: {
        danger: {
          description: 'deletes a path',
          parameters: PATH_SCHEMA,
          needsApproval: true,
          execute: async (): Promise<string> => 'deleted',
        },
      },
      maxSteps: 5,
      approveToolCall: (call) => {
        approved.push(call.args);
        return true;
      },
      guardrails: { onToolCall: () => ({ action: 'rewrite', args: { path: './safe' } }) },
    });
    expect(approved).toEqual([{ path: './safe' }]);
    expect(res.text).toBe('done');
  });

  it('a throwing tool-call guardrail propagates', async () => {
    const model = createMockModel({
      responses: [{ toolCalls: [{ toolName: 'danger', args: { path: '/etc' } }] }],
    });
    await expect(
      generateText({
        model,
        messages: USER,
        tools: toolSet(() => {}),
        maxSteps: 5,
        guardrails: {
          onToolCall: () => {
            throw new Error('tool guardrail exploded');
          },
        },
      }),
    ).rejects.toThrow('tool guardrail exploded');
  });
});

// ===================================================================
// onOutput — after doneWhen + verifyStep, rewrites everything downstream
// ===================================================================

describe('guardrails: onOutput', () => {
  it('runs only after doneWhen AND verifyStep have both accepted', async () => {
    const order: string[] = [];
    const model = createMockModel({ responses: [{ text: 'draft' }, { text: 'final' }] });
    await generateText({
      model,
      messages: USER,
      doneWhen: (ctx) => {
        order.push(`done:${ctx.text}`);
        return ctx.text === 'final';
      },
      verifyStep: (ctx) => {
        order.push(`verify:${ctx.text}`);
        return { ok: true };
      },
      guardrails: {
        onOutput: (ctx) => {
          order.push(`output:${ctx.text}`);
          return undefined;
        },
      },
    });
    // The re-driven round short-circuits verification AND the output hook: only
    // the answer the run is actually about to return is inspected.
    expect(order).toEqual(['done:draft', 'done:final', 'verify:final', 'output:final']);
  });

  it('a rewrite patches the result text, the appended turn and the chat record', async () => {
    const chat = createInMemoryChatStore();
    const model = createMockModel({ responses: [{ text: 'my key is sk-live-42' }] });
    const redact: OutputGuardrail = (ctx) => ({
      action: 'rewrite',
      text: ctx.text.replace(/sk-\S+/, '[redacted]'),
    });
    const res = await generateText({
      model,
      messages: USER,
      chat: { store: chat, chatId: 'c1', scope: { userId: 'u1', chatId: 'c1' } },
      guardrails: { onOutput: redact },
    });

    expect(res.text).toBe('my key is [redacted]');
    expect(textOf(res.response.messages.at(-1)!)).toBe('my key is [redacted]');
    const saved = await chat.loadChat('c1');
    expect(textOf(saved!.messages.at(-1)!)).toBe('my key is [redacted]');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      { hook: 'output', action: 'rewrite', name: 'redact', stepIndex: 0 },
    ]);
    expect(deuz(res.providerMetadata).stoppedBy).toBeUndefined();
  });

  it('rewrites chain and the last one wins', async () => {
    const model = createMockModel({ responses: [{ text: 'a' }] });
    const res = await generateText({
      model,
      messages: USER,
      guardrails: {
        onOutput: [
          (ctx) => ({ action: 'rewrite', text: `${ctx.text}b` }),
          (ctx) => ({ action: 'rewrite', text: `${ctx.text}c` }),
        ],
      },
    });
    expect(res.text).toBe('abc');
  });

  it('a block returns the replacement (or empty) and marks stoppedBy', async () => {
    const model = createMockModel({ responses: [{ text: 'unsafe answer' }] });
    const withReplacement = await generateText({
      model,
      messages: USER,
      guardrails: {
        onOutput: () => ({ action: 'block', reason: 'policy', replacement: 'I cannot help.' }),
      },
    });
    expect(withReplacement.text).toBe('I cannot help.');
    expect(textOf(withReplacement.response.messages.at(-1)!)).toBe('I cannot help.');
    expect(deuz(withReplacement.providerMetadata).stoppedBy).toBe('guardrail:output');

    const bare = await generateText({
      model: createMockModel({ responses: [{ text: 'unsafe answer' }] }),
      messages: USER,
      guardrails: { onOutput: () => ({ action: 'block' }) },
    });
    expect(bare.text).toBe('');
    // Mirrors `assembleAssistant`: an empty answer carries no text part at all.
    expect(bare.response.messages.at(-1)!.content).toEqual([]);
  });

  it('a later block short-circuits the guardrails after it', async () => {
    const seen: string[] = [];
    const model = createMockModel({ responses: [{ text: 'answer' }] });
    const res = await generateText({
      model,
      messages: USER,
      guardrails: {
        onOutput: [
          (ctx) => {
            seen.push(ctx.text);
            return { action: 'rewrite', text: 'sanitized' };
          },
          (ctx) => {
            seen.push(ctx.text);
            return { action: 'block', reason: 'still bad' };
          },
          (ctx) => {
            seen.push(ctx.text);
            return undefined;
          },
        ],
      },
    });
    expect(seen).toEqual(['answer', 'sanitized']);
    expect(res.text).toBe('');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      { hook: 'output', action: 'rewrite', stepIndex: 0 },
      { hook: 'output', action: 'block', reason: 'still bad', stepIndex: 0 },
    ]);
  });

  it('streaming: emits a live guardrail part and patches the persisted turn', async () => {
    const chat = createInMemoryChatStore();
    const model = createMockModel({ responses: [{ text: 'raw' }] });
    const result = streamChat({
      model,
      messages: USER,
      chat: { store: chat, chatId: 'c2', scope: { userId: 'u1', chatId: 'c2' } },
      guardrails: { onOutput: () => ({ action: 'rewrite', text: 'clean' }) },
    });
    const parts = await collect(result.fullStream);
    await result.consume?.(); // drains the post-terminal chat persistence

    const guardrails = parts.filter((p): p is GuardrailStreamPart => p.type === 'guardrail');
    // `name` comes off the FUNCTION: an arrow written straight into the
    // `onOutput` property inherits that key as its inferred name.
    expect(guardrails).toEqual([
      { type: 'guardrail', hook: 'output', action: 'rewrite', name: 'onOutput', stepIndex: 0 },
    ]);
    // The deltas already went out raw — the persisted turn is what gets fixed.
    const saved = await chat.loadChat('c2');
    expect(textOf(saved!.messages.at(-1)!)).toBe('clean');
    const finish = parts.find((p): p is FinishPart => p.type === 'finish')!;
    expect(deuz(finish.providerMetadata).guardrails).toHaveLength(1);
  });

  it('a throwing output guardrail propagates', async () => {
    const model = createMockModel({ responses: [{ text: 'x' }] });
    await expect(
      generateText({
        model,
        messages: USER,
        guardrails: {
          onOutput: () => {
            throw new Error('output guardrail exploded');
          },
        },
      }),
    ).rejects.toThrow('output guardrail exploded');
  });
});

// ===================================================================
// Built-ins
// ===================================================================

describe('built-in guardrails', () => {
  it('promptInjectionGuardrail prefixes the spotlighting policy as a system turn', async () => {
    const { model, bodies } = countingModel([{ text: 'ok' }]);
    const res = await generateText({
      model,
      messages: USER,
      guardrails: { onInput: promptInjectionGuardrail() },
    });
    expect(JSON.stringify(bodies[0])).toContain('untrusted DATA');
    expect(PROMPT_INJECTION_POLICY).toContain('untrusted DATA');
    expect(deuz(res.providerMetadata).guardrails).toEqual([
      { hook: 'input', action: 'rewrite', name: 'promptInjectionGuardrail' },
    ]);
  });

  it('promptInjectionGuardrail accepts a custom policy', async () => {
    const { model, bodies } = countingModel([{ text: 'ok' }]);
    await generateText({
      model,
      messages: USER,
      guardrails: { onInput: promptInjectionGuardrail({ policy: 'MY OWN RULES' }) },
    });
    const body = JSON.stringify(bodies[0]);
    expect(body).toContain('MY OWN RULES');
    expect(body).not.toContain('untrusted DATA');
  });

  it('maxOutputLength truncates by default and passes below the cap', async () => {
    const long = await generateText({
      model: createMockModel({ responses: [{ text: 'abcdefghij' }] }),
      messages: USER,
      guardrails: { onOutput: maxOutputLength(4) },
    });
    expect(long.text).toBe('abcd');
    expect(deuz(long.providerMetadata).guardrails).toEqual([
      { hook: 'output', action: 'rewrite', name: 'maxOutputLength', stepIndex: 0 },
    ]);

    const short = await generateText({
      model: createMockModel({ responses: [{ text: 'abc' }] }),
      messages: USER,
      guardrails: { onOutput: maxOutputLength(4) },
    });
    expect(short.text).toBe('abc');
    expect(deuz(short.providerMetadata).guardrails).toBeUndefined();
  });

  it("maxOutputLength mode 'block' refuses instead of truncating", async () => {
    const res = await generateText({
      model: createMockModel({ responses: [{ text: 'abcdefghij' }] }),
      messages: USER,
      guardrails: { onOutput: maxOutputLength(4, { mode: 'block' }) },
    });
    expect(res.text).toBe('');
    expect(deuz(res.providerMetadata).stoppedBy).toBe('guardrail:output');
    const entries = deuz(res.providerMetadata).guardrails as { reason?: string }[];
    expect(entries[0]!.reason).toContain('exceeded 4 characters');
  });
});
