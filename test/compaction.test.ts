import { describe, it, expect, vi } from 'vitest';
import { applyCompaction, normalizeCompaction } from '../src/inference/compaction';
import type { ApplyCompactionCtx, NormalizedCompaction } from '../src/inference/compaction';
import type { Message, Part } from '../src/types/message';
import type { LanguageModel } from '../src/types/model';

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

/**
 * [system, first user, (assistant, tool) x turns]. With `turns: 8` and the
 * default `keepRecentSteps: 4`, indices 0-1 and 10-17 are protected and the
 * first four turn pairs (indices 2-9) are compactable.
 */
function history(turns: number): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: [{ type: 'text', text: 'Do the task.' }] },
  ];
  for (let i = 1; i <= turns; i++) msgs.push(...turnPair(i));
  return msgs;
}

function policy(over: Partial<NormalizedCompaction> = {}): NormalizedCompaction {
  return { ...normalizeCompaction('auto'), ...over };
}

/** ctx whose window equals the current estimate, so fill is exactly 1 (always triggers). */
function ctxOf(msgs: Message[], over: Partial<ApplyCompactionCtx> = {}): ApplyCompactionCtx {
  return { estimate: jsonEstimate, contextWindow: jsonEstimate(msgs), ...over };
}

function parts(m: Message | undefined): Part[] {
  if (!m || !Array.isArray(m.content)) throw new Error('expected a parts array');
  return m.content;
}

function toolResult(m: Message | undefined): Extract<Part, { type: 'tool_result' }> {
  const p = parts(m)[0];
  if (p?.type !== 'tool_result') throw new Error('expected a tool_result part');
  return p;
}

describe('normalizeCompaction', () => {
  it("expands 'auto' to the defaults", () => {
    expect(normalizeCompaction('auto')).toEqual({
      threshold: 0.92,
      keepRecentSteps: 4,
      layers: ['prune-tool-results', 'prune-reasoning', 'summarize'],
    });
  });

  it('floors a fractional keepRecentSteps and defaults a non-finite one', () => {
    expect(normalizeCompaction({ keepRecentSteps: 1.5 }).keepRecentSteps).toBe(1);
    expect(normalizeCompaction({ keepRecentSteps: 0 }).keepRecentSteps).toBe(1);
    expect(normalizeCompaction({ keepRecentSteps: NaN }).keepRecentSteps).toBe(4);
    expect(normalizeCompaction({ keepRecentSteps: -3 }).keepRecentSteps).toBe(1);
  });

  it('merges a partial policy and carries summarizeModel through', () => {
    const model: LanguageModel = {
      provider: 'openai',
      modelId: 'gpt-test',
      surface: 'chat_completions',
    };
    expect(normalizeCompaction({ threshold: 0.8, summarizeModel: model })).toEqual({
      threshold: 0.8,
      keepRecentSteps: 4,
      layers: ['prune-tool-results', 'prune-reasoning', 'summarize'],
      summarizeModel: model,
    });
  });
});

describe('applyCompaction trigger', () => {
  it('returns the input array untouched when fill is at or below the threshold', async () => {
    const msgs = history(8);
    const res = await applyCompaction(msgs, policy(), {
      estimate: jsonEstimate,
      contextWindow: 10_000_000,
    });
    expect(res.messages).toBe(msgs);
    expect(res.events).toEqual([]);
  });
});

describe('prune-tool-results layer', () => {
  it('replaces old tool results with "[pruned N chars]" and leaves protected messages untouched', async () => {
    const msgs = history(8);
    msgs[3] = {
      role: 'tool',
      content: [
        { type: 'tool_result', toolUseId: 'call_1', result: 'plain text result', isError: true },
      ],
    };
    const snapshot = structuredClone(msgs);
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['prune-tool-results'] }),
      ctxOf(msgs),
    );

    // Old results pruned; toolUseId/isError intact; N = original serialized length.
    const pruned = toolResult(res.messages[3]);
    expect(pruned.result).toBe('[pruned 17 chars]');
    expect(pruned.toolUseId).toBe('call_1');
    expect(pruned.isError).toBe(true);
    const objLen = JSON.stringify({ data: 'x'.repeat(80), step: 2 }).length;
    expect(toolResult(res.messages[5]).result).toBe(`[pruned ${objLen} chars]`);
    expect(toolResult(res.messages[7]).result).toMatch(/^\[pruned \d+ chars\]$/);
    expect(toolResult(res.messages[9]).result).toMatch(/^\[pruned \d+ chars\]$/);

    // Protected prefix + keepRecentSteps tail + untouched assistants: reference equality.
    expect(res.messages[0]).toBe(msgs[0]);
    expect(res.messages[1]).toBe(msgs[1]);
    for (let i = 10; i < msgs.length; i++) expect(res.messages[i]).toBe(msgs[i]);
    expect(res.messages[2]).toBe(msgs[2]);
    expect(res.messages[4]).toBe(msgs[4]);

    // Input never mutated.
    expect(msgs).toEqual(snapshot);

    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.layer).toBe('prune-tool-results');
    expect(res.events[0]!.tokensBefore).toBeGreaterThan(res.events[0]!.tokensAfter);
  });

  it('skips parts that are already pruned', async () => {
    const msgs = history(8);
    msgs[3] = {
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'call_1', result: '[pruned 42 chars]' }],
    };
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['prune-tool-results'] }),
      ctxOf(msgs),
    );
    expect(res.messages[3]).toBe(msgs[3]);
    expect(toolResult(res.messages[3]).result).toBe('[pruned 42 chars]');
  });
});

describe('prune-reasoning layer', () => {
  it('drops reasoning from old assistant turns but never touches the protected tail', async () => {
    const msgs = history(8);
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['prune-reasoning'] }),
      ctxOf(msgs),
    );
    for (const i of [2, 4, 6, 8]) {
      const kept = parts(res.messages[i]);
      expect(kept.some((p) => p.type === 'reasoning')).toBe(false);
      expect(kept).toHaveLength(2);
    }
    for (const i of [3, 5, 7, 9]) expect(res.messages[i]).toBe(msgs[i]);
    for (let i = 10; i < msgs.length; i++) expect(res.messages[i]).toBe(msgs[i]);
    // The LAST assistant message keeps its reasoning.
    expect(parts(res.messages[16]).some((p) => p.type === 'reasoning')).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.layer).toBe('prune-reasoning');
  });

  it('keeps an all-reasoning assistant message intact instead of emptying it', async () => {
    const msgs = history(8);
    msgs[2] = { role: 'assistant', content: [{ type: 'reasoning', text: 'only thinking' }] };
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['prune-reasoning'] }),
      ctxOf(msgs),
    );
    expect(res.messages[2]).toBe(msgs[2]);
    expect(parts(res.messages[2])).toHaveLength(1);
  });

  it('protects the last assistant message even with keepRecentSteps 0', async () => {
    const msgs = history(3);
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, keepRecentSteps: 0, layers: ['prune-reasoning'] }),
      ctxOf(msgs),
    );
    expect(parts(res.messages[2]).some((p) => p.type === 'reasoning')).toBe(false);
    expect(parts(res.messages[4]).some((p) => p.type === 'reasoning')).toBe(false);
    expect(res.messages[6]).toBe(msgs[6]);
    expect(res.messages[7]).toBe(msgs[7]);
  });
});

describe('summarize layer', () => {
  it('replaces the oldest unprotected run with a single USER summary', async () => {
    const msgs = history(8);
    const summarize = vi.fn(async (_slice: Message[]) => 'THE SUMMARY');
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['summarize'] }),
      ctxOf(msgs, { summarize }),
    );

    expect(summarize).toHaveBeenCalledTimes(1);
    const slice = summarize.mock.calls[0]![0];
    expect(slice).toHaveLength(8);
    expect(slice[0]).toBe(msgs[2]);
    expect(slice[7]).toBe(msgs[9]);

    expect(res.messages).toHaveLength(11);
    expect(res.messages[0]).toBe(msgs[0]);
    expect(res.messages[1]).toBe(msgs[1]);
    // User role, not assistant: an assistant summary spliced before the anchor
    // assistant would merge on the wire and break Anthropic's thinking-first rule.
    expect(res.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[Earlier conversation summarized]\nTHE SUMMARY' }],
    });
    for (let i = 3; i < 11; i++) expect(res.messages[i]).toBe(msgs[i + 7]);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.layer).toBe('summarize');
    expect(res.events[0]!.tokensBefore).toBeGreaterThan(res.events[0]!.tokensAfter);
  });

  it('never summarizes away the pending question when no assistant turn exists yet', async () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'context doc 1' }] },
      { role: 'user', content: [{ type: 'text', text: 'context doc 2' }] },
      { role: 'user', content: [{ type: 'text', text: 'context doc 3' }] },
      { role: 'user', content: [{ type: 'text', text: 'THE REAL QUESTION' }] },
    ];
    const summarize = vi.fn(async () => 'SUMMARY');
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['summarize'] }),
      ctxOf(msgs, { summarize }),
    );
    // Oldest run [2,4) collapses; the first user (task) and the LAST user
    // (the actual question) both survive, history still ends on the question.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(res.messages[0]).toBe(msgs[0]);
    expect(res.messages[1]).toBe(msgs[1]);
    const last = res.messages.at(-1)!;
    expect(last).toBe(msgs[4]);
    expect(last.role).toBe('user');
    expect(JSON.stringify(last)).toContain('THE REAL QUESTION');
  });

  it('never throws on a circular/BigInt tool result (prune-tool-results)', async () => {
    const circular: Record<string, unknown> = { data: 'x'.repeat(200) };
    circular.self = circular;
    const msgs = history(8);
    msgs[3] = {
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'call_1', result: circular }],
    };
    msgs[5] = {
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'call_2', result: BigInt(42) }],
    };
    // A message-count estimate (the real loop's estimator is circular-safe too;
    // this test's default jsonEstimate helper is not, and must not mask the fix).
    const countEstimate = (m: Message[]): number => m.length;
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['prune-tool-results'] }),
      {
        estimate: countEstimate,
        contextWindow: 1,
      },
    );
    expect(toolResult(res.messages[3]).result).toMatch(/^\[pruned \d+ chars\]$/);
    expect(toolResult(res.messages[5]).result).toMatch(/^\[pruned \d+ chars\]$/);
  });

  it('does not summarize when fewer than 2 messages are unprotected', async () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ];
    const summarize = vi.fn(async () => 'unused');
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, keepRecentSteps: 1, layers: ['summarize'] }),
      ctxOf(msgs, { summarize }),
    );
    expect(summarize).not.toHaveBeenCalled();
    expect(res.messages).toBe(msgs);
    expect(res.events).toEqual([]);
  });

  it('is a no-op when no summarize function is injected', async () => {
    const msgs = history(8);
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.5, layers: ['summarize'] }),
      ctxOf(msgs),
    );
    expect(res.messages).toBe(msgs);
    expect(res.events).toEqual([]);
  });

  it('survives a throwing summarizer: onSkip fires and earlier layers are preserved', async () => {
    const msgs = history(8);
    const onSkip = vi.fn();
    const summarize = vi.fn(async () => {
      throw new Error('boom');
    });
    const estimate = (m: Message[]): number => m.length;
    const res = await applyCompaction(
      msgs,
      policy({ layers: ['prune-tool-results', 'summarize'] }),
      { estimate, contextWindow: msgs.length, summarize, onSkip },
    );
    expect(onSkip).toHaveBeenCalledWith('summarize', 'boom');
    expect(res.messages).toHaveLength(msgs.length);
    expect(toolResult(res.messages[3]).result).toMatch(/^\[pruned \d+ chars\]$/);
    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results']);
  });
});

describe('layer order & early stop', () => {
  it('runs layers in order and stops once fill drops below threshold*0.8', async () => {
    const msgs = history(8);
    const summarize = vi.fn(async () => 'unused');
    const estimate = (m: Message[]): number => {
      let t = 0;
      for (const msg of m) {
        if (!Array.isArray(msg.content)) continue;
        for (const p of msg.content) {
          if (p.type === 'reasoning') t += 100;
          else if (
            p.type === 'tool_result' &&
            !(typeof p.result === 'string' && p.result.startsWith('[pruned'))
          ) {
            t += 1000;
          }
        }
      }
      return t;
    };
    // 8800/9000 > 0.92 → prune-tool-results → 4800/9000 < 0.736 → stop.
    const res = await applyCompaction(msgs, policy(), {
      estimate,
      contextWindow: 9000,
      summarize,
    });
    expect(res.events).toEqual([
      { layer: 'prune-tool-results', tokensBefore: 8800, tokensAfter: 4800 },
    ]);
    for (const i of [2, 4, 6, 8]) expect(res.messages[i]).toBe(msgs[i]); // reasoning kept
    expect(summarize).not.toHaveBeenCalled();
  });

  it('respects a custom layer order', async () => {
    const msgs = history(8);
    const estimate = (m: Message[]): number => {
      let t = 0;
      for (const msg of m) {
        if (!Array.isArray(msg.content)) continue;
        for (const p of msg.content) {
          if (p.type === 'reasoning') t += 1000;
          else if (
            p.type === 'tool_result' &&
            !(typeof p.result === 'string' && p.result.startsWith('[pruned'))
          ) {
            t += 500;
          }
        }
      }
      return t;
    };
    // 12000/12500 > 0.92 → prune-reasoning → 8000/12500 < 0.736 → stop.
    const res = await applyCompaction(
      msgs,
      policy({ layers: ['prune-reasoning', 'prune-tool-results'] }),
      { estimate, contextWindow: 12500 },
    );
    expect(res.events).toEqual([
      { layer: 'prune-reasoning', tokensBefore: 12000, tokensAfter: 8000 },
    ]);
    for (const i of [3, 5, 7, 9]) expect(res.messages[i]).toBe(msgs[i]); // tool results kept
  });

  it('emits one event per effective layer with decreasing token counts', async () => {
    const msgs = history(8);
    const res = await applyCompaction(
      msgs,
      policy({ threshold: 0.1, layers: ['prune-tool-results', 'prune-reasoning'] }),
      { estimate: jsonEstimate, contextWindow: jsonEstimate(msgs) * 2 },
    );
    expect(res.events.map((e) => e.layer)).toEqual(['prune-tool-results', 'prune-reasoning']);
    const [e1, e2] = res.events;
    expect(e1!.tokensBefore).toBeGreaterThan(e1!.tokensAfter);
    expect(e2!.tokensBefore).toBeGreaterThan(e2!.tokensAfter);
    expect(e2!.tokensBefore).toBe(e1!.tokensAfter);
  });
});
