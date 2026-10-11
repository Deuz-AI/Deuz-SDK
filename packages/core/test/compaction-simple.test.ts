/**
 * compaction-simple.test.ts (2.3, F22): "simple" compaction for the models
 * that bind thinking to the transcript prefix.
 *
 * Claude 5.x rejects a replayed thinking block whose prefix changed, and the
 * keep-tail summary (old turns summarized, recent turns replayed with their
 * thinking) changes exactly that prefix. Simple compaction replaces the whole
 * conversation with ONE summary instead, so no earlier thinking is replayed at
 * all. What it keeps: the leading system run (the top-level system), the
 * later system messages that carry run state (handoff instructions, tool-set
 * changes, the caller's own), and the pending user turn with its recall.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  applyCompaction,
  normalizeCompaction,
  SUMMARY_SENTINEL,
  type ApplyCompactionCtx,
} from '../src/inference/compaction';
import { compactMessages } from '../src/compaction';
import type { Message } from '../src/types/message';

const RECALL: Message = {
  role: 'system',
  content: 'Relevant memories:\n- likes tea',
  providerMetadata: { deuz: { memoryRecall: true } },
};
const INSTRUCTIONS: Message = { role: 'system', content: 'You handle billing.' };
const CARRIER: Message = {
  role: 'system',
  content: [],
  providerMetadata: { deuz: { toolChanges: { remove: ['lookup'], add: [] } } },
};

const thought = (sig: string) => ({ type: 'reasoning' as const, text: '', signature: sig });

type Summarize = (slice: Message[], previousSummary?: string) => Promise<string>;

/** A compaction context in simple mode; `spy` is the default summarizer. */
function ctx(over: Partial<ApplyCompactionCtx> = {}): ApplyCompactionCtx & {
  spy: Mock<Summarize>;
} {
  const spy = vi.fn<Summarize>(async () => 'CONDENSED');
  return {
    estimate: (m: Message[]) => m.length * 100,
    contextWindow: 1000,
    strategy: 'simple',
    summarize: spy,
    ...over,
    spy,
  };
}

const summary = (text = 'CONDENSED'): Message => ({
  role: 'user',
  content: [{ type: 'text', text: `${SUMMARY_SENTINEL}\n${text}` }],
});

describe('simple compaction (applyCompaction, strategy: simple)', () => {
  const history: Message[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Refund my order.' },
    RECALL,
    {
      role: 'assistant',
      content: [
        thought('S0'),
        { type: 'tool_use', id: 't0', name: 'transfer_to_billing', input: {} },
      ],
    },
    { role: 'tool', content: [{ type: 'tool_result', toolUseId: 't0', result: 'Transferred.' }] },
    INSTRUCTIONS,
    CARRIER,
    { role: 'assistant', content: [thought('S1'), { type: 'text', text: 'Which order?' }] },
    { role: 'user', content: 'Order 42.' },
  ];

  it('one summary replaces the conversation; run-state system messages and the pending turn stay', async () => {
    const c = ctx();
    const { messages, events } = await applyCompaction(
      history,
      normalizeCompaction({ threshold: 0.5 }),
      c,
    );
    expect(messages).toEqual([
      history[0],
      summary(),
      INSTRUCTIONS,
      CARRIER,
      { role: 'user', content: 'Order 42.' },
    ]);
    // No assistant turn survives, so no thinking is replayed with a new prefix.
    expect(messages.some((m) => m.role === 'assistant')).toBe(false);
    // The summarizer saw every turn it replaced, the old recall block included.
    expect(c.spy).toHaveBeenCalledWith(
      [history[1], RECALL, history[3], history[4], history[7]],
      undefined,
    );
    expect(events.map((e) => e.layer)).toEqual(['summarize']);
  });

  it('a history that ends on a tool result is summarized whole', async () => {
    const c = ctx();
    const midLoop = history.slice(0, 5);
    const { messages } = await applyCompaction(midLoop, normalizeCompaction({ threshold: 0.1 }), c);
    expect(messages).toEqual([history[0], summary()]);
  });

  it('the pending turn keeps its own recall message', async () => {
    const c = ctx();
    const pending: Message[] = [...history, RECALL];
    const { messages } = await applyCompaction(pending, normalizeCompaction({ threshold: 0.1 }), c);
    expect(messages.slice(-2)).toEqual([{ role: 'user', content: 'Order 42.' }, RECALL]);
  });

  it('rolls: a previous summary is folded, never summarized again', async () => {
    const c = ctx();
    const rolled: Message[] = [
      { role: 'system', content: 'S' },
      summary('EARLIER'),
      INSTRUCTIONS,
      { role: 'assistant', content: [thought('S2'), { type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'Thanks.' },
    ];
    const { messages } = await applyCompaction(rolled, normalizeCompaction({ threshold: 0.1 }), c);
    expect(c.spy).toHaveBeenCalledWith([rolled[3]], 'EARLIER');
    expect(messages).toEqual([rolled[0], summary(), INSTRUCTIONS, rolled[4]]);
  });

  it('below the threshold nothing runs', async () => {
    const c = ctx({ estimate: () => 1 });
    const { messages, events } = await applyCompaction(history, normalizeCompaction('auto'), c);
    expect(messages).toBe(history);
    expect(events).toEqual([]);
    expect(c.spy).not.toHaveBeenCalled();
  });

  it('nothing but the pending turn: nothing to summarize', async () => {
    const c = ctx();
    const fresh: Message[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Hi.' },
    ];
    const { messages } = await applyCompaction(fresh, normalizeCompaction({ threshold: 0 }), c);
    expect(messages).toBe(fresh);
    expect(c.spy).not.toHaveBeenCalled();
  });

  it('the prune layers never edit the prefix; a prune-only policy compacts nothing and says why', async () => {
    const onSkip = vi.fn();
    const c = ctx({ onSkip });
    const { messages } = await applyCompaction(
      history,
      normalizeCompaction({ threshold: 0, layers: ['prune-tool-results', 'prune-reasoning'] }),
      c,
    );
    expect(messages).toBe(history);
    expect(onSkip.mock.calls.map((call) => call[0])).toEqual([
      'prune-tool-results',
      'prune-reasoning',
    ]);
    expect(String(onSkip.mock.calls[0]![1])).toMatch(/transcript prefix/);
  });

  it('with summarize in the policy the prune layers fold into the summary silently', async () => {
    const onSkip = vi.fn();
    const c = ctx({ onSkip });
    const { events } = await applyCompaction(history, normalizeCompaction('auto'), {
      ...c,
      estimate: (m) => m.length * 1000,
    });
    expect(events.map((e) => e.layer)).toEqual(['summarize']);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('a throwing summarizer leaves the history as it was', async () => {
    const onSkip = vi.fn();
    const c = ctx({
      onSkip,
      summarize: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    const { messages } = await applyCompaction(history, normalizeCompaction({ threshold: 0 }), c);
    expect(messages).toBe(history);
    expect(onSkip).toHaveBeenCalledWith('summarize', 'down');
  });
});

describe('compactMessages with a model that binds thinking to the prefix', () => {
  const model = {
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    surface: 'anthropic',
  } as const;

  it('compacts simple', async () => {
    const history: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [thought('S0'), { type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' },
    ];
    const { messages } = await compactMessages(history, 'auto', {
      model,
      summarize: async () => 'CONDENSED',
    });
    expect(messages).toEqual([summary(), history[2]]);
  });

  it('another model keeps the keep-tail layers', async () => {
    const history: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [thought('S0'), { type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' },
    ];
    const { messages } = await compactMessages(history, 'auto', {
      model: { provider: 'anthropic', modelId: 'claude-opus-4-8', surface: 'anthropic' },
      summarize: async () => 'CONDENSED',
    });
    // keep-tail protects the first user message and the last assistant turn onward.
    expect(messages).toBe(history);
  });
});
