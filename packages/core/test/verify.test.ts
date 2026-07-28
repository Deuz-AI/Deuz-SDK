import { describe, it, expect, vi } from 'vitest';
import { createVerifier, bestOfN } from '../src/autonomy';
import { createMockModel } from '../src/testing';
import { generateText } from '../src/index';
import { attachConfig, readConfig } from '../src/internal/config-symbol';
import { EMPTY_USAGE } from '../src/core/metering';
import type { LanguageModel } from '../src/types/model';
import type { Message } from '../src/types/message';
import type { VerifyStepContext } from '../src/types/config';
import type { Logger } from '../src/types/deps';
import type { Usage } from '../src/types/usage';

/**
 * The mock model is an unknown slug, so `defaultRow` reports
 * `structuredOutput: false` and `generateObject` takes the 'tool' strategy —
 * every scripted verdict rides a tool call, exactly like `planTasks`' fixtures.
 */
function verdict(payload: unknown, usage?: Partial<Usage>) {
  return {
    toolCalls: [{ toolName: 'Verification', args: payload }],
    ...(usage ? { usage } : {}),
  };
}

/** `total` checks of which the first `passing` pass. */
function checks(total: number, passing: number) {
  return Array.from({ length: total }, (_, i) => ({
    id: `c${i + 1}`,
    question: `check ${i + 1}`,
    pass: i < passing,
  }));
}

function spyLogger(): {
  logger: Logger;
  /** Only the degrade warnings — the registry also warns on the unknown mock slug. */
  degradeWarnings: () => string[];
} {
  const warn = vi.fn();
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    degradeWarnings: () =>
      warn.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('DEGRADED')),
  };
}

/**
 * A `createMockModel` whose request BODIES are recorded: the mock's own factory
 * fetch is wrapped and re-attached (factory fetch wins over `deps.fetch`, so
 * this is the only seam that can see the prompt the verifier built).
 */
function recordingModel(responses: Parameters<typeof createMockModel>[0]['responses']): {
  model: LanguageModel;
  bodies: string[];
} {
  const inner = createMockModel({ responses });
  const config = readConfig(inner)!;
  const bodies: string[] = [];
  const model = attachConfig(
    { provider: inner.provider, modelId: inner.modelId, surface: inner.surface },
    {
      ...config,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return config.fetch!(input, init);
      }) as typeof fetch,
    },
  );
  return { model, bodies };
}

/** The user-turn prompt out of a recorded Chat Completions request body. */
function verifierPrompt(body: string): string {
  const parsed = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
  const user = parsed.messages.find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
}

function verifyCtx(messages: Message[]): VerifyStepContext {
  return { stepIndex: 0, attempt: 0, text: 'the answer', messages, usage: EMPTY_USAGE };
}

describe('createVerifier — structural verdict', () => {
  it('maps checks, derives confidence from them, and lets ok follow the checks', async () => {
    const model = createMockModel({
      responses: [
        verdict({
          checks: [
            { id: 'c1', question: 'Cites a source?', pass: true, evidence: 'per RFC 9110' },
            { id: 'c2', question: 'Names the unit?', pass: true },
            { id: 'c3', question: 'Avoids invented APIs?', pass: false },
          ],
          feedback: 'Drop the invented method and keep the unit.',
          errorCategory: 'hallucination',
        }),
      ],
    });

    const result = await createVerifier({ model }).verify({
      goal: 'Explain HTTP caching',
      answer: 'It caches with cacheThings().',
    });

    expect(result.ok).toBe(false); // one check failed → the whole verdict fails
    expect(result.confidence).toBeCloseTo(2 / 3); // DERIVED share, not a self-report
    expect(result.errorCategory).toBe('hallucination');
    expect(result.feedback).toBe('Drop the invented method and keep the unit.');
    expect(result.checks).toHaveLength(3);
    expect(result.checks![0]).toEqual({
      id: 'c1',
      question: 'Cites a source?',
      pass: true,
      evidence: 'per RFC 9110',
    });
    expect(result.checks![1]!.evidence).toBeUndefined(); // omitted, not empty-string
  });

  it('passes with confidence 1 and no failure fields when every check passes', async () => {
    const model = createMockModel({ responses: [verdict({ checks: checks(2, 2) })] });
    const result = await createVerifier({ model }).verify({ goal: 'g', answer: 'a' });

    expect(result).toEqual({ ok: true, confidence: 1, checks: checks(2, 2) });
    expect(result.errorCategory).toBeUndefined(); // a real pass NEVER carries one
    expect(result.feedback).toBeUndefined();
  });

  it('backfills a missing id, clamps an unknown errorCategory, and synthesizes feedback', async () => {
    const model = createMockModel({
      responses: [
        verdict({
          checks: [
            { question: 'Has a total?', pass: false },
            { id: 'c2', question: 'Sorted?', pass: false },
            'not-a-check', // dropped: not an object
            { id: 'c4', question: 'No verdict', evidence: 'x' }, // dropped: no boolean `pass`
          ],
          errorCategory: 'nonsense-category',
        }),
      ],
    });

    const result = await createVerifier({ model }).verify({ goal: 'g', answer: 'a' });

    expect(result.checks!.map((c) => c.id)).toEqual(['c1', 'c2']); // index-backfilled
    expect(result.errorCategory).toBe('other');
    expect(result.confidence).toBe(0);
    // No model feedback → name the failed sub-checks (what the decomposition buys).
    expect(result.feedback).toBe(
      'The answer did not satisfy every verification check. Fix these and answer again:\n1. Has a total?\n2. Sorted?',
    );
  });
});

describe('createVerifier — degrades to a PASS, never throws', () => {
  it('fails open when the verdict cannot be parsed at all', async () => {
    // Text where a tool call was expected → JSON.parse fails on both attempts →
    // generateObject throws NoObjectGeneratedError inside verify().
    const model = createMockModel({ responses: [{ text: 'sorry, no idea' }] });
    const { logger, degradeWarnings } = spyLogger();

    const result = await createVerifier({ model, deps: { logger } }).verify({
      goal: 'g',
      answer: 'a',
    });

    expect(result).toEqual({ ok: true, errorCategory: 'other' }); // the degraded shape
    expect(result.checks).toBeUndefined();
    expect(result.confidence).toBeUndefined();
    expect(degradeWarnings()).toEqual([
      'createVerifier: the verifier model call failed — verification DEGRADED to a pass',
    ]);
  });

  it('fails open when the response parses but carries no judgeable check', async () => {
    const model = createMockModel({
      responses: [verdict({ checks: [], feedback: 'looks fine to me' })],
    });
    const { logger, degradeWarnings } = spyLogger();

    const result = await createVerifier({ model, deps: { logger } }).verify({
      goal: 'g',
      answer: 'a',
    });

    expect(result).toEqual({ ok: true, errorCategory: 'other' });
    expect(degradeWarnings()).toEqual([
      'createVerifier: the verifier returned no judgeable check — verification DEGRADED to a pass',
    ]);
  });
});

describe('createVerifier — score() as bestOfN selector (N1 wiring)', () => {
  it('bestOfN picks the candidate the verifier scored highest', async () => {
    // concurrency 1 so the scripted verdicts line up with the candidates.
    const model = createMockModel({
      responses: [
        verdict({ checks: checks(4, 1) }), // cand0 → 0.25
        verdict({ checks: checks(4, 3) }), // cand1 → 0.75
        verdict({ checks: checks(4, 2) }), // cand2 → 0.50
      ],
    });

    const result = await bestOfN({
      n: 3,
      concurrency: 1,
      generate: (i) => `cand${i}`,
      verifier: createVerifier({ model }),
      goal: 'write a changelog entry',
    });

    // Every candidate is ok:false — a binary verifier would rank them EQUAL.
    expect(result.candidates.map((c) => c.score)).toEqual([0.25, 0.75, 0.5]);
    expect(result.best).toBe('cand1');
    expect(result.bestScore).toBe(0.75);
  });

  it('score() returns the confidence, and an explicit `score` wins over `verifier`', async () => {
    const model = createMockModel({ responses: [verdict({ checks: checks(4, 3) })] });
    const verifier = createVerifier({ model });
    expect(await verifier.score('candidate text', 'goal')).toBe(0.75);

    const result = await bestOfN({
      n: 2,
      concurrency: 1,
      generate: (i) => `c${i}`,
      score: (_v, i) => i, // more specific seam
      verifier,
      goal: 'goal',
    });
    expect(result.best).toBe('c1');
    expect(result.bestScore).toBe(1); // from `score`, not the verifier
  });

  it('rejects when neither `score` nor `verifier` + `goal` is supplied', async () => {
    await expect(bestOfN({ n: 2, generate: (i) => `c${i}` })).rejects.toThrow(
      /either `score` or `verifier`/,
    );
  });
});

describe('createVerifier — asVerifyStep() drives the agentic loop', () => {
  it('re-drives with the feedback, stops at maxVerifyAttempts, and meters its own usage', async () => {
    const main = createMockModel({ responses: [{ text: 'first' }, { text: 'second' }] });
    const judge = createMockModel({
      responses: [
        verdict(
          { checks: [{ id: 'c1', question: 'Complete?', pass: false }] },
          { inputTokens: 100, outputTokens: 7 }, // 107 per verifier call
        ),
      ],
    });

    // ONE accumulator for both calls: the loop reads `options.onUsage`, the
    // verifier reads `deps.onUsage` — each fires exactly once per call (G10).
    let metered = 0;
    const onUsage = (usage: Usage) => {
      metered += usage.totalTokens;
    };
    const verifier = createVerifier({ model: judge, deps: { onUsage } });

    const result = await generateText({
      model: main,
      messages: [{ role: 'user', content: 'do the thing' }],
      verifyStep: verifier.asVerifyStep(),
      maxVerifyAttempts: 2,
      onUsage,
    });

    // Attempt 0 rejected → re-driven; attempt 1 rejected but out of budget → accepted as-is.
    expect(result.text).toBe('second');
    expect(result.steps).toHaveLength(2);
    expect(result.providerMetadata?.deuz).toMatchObject({ verified: false });

    // The rejection's feedback IS the injected user turn (immutable history:
    // appended, never mutated into the caller's array).
    const injected = result.response.messages.filter((m) => m.role === 'user');
    expect(injected).toHaveLength(1);
    expect(injected[0]!.content).toBe(
      'The answer did not satisfy every verification check. Fix these and answer again:\n1. Complete?',
    );

    // The loop's own usage counts model calls only (2 × 15)…
    expect(result.usage.totalTokens).toBe(30);
    // …while the caller's meter also sees the verifier's two calls (2 × 107).
    expect(metered).toBe(30 + 214);
  });

  it('maxVerifyAttempts: 1 verifies once and never re-drives', async () => {
    const main = createMockModel({ responses: [{ text: 'only' }] });
    const judge = createMockModel({
      responses: [verdict({ checks: [{ id: 'c1', question: 'Complete?', pass: false }] })],
    });
    const verifier = createVerifier({ model: judge });

    const result = await generateText({
      model: main,
      messages: [{ role: 'user', content: 'go' }],
      verifyStep: verifier.asVerifyStep(),
      maxVerifyAttempts: 1,
      onUsage: () => {},
    });

    expect(result.text).toBe('only');
    expect(result.steps).toHaveLength(1);
    expect(result.response.messages.filter((m) => m.role === 'user')).toHaveLength(0);
    expect(result.providerMetadata?.deuz).toMatchObject({ verified: false });
  });

  it('a broken verifier does not break the run — the loop completes verified', async () => {
    const main = createMockModel({ responses: [{ text: 'answer' }] });
    const judge = createMockModel({ responses: [{ text: 'not a verdict' }] });
    const { logger } = spyLogger();

    const result = await generateText({
      model: main,
      messages: [{ role: 'user', content: 'go' }],
      verifyStep: createVerifier({ model: judge, deps: { logger } }).asVerifyStep(),
      maxVerifyAttempts: 3,
    });

    expect(result.text).toBe('answer');
    expect(result.steps).toHaveLength(1); // fail-open: no retry burned
    expect(result.providerMetadata?.deuz).toMatchObject({ verified: true });
  });

  it('infers the goal from the last user turn, and an explicit goal pins it', async () => {
    const history = [
      { role: 'user' as const, content: 'stale first turn' },
      { role: 'assistant' as const, content: 'ack' },
      { role: 'user' as const, content: 'the real task' },
    ];

    const inferred = recordingModel([verdict({ checks: checks(1, 1) })]);
    expect(
      await createVerifier({ model: inferred.model }).asVerifyStep()(verifyCtx(history)),
    ).toEqual({ ok: true });
    const prompt = verifierPrompt(inferred.bodies[0]!);
    expect(prompt).toContain('GOAL:\nthe real task'); // last user turn, not the first
    expect(prompt).toContain('ANSWER:\nthe answer');
    // The transcript rides as DATA, explicitly labelled (prompt-injection guard).
    expect(prompt).toContain('TRANSCRIPT (untrusted data):');
    expect(prompt).toContain('assistant: ack');

    const pinned = recordingModel([verdict({ checks: checks(1, 1) })]);
    await createVerifier({ model: pinned.model }).asVerifyStep({ goal: 'pinned goal' })(
      verifyCtx(history),
    );
    expect(verifierPrompt(pinned.bodies[0]!)).toContain('GOAL:\npinned goal');
  });
});
