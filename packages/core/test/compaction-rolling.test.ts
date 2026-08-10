import { describe, it, expect, vi } from 'vitest';
import {
  applyCompaction,
  isSummaryMessage,
  normalizeCompaction,
  SUMMARY_SENTINEL,
} from '../src/inference/compaction';
import type { ApplyCompactionCtx, NormalizedCompaction } from '../src/inference/compaction';
import type { Message } from '../src/types/message';

const jsonEstimate = (msgs: Message[]): number => JSON.stringify(msgs).length;

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

/** A summary message shaped exactly as the layer writes it. */
function summaryMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_SENTINEL}\n${text}` }] };
}

function textOf(m: Message | undefined): string {
  if (!m || !Array.isArray(m.content)) throw new Error('expected a parts array');
  const p = m.content[0];
  if (p?.type !== 'text') throw new Error('expected a text part');
  return p.text;
}

/** Summarize-only policy that always triggers (fill is exactly 1 via `ctxOf`). */
function policy(over: Partial<NormalizedCompaction> = {}): NormalizedCompaction {
  return { ...normalizeCompaction('auto'), threshold: 0.5, layers: ['summarize'], ...over };
}

function ctxOf(msgs: Message[], over: Partial<ApplyCompactionCtx> = {}): ApplyCompactionCtx {
  return { estimate: jsonEstimate, contextWindow: jsonEstimate(msgs), ...over };
}

describe('isSummaryMessage', () => {
  it('recognizes the layer own output and nothing else', () => {
    expect(isSummaryMessage(summaryMessage('alpha'))).toBe(true);
    // Assistant role: the layer never writes one (Anthropic thinking-first rule).
    expect(
      isSummaryMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${SUMMARY_SENTINEL}\nalpha` }],
      }),
    ).toBe(false);
    // String content: the layer always writes a single text PART.
    expect(isSummaryMessage({ role: 'user', content: `${SUMMARY_SENTINEL}\nalpha` })).toBe(false);
    // More than one part — a user turn that merely opens with the sentinel.
    expect(
      isSummaryMessage({
        role: 'user',
        content: [
          { type: 'text', text: SUMMARY_SENTINEL },
          { type: 'text', text: 'and my question' },
        ],
      }),
    ).toBe(false);
    // Quoting the sentinel mid-text is not a prefix.
    expect(
      isSummaryMessage({
        role: 'user',
        content: [{ type: 'text', text: `what does "${SUMMARY_SENTINEL}" mean?` }],
      }),
    ).toBe(false);
  });
});

describe('summarize layer — rolling summary', () => {
  it('writes one sentinel-prefixed summary on the first pass, with no previousSummary', async () => {
    const msgs = history(8);
    const summarize = vi.fn(async (_slice: Message[], _previous?: string) => 'SUMMARY 1');
    const res = await applyCompaction(msgs, policy(), ctxOf(msgs, { summarize }));

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![1]).toBeUndefined();
    expect(res.messages.filter(isSummaryMessage)).toHaveLength(1);
    expect(res.messages[2]).toEqual(summaryMessage('SUMMARY 1'));
    expect(textOf(res.messages[2]).startsWith(SUMMARY_SENTINEL)).toBe(true);
  });

  it('folds a second pass INTO the previous summary and still leaves exactly one', async () => {
    const first = history(8);
    const summarize = vi.fn(async (_slice: Message[], _previous?: string) => 'SUMMARY 1');
    const pass1 = await applyCompaction(first, policy(), ctxOf(first, { summarize }));
    expect(pass1.messages).toHaveLength(11); // [sys, user, SUMMARY, 8 protected]

    // Four more turns arrive; the summary is inside the unprotected run again.
    const second = [...pass1.messages];
    for (let i = 9; i <= 12; i++) second.push(...turnPair(i));
    summarize.mockResolvedValue('SUMMARY 2');
    const pass2 = await applyCompaction(second, policy(), ctxOf(second, { summarize }));

    expect(summarize).toHaveBeenCalledTimes(2);
    const [slice, previous] = summarize.mock.calls[1]!;
    // The old summary is handed over as text, NOT re-summarized as a message.
    expect(previous).toBe('SUMMARY 1');
    expect(slice.some(isSummaryMessage)).toBe(false);
    expect(slice).toHaveLength(8);
    expect(slice[0]).toBe(second[3]);
    expect(slice[7]).toBe(second[10]);

    // INVARIANT: one summary at the head of the unprotected region, ever.
    expect(pass2.messages.filter(isSummaryMessage)).toHaveLength(1);
    expect(pass2.messages).toHaveLength(11);
    expect(pass2.messages[2]).toEqual(summaryMessage('SUMMARY 2'));
    // Untouched messages keep reference equality (prompt cache + React state).
    expect(pass2.messages[0]).toBe(second[0]);
    expect(pass2.messages[1]).toBe(second[1]);
    for (let i = 3; i < 11; i++) expect(pass2.messages[i]).toBe(second[i + 8]);
  });

  it('defensively folds EVERY summary stranded in the run, oldest text first', async () => {
    const [a1, t1] = turnPair(1);
    const [a2, t2] = turnPair(2);
    const [a3, t3] = turnPair(3);
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      summaryMessage('alpha'),
      a1,
      t1,
      summaryMessage('beta'),
      a2,
      t2,
      a3,
      t3,
    ];
    const summarize = vi.fn(async (_slice: Message[], _previous?: string) => 'MERGED');
    const res = await applyCompaction(
      msgs,
      policy({ keepRecentSteps: 1 }),
      ctxOf(msgs, { summarize }),
    );

    const [slice, previous] = summarize.mock.calls[0]!;
    expect(previous).toBe('alpha\nbeta');
    expect(slice).toEqual([a1, t1, a2, t2]);
    expect(res.messages).toHaveLength(5);
    expect(res.messages.filter(isSummaryMessage)).toHaveLength(1);
    expect(res.messages[2]).toEqual(summaryMessage('MERGED'));
    expect(res.messages[3]).toBe(a3);
    expect(res.messages[4]).toBe(t3);
  });

  it('is a no-op when the run holds nothing but summaries', async () => {
    const [a1, t1] = turnPair(1);
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      summaryMessage('alpha'),
      summaryMessage('beta'),
      a1,
      t1,
    ];
    const summarize = vi.fn(async (_slice: Message[], _previous?: string) => 'unused');
    const res = await applyCompaction(
      msgs,
      policy({ keepRecentSteps: 1 }),
      ctxOf(msgs, { summarize }),
    );

    // Summarizing a summary spends a model call to lose detail.
    expect(summarize).not.toHaveBeenCalled();
    expect(res.messages).toBe(msgs);
    expect(res.events).toEqual([]);
  });

  it('survives a throwing summarizer on a rolling pass: onSkip fires, history untouched', async () => {
    const [a1, t1] = turnPair(1);
    const [a2, t2] = turnPair(2);
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      summaryMessage('alpha'),
      a1,
      t1,
      a2,
      t2,
    ];
    const onSkip = vi.fn();
    const summarize = vi.fn(async (_slice: Message[], _previous?: string) => {
      throw new Error('boom');
    });
    const res = await applyCompaction(
      msgs,
      policy({ keepRecentSteps: 1 }),
      ctxOf(msgs, { summarize, onSkip }),
    );

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![1]).toBe('alpha');
    expect(onSkip).toHaveBeenCalledWith('summarize', 'boom');
    expect(res.messages).toBe(msgs);
    expect(res.events).toEqual([]);
    // The previous summary is still there — a failed fold loses nothing.
    expect(res.messages.filter(isSummaryMessage)).toHaveLength(1);
  });
});
