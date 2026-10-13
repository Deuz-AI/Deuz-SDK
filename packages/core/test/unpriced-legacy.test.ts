// Decision 4 in the legacy loops (2.3, F13): generateText/streamChat under a
// `budget.usd` report a model with no price once and keep running, or refuse
// it before the call with `budget.unknownPrice: 'reject'`.
import { describe, expect, it } from 'vitest';
import { generateText, streamChat } from '../src/generate';
import { createAnthropic } from '../src/anthropic';
import { agentTool } from '../src/inference/agent-tool';
import { createExecutionContext } from '../src/execution-policy';
import { createMockModel } from '../src/testing';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { UnpricedModelError } from '../src/internal/unpriced-error';
import { sseEvents, sseResponse } from './fixtures/sse';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';
import type { StreamPart } from '../src/types/stream';

const schema = { type: 'object' as const, properties: {} };
const tools = { noop: { parameters: schema, execute: () => 'ok' } };
const prices = { priceUsage: (model: string) => (model === 'priced-model' ? 0.01 : undefined) };

function counted(): { model: LanguageModel; calls: () => number } {
  const base = createMockModel({ responses: [{ toolCalls: [{ toolName: 'noop', args: {} }] }] });
  const config = readConfig(base)!;
  let calls = 0;
  const model = attachConfig(
    { ...base },
    {
      ...config,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        return config.fetch!(input, init);
      }) as typeof fetch,
    },
  );
  return { model, calls: () => calls };
}

describe('legacy agentic loop with an unpriced model under budget.usd (decision 4)', () => {
  it('runs every step and reports one unpriced-model warning (t4 case 1)', async () => {
    const { model, calls } = counted();
    const result = await generateText({
      model,
      prompt: 'go',
      tools,
      maxSteps: 3,
      budget: { usd: 0.003 },
      deps: { priceProvider: prices },
    });
    expect(calls()).toBe(3);
    expect(result.warnings?.filter((w) => w.type === 'unpriced-model')).toEqual([
      expect.objectContaining({
        setting: 'budget.usd',
        message: expect.stringContaining('mock-model'),
      }),
    ]);
  });

  it('streams the warning as a part (t4b)', async () => {
    const { model } = counted();
    const parts: StreamPart[] = [];
    const res = streamChat({
      model,
      prompt: 'go',
      tools,
      maxSteps: 2,
      budget: { usd: 0.003 },
      deps: { priceProvider: prices },
    });
    for await (const part of res.fullStream) parts.push(part);
    expect(
      parts.filter((p) => p.type === 'warning' && p.warning.type === 'unpriced-model'),
    ).toHaveLength(1);
    expect((await res.warnings)?.filter((w) => w.type === 'unpriced-model')).toHaveLength(1);
  });

  it('streams it before the first model output when the only step answers directly', async () => {
    const parts: StreamPart[] = [];
    const res = streamChat({
      model: createMockModel({ responses: [{ text: 'done' }] }),
      prompt: 'go',
      tools,
      maxSteps: 3,
      budget: { usd: 1 },
      deps: { priceProvider: prices },
    });
    for await (const part of res.fullStream) parts.push(part);
    const unpriced = parts.findIndex(
      (p) => p.type === 'warning' && p.warning.type === 'unpriced-model',
    );
    // Before: recorded after the step's last flush, so it reached only `warnings`.
    expect(unpriced).toBeGreaterThanOrEqual(0);
    expect(unpriced).toBeLessThan(parts.findIndex((p) => p.type === 'text-delta'));
    expect(
      parts.filter((p) => p.type === 'warning' && p.warning.type === 'unpriced-model'),
    ).toHaveLength(1);
    expect((await res.warnings)?.filter((w) => w.type === 'unpriced-model')).toHaveLength(1);
  });

  it("refuses the model before any call under unknownPrice 'reject'", async () => {
    const { model, calls } = counted();
    const error = await generateText({
      model,
      prompt: 'go',
      tools,
      maxSteps: 3,
      budget: { usd: 1, unknownPrice: 'reject' },
      deps: { priceProvider: prices },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnpricedModelError);
    expect(error).toMatchObject({ code: 'unpriced_model', modelId: 'mock-model' });
    expect(calls()).toBe(0);
  });

  it('treats a missing priceProvider as no price', async () => {
    const { model } = counted();
    const result = await generateText({
      model,
      prompt: 'go',
      tools,
      maxSteps: 1,
      budget: { usd: 1 },
    });
    expect(result.warnings?.find((w) => w.type === 'unpriced-model')?.message).toContain(
      'No deps.priceProvider',
    );
  });
});

describe("legacy unknownPrice 'reject' gates every model the loop calls (decision 4)", () => {
  const PRICED = 'claude-opus-4-8';
  const reject = { usd: 5, unknownPrice: 'reject' as const };
  const anthropicPrices = {
    priceUsage: (model: string) =>
      model === PRICED || model === 'priced-model' ? 0.01 : undefined,
  };
  const FINAL = sseEvents([
    {
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Done.' },
      },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 6 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

  /** An Anthropic model whose every call is counted and answered with FINAL. */
  function anthropicModel(id: string): { model: LanguageModel; calls: () => number } {
    let calls = 0;
    const model = createAnthropic({
      apiKey: 'k',
      fetch: (async () => {
        calls++;
        return sseResponse([FINAL]);
      }) as typeof fetch,
    })(id);
    return { model, calls: () => calls };
  }

  /** A history long enough for the summarize layer to fold. */
  function bigHistory(turns: number): Message[] {
    const messages: Message[] = [{ role: 'user', content: 'Original task.' }];
    for (let i = 0; i < turns; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `old_${i}`, name: 'noop', input: { q: `old ${i}` } }],
      });
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: `old_${i}`, result: 'z'.repeat(400) }],
      });
    }
    messages.push({ role: 'user', content: 'Current question.' });
    return messages;
  }

  /** A mock model with its own id whose provider calls are counted. */
  function named(id: string, responses: Parameters<typeof createMockModel>[0]['responses']) {
    const base = createMockModel({ responses });
    const config = readConfig(base)!;
    let calls = 0;
    const model: LanguageModel = attachConfig(
      { ...base, modelId: id },
      {
        ...config,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          return config.fetch!(input, init);
        }) as typeof fetch,
      },
    );
    return { model, calls: () => calls };
  }

  const outcome = (run: Promise<unknown>) =>
    run.then(
      () => 'completed',
      (error: { code?: string }) => error.code,
    );

  it('refuses an unpriced step model before the compaction summary is made', async () => {
    const step = anthropicModel('claude-unpriced-x');
    const result = await outcome(
      generateText({
        model: step.model,
        messages: bigHistory(6),
        tools,
        maxSteps: 3,
        compaction: { threshold: 0, keepRecentSteps: 1, layers: ['summarize'] },
        budget: reject,
        deps: { priceProvider: anthropicPrices },
      }),
    );
    // Before: the summary went to the unpriced model, then the step was refused.
    expect(result).toBe('unpriced_model');
    expect(step.calls()).toBe(0);
  });

  it('refuses an unpriced summarizeModel', async () => {
    const step = anthropicModel(PRICED);
    const summarizer = anthropicModel('claude-unpriced-x');
    const result = await outcome(
      generateText({
        model: step.model,
        messages: bigHistory(6),
        tools,
        maxSteps: 3,
        compaction: {
          threshold: 0,
          keepRecentSteps: 1,
          layers: ['summarize'],
          summarizeModel: summarizer.model,
        },
        budget: reject,
        deps: { priceProvider: anthropicPrices },
      }),
    );
    // Before: the run completed, and the summarizer was called.
    expect(summarizer.calls()).toBe(0);
    expect(result).toBe('unpriced_model');
  });

  it('refuses an unpriced agentTool model, as the native path does', async () => {
    const run = async (native: boolean) => {
      const parent = named('priced-model', [
        { toolCalls: [{ toolName: 'helper', args: { prompt: 'do it' } }] },
        { text: 'done' },
      ]);
      const child = named('unpriced-model', [{ text: 'child answer' }]);
      const result = await outcome(
        generateText({
          model: parent.model,
          prompt: 'go',
          tools: {
            helper: agentTool({ name: 'helper', description: 'helps', model: child.model }),
          },
          maxSteps: 3,
          ...(native
            ? { execution: createExecutionContext({ budget: reject }) }
            : { budget: reject }),
          deps: { priceProvider: anthropicPrices },
        }),
      );
      return { result, childCalls: child.calls() };
    };
    const native = await run(true);
    expect(native).toEqual({ result: 'unpriced_model', childCalls: 0 });
    // Before: the legacy run completed, and the child model was called once.
    expect(await run(false)).toEqual(native);
  });

  it('gates an agentTool model while an observer copies the tool context', async () => {
    const parent = named('priced-model', [
      { toolCalls: [{ toolName: 'helper', args: { prompt: 'do it' } }] },
      { text: 'done' },
    ]);
    const child = named('unpriced-model', [{ text: 'child answer' }]);
    const result = await outcome(
      generateText({
        model: parent.model,
        prompt: 'go',
        tools: { helper: agentTool({ name: 'helper', description: 'helps', model: child.model }) },
        maxSteps: 3,
        budget: reject,
        deps: { priceProvider: anthropicPrices, observer: { emit: () => {} } },
      }),
    );
    expect({ result, childCalls: child.calls() }).toEqual({
      result: 'unpriced_model',
      childCalls: 0,
    });
  });

  it("warns about an unpriced agentTool model on the parent's result", async () => {
    const parent = named('priced-model', [
      { toolCalls: [{ toolName: 'helper', args: { prompt: 'do it' } }] },
      { text: 'done' },
    ]);
    const child = named('unpriced-model', [{ text: 'child answer' }]);
    const result = await generateText({
      model: parent.model,
      prompt: 'go',
      tools: { helper: agentTool({ name: 'helper', description: 'helps', model: child.model }) },
      maxSteps: 3,
      budget: { usd: 5 },
      deps: { priceProvider: anthropicPrices },
    });
    expect(result.text).toBe('done');
    expect(child.calls()).toBe(1);
    expect(result.warnings?.filter((w) => w.type === 'unpriced-model')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('unpriced-model') }),
    ]);
  });
});
