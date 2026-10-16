/**
 * Memory helper-call accounting (2.4, spec §3.1 for the memory seams): the
 * memory LLM may be a plain `MemoryLLM` or an `AccountedMemoryLLM`, the
 * embedder a plain `Embedder` or an `AccountedMemoryEmbedder`. With
 * `seams.execution` every helper call is reserved on that context's ledger
 * first: an accounted one settles the usage it reports, an unmarked one is
 * reserved `unaccounted` (never free), ends `unknown` and reports one
 * `unaccounted-usage` warning. Without `execution` nothing changes from 2.3.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryMemoryStore,
  defineAccountedMemoryLLM,
  isAccounted,
  recall,
  remember,
  type MemorySeams,
} from '../src/memory';
import { createExecutionContext } from '../src/execution-policy';
import type { AccountedMemoryEmbedder } from '../src/types/accounting';
import type { BudgetReservationInput, NativeExecutionContext } from '../src/types/execution';
import type { CallWarning } from '../src/types/methods';
import type { Usage } from '../src/types/usage';

const clock = { now: () => 1_000_000, setTimeout: () => () => {} };
const SCOPE = { userId: 'u1' };
const MESSAGES = [{ role: 'user' as const, content: 'I live in Ankara' }];

function usage(input: number, output: number): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: input + output,
  };
}

/** A real context whose `reserve` is observed. */
function observedContext(): {
  execution: NativeExecutionContext;
  reservations: BudgetReservationInput[];
} {
  const context = createExecutionContext({ budget: { tokens: 1_000_000 } });
  const reservations: BudgetReservationInput[] = [];
  const execution: NativeExecutionContext = {
    policy: context.policy,
    budget: context.budget,
    depth: context.depth,
    scopeId: context.scopeId,
    ledger: context.ledger,
    child: (options) => context.child(options),
    snapshot: () => context.snapshot(),
    reserve: (input) => {
      reservations.push(input);
      return context.reserve(input);
    },
  };
  return { execution, reservations };
}

const plainAnswers = () =>
  vi
    .fn()
    .mockResolvedValueOnce('{"facts":[{"text":"The user lives in Ankara"}]}')
    .mockResolvedValueOnce('{"memory":[{"event":"ADD","text":"The user lives in Ankara"}]}');

function seams(over: Partial<MemorySeams> = {}): MemorySeams {
  let next = 0;
  return {
    store: createInMemoryMemoryStore(),
    llm: plainAnswers(),
    clock,
    generateId: () => `id-${++next}`,
    ...over,
  };
}

describe('memory seams accept accounted callbacks', () => {
  it('re-exports defineAccountedMemoryLLM and isAccounted from /memory', () => {
    const llm = defineAccountedMemoryLLM(async () => ({
      text: '',
      usage: usage(1, 1),
      modelId: 'm',
    }));
    expect(isAccounted(llm)).toBe(true);
    expect(isAccounted(async () => '')).toBe(false);
  });

  it('remember() reads the text of an accounted LLM answer (accountedLlm before llm)', async () => {
    const answers = [
      '{"facts":[{"text":"The user lives in Ankara"}]}',
      '{"memory":[{"event":"ADD","text":"The user lives in Ankara"}]}',
    ];
    const accountedLlm = defineAccountedMemoryLLM(async () => ({
      text: answers.shift()!,
      usage: usage(10, 5),
      modelId: 'small-model',
    }));
    const llm = vi.fn<MemorySeams['llm']>(async () => '{"facts":[]}');
    const s = seams({ llm, accountedLlm });
    const mutations = await remember(MESSAGES, SCOPE, s);
    expect(mutations.map((m) => (m.op === 'upsert' ? m.record.text : m.op))).toEqual([
      'The user lives in Ankara',
    ]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('still reads the text of an accounted callable that untyped code put in llm', async () => {
    const answers = [
      '{"facts":[{"text":"The user lives in Ankara"}]}',
      '{"memory":[{"event":"ADD","text":"The user lives in Ankara"}]}',
    ];
    const accounted = defineAccountedMemoryLLM(async () => ({
      text: answers.shift()!,
      usage: usage(10, 5),
      modelId: 'small-model',
    }));
    const mutations = await remember(
      MESSAGES,
      SCOPE,
      seams({ llm: accounted as unknown as MemorySeams['llm'] }),
    );
    expect(mutations.map((m) => (m.op === 'upsert' ? m.record.text : m.op))).toEqual([
      'The user lives in Ankara',
    ]);
  });

  it('recall() and remember() use an accounted memory embedder', async () => {
    const embedder: AccountedMemoryEmbedder = {
      accounted: true,
      async embed(texts) {
        return {
          vectors: texts.map(() => [1, 0, 0]),
          model: 'embed-model',
          modelId: 'embed-model',
          usage: usage(texts.length, 0),
        };
      },
    };
    const s = seams({ embedder });
    await remember(MESSAGES, SCOPE, s);
    const hits = await recall({ scope: SCOPE, text: 'where?' }, s);
    expect(hits[0]?.record.embeddingModelId).toBe('embed-model');
    expect(hits[0]?.record.embedding).toEqual([1, 0, 0]);
  });
});

describe('memory helper calls on a ledger (seams.execution)', () => {
  it('settles the usage an accounted LLM call reports', async () => {
    const { execution, reservations } = observedContext();
    const answers = [
      '{"facts":[{"text":"The user lives in Ankara"}]}',
      '{"memory":[{"event":"ADD","text":"The user lives in Ankara"}]}',
    ];
    const accountedLlm = defineAccountedMemoryLLM(async () => ({
      text: answers.shift()!,
      usage: usage(100, 20),
      modelId: 'small-model',
    }));
    const warnings: CallWarning[] = [];
    await remember(MESSAGES, SCOPE, seams({ accountedLlm, execution }), {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(reservations).toHaveLength(2);
    for (const input of reservations) {
      expect(input.unaccounted).toBeUndefined();
      expect(input.kind).toBe('memory-llm');
      expect(input.tokens).toBeGreaterThan(0);
      const reservation = execution.ledger.get(input.requestId)!;
      // The reported usage is settled; USD stays unknown (a host callback has no price).
      expect(reservation.actual.tokens).toBe(120);
      expect(reservation.usage).toEqual(usage(100, 20));
    }
    expect(warnings).toEqual([]);
  });

  it('counts an unmarked LLM as unaccounted: reserved, left unknown, one warning', async () => {
    const { execution, reservations } = observedContext();
    const warnings: CallWarning[] = [];
    await remember(MESSAGES, SCOPE, seams({ execution }), {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(reservations).toHaveLength(2);
    for (const input of reservations) {
      expect(input.unaccounted).toBe(true);
      const reservation = execution.ledger.get(input.requestId)!;
      expect(reservation.state).toBe('unknown');
      expect(reservation.actual.tokens).toBeUndefined();
      expect(reservation.reservation.tokens).toBeGreaterThan(0);
    }
    expect(new Set(warnings.map((w) => `${w.type} ${w.message}`)).size).toBe(1);
    expect(warnings[0]!.type).toBe('unaccounted-usage');
  });

  it('points the unmarked-LLM warning at seams.accountedLlm, where the wrapped callback compiles', async () => {
    const { execution } = observedContext();
    const warnings: CallWarning[] = [];
    await remember(MESSAGES, SCOPE, seams({ execution }), {
      onWarning: (warning) => warnings.push(warning),
    });
    // `llm` is typed MemoryLLM (Promise<string>): an AccountedMemoryLLM goes to `accountedLlm`.
    expect(warnings[0]!.message).toContain('defineAccountedMemoryLLM');
    expect(warnings[0]!.message).toContain('`accountedLlm`');
    // Following the advice type-checks and settles the calls without a warning.
    const followed: MemorySeams = seams({
      execution: observedContext().execution,
      accountedLlm: defineAccountedMemoryLLM(async () => ({
        text: '{"facts":[]}',
        modelId: 'memory-model',
        usage: usage(5, 2),
      })),
    });
    const after: CallWarning[] = [];
    await remember(MESSAGES, SCOPE, followed, { onWarning: (warning) => after.push(warning) });
    expect(after).toEqual([]);
  });

  it('charges the query embedding of recall() the same way', async () => {
    const { execution, reservations } = observedContext();
    const warnings: CallWarning[] = [];
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => [1, 0, 0]),
      model: 'embed-model',
    }));
    await recall({ scope: SCOPE, text: 'where?' }, seams({ execution, embedder: { embed } }), {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(reservations).toEqual([
      expect.objectContaining({ kind: 'memory-embedding', unaccounted: true }),
    ]);
    expect(warnings.map((w) => w.type)).toEqual(['unaccounted-usage']);
  });

  it('marks a failed call unknown and rethrows', async () => {
    const { execution, reservations } = observedContext();
    const llm = vi.fn().mockRejectedValue(new Error('provider down'));
    await expect(remember(MESSAGES, SCOPE, seams({ llm, execution }))).rejects.toThrow(
      'provider down',
    );
    expect(execution.ledger.get(reservations[0]!.requestId)!.state).toBe('unknown');
  });

  it('without execution: no reservation, no warning, no extra ids (2.3 behaviour)', async () => {
    const generateId = vi.fn(() => 'id');
    const warn = vi.fn();
    const s = seams({ generateId, logger: { warn } });
    await remember(MESSAGES, SCOPE, s);
    // One id for the one ADD record, as in 2.3.
    expect(generateId).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
