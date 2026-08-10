import { describe, it, expect, vi } from 'vitest';
import { compactMessages } from '../src/compaction';
import { isSummaryMessage } from '../src/inference/compaction';
import type { Message, Part } from '../src/types/message';

/** One agentic turn: assistant (reasoning + text + tool_use) followed by its tool_result. */
function turnPair(i: number): [Message, Message] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: `thinking about step ${i}` },
        { type: 'text', text: `step ${i}` },
        { type: 'tool_use', id: `call_${i}`, name: 'search', input: { q: `query ${i}` } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: `call_${i}`, result: { data: 'x'.repeat(80), step: i } },
      ],
    },
  ];
}

/** [system, first user, (assistant, tool) x turns] — see compaction.test.ts. */
function history(turns: number): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: [{ type: 'text', text: 'Do the task.' }] },
  ];
  for (let i = 1; i <= turns; i++) msgs.push(...turnPair(i));
  return msgs;
}

function parts(m: Message | undefined): Part[] {
  if (!m || !Array.isArray(m.content)) throw new Error('expected a parts array');
  return m.content;
}

describe('compactMessages — force mode (no contextWindow)', () => {
  it('skips the fill gate and runs every layer exactly once', async () => {
    const msgs = history(8);
    const summarize = vi.fn(async (_slice: Message[], _previous?: string) => 'SUMMARY');
    const res = await compactMessages(msgs, 'auto', { summarize });

    // No window ⇒ no ratio ⇒ no early stop: all three layers, in policy order.
    expect(res.events.map((e) => e.layer)).toEqual([
      'prune-tool-results',
      'prune-reasoning',
      'summarize',
    ]);
    expect(res.trigger).toBe('manual');
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(res.messages.filter(isSummaryMessage)).toHaveLength(1);
    expect(res.messages).toHaveLength(11);
    // Protected prefix + keepRecentSteps tail keep reference equality.
    expect(res.messages[0]).toBe(msgs[0]);
    expect(res.messages[1]).toBe(msgs[1]);
    for (let i = 3; i < 11; i++) expect(res.messages[i]).toBe(msgs[i + 7]);
  });

  it('never calls a model on its own: without `summarize` that layer is skipped', async () => {
    const msgs = history(8);
    const res = await compactMessages(msgs);

    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results', 'prune-reasoning']);
    expect(res.messages.filter(isSummaryMessage)).toHaveLength(0);
    expect(res.messages).toHaveLength(msgs.length);
    expect(res.trigger).toBe('manual');
    // The local layers still did their work.
    expect(parts(res.messages[3])[0]).toMatchObject({ result: expect.stringMatching(/^\[pruned/) });
    expect(parts(res.messages[2]).some((p) => p.type === 'reasoning')).toBe(false);
  });

  it('threads the rolling summary through repeated manual passes', async () => {
    const summarize = vi
      .fn(async (_slice: Message[], _previous?: string) => 'SUMMARY 1')
      .mockResolvedValueOnce('SUMMARY 1')
      .mockResolvedValueOnce('SUMMARY 2');

    const pass1 = await compactMessages(history(8), 'auto', { summarize });
    const second = [...pass1.messages];
    for (let i = 9; i <= 12; i++) second.push(...turnPair(i));
    const pass2 = await compactMessages(second, 'auto', { summarize });

    expect(summarize.mock.calls[1]![1]).toBe('SUMMARY 1');
    expect(pass2.messages.filter(isSummaryMessage)).toHaveLength(1);
  });
});

describe('compactMessages — threshold mode (contextWindow given)', () => {
  it('returns the input untouched when fill is under the threshold', async () => {
    const msgs = history(8);
    const res = await compactMessages(msgs, 'auto', { contextWindow: 10_000_000 });

    expect(res.messages).toBe(msgs);
    expect(res.events).toEqual([]);
    expect(res.trigger).toBe('threshold');
  });

  it('compacts once the window is nearly full', async () => {
    const msgs = history(8);
    const res = await compactMessages(msgs, 'auto', { contextWindow: 100 });

    expect(res.trigger).toBe('threshold');
    expect(res.messages).not.toBe(msgs);
    // No summarizer injected ⇒ only the two local layers can run.
    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results', 'prune-reasoning']);
    const [first] = res.events;
    expect(first!.tokensBefore).toBeGreaterThan(first!.tokensAfter);
    expect(first!.messagesBefore).toBe(msgs.length);
  });
});

describe('compactMessages — estimator seams', () => {
  it('sizes with the built-in heuristic by default', async () => {
    const msgs = history(8);
    // The char heuristic puts this history in the hundreds of tokens: nowhere
    // near a 200k window, so the threshold gate keeps everything.
    const res = await compactMessages(msgs, 'auto', { contextWindow: 200_000 });
    expect(res.messages).toBe(msgs);
  });

  it('lets a policy countTokens replace the base count of that heuristic', async () => {
    const msgs = history(8);
    const countTokens = vi.fn(() => 199_000);
    const res = await compactMessages(msgs, { countTokens }, { contextWindow: 200_000 });

    expect(countTokens).toHaveBeenCalled();
    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results', 'prune-reasoning']);
  });

  it('lets an estimateTokens dep replace the whole estimate', async () => {
    const msgs = history(8);
    const estimateTokens = vi.fn((m: Message[]) => m.length);
    const res = await compactMessages(msgs, 'auto', {
      contextWindow: msgs.length,
      estimateTokens,
    });

    expect(estimateTokens).toHaveBeenCalled();
    // Counting MESSAGES: pruning never lowers it, so nothing stops early.
    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results', 'prune-reasoning']);
  });
});

describe('compactMessages — policy & skips', () => {
  it("expands 'auto' to the documented defaults", async () => {
    const msgs = history(8);
    const res = await compactMessages(msgs);
    // keepRecentSteps 4 → the last four turns are untouchable.
    for (let i = 10; i < msgs.length; i++) expect(res.messages[i]).toBe(msgs[i]);
  });

  it('honours a partial policy (layers + keepRecentSteps)', async () => {
    const msgs = history(8);
    const res = await compactMessages(msgs, { layers: ['prune-reasoning'], keepRecentSteps: 2 });

    expect(res.events.map((e) => e.layer)).toEqual(['prune-reasoning']);
    // Tool results survive — that layer was not in the policy.
    for (const i of [3, 5, 7, 9]) expect(res.messages[i]).toBe(msgs[i]);
    // keepRecentSteps 2 → the last two turns keep their reasoning, turn 6 does not.
    expect(parts(res.messages[12]).some((p) => p.type === 'reasoning')).toBe(false);
    for (let i = 14; i < msgs.length; i++) expect(res.messages[i]).toBe(msgs[i]);
  });

  it('reports a throwing summarizer through onSkip and keeps the earlier layers', async () => {
    const msgs = history(8);
    const onSkip = vi.fn();
    const summarize = vi.fn(async () => {
      throw new Error('summarizer down');
    });
    const res = await compactMessages(msgs, 'auto', { summarize, onSkip });

    expect(onSkip).toHaveBeenCalledWith('summarize', 'summarizer down');
    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results', 'prune-reasoning']);
    expect(res.messages).toHaveLength(msgs.length);
  });
});
