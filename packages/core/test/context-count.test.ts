/**
 * context/count.ts (2.4, spec §2.3 "Tek token sayacı"): one counter for the
 * whole request. The public `createTokenEstimator` counts messages; these
 * helpers count a text inside a message and what a request costs beyond its
 * messages (tool schemas, the output schema and provider framing), always
 * through the same estimator, so a calibrated estimator calibrates them too.
 */
import { describe, expect, it } from 'vitest';
import { createTokenEstimator } from '../src/internal/estimate-tokens';
import {
  ANTHROPIC_TOOL_FRAMING_TOKENS,
  estimateRequestOverhead,
  estimateRequestTokens,
  estimateTextTokens,
} from '../src/context/count';

describe('estimateTextTokens', () => {
  it('counts a text without the per-message overhead', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('x'.repeat(36))).toBe(10);
    expect(estimateTextTokens('x'.repeat(37))).toBe(11);
  });

  it('counts through the given estimator, calibration included', () => {
    const estimator = createTokenEstimator();
    estimator.calibrate(200, 100); // factor 1.3
    expect(estimateTextTokens('x'.repeat(360), estimator)).toBeGreaterThan(
      estimateTextTokens('x'.repeat(360)),
    );
    const tokenizer = createTokenEstimator({ countTokens: (messages) => messages.length * 7 });
    // A tokenizer that sees no text difference: the text costs nothing extra.
    expect(estimateTextTokens('anything', tokenizer)).toBe(0);
  });
});

describe('estimateRequestOverhead', () => {
  const tool = {
    name: 'search_docs',
    description: 'Search the documentation',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  };

  it('is zero for a bare request', () => {
    expect(estimateRequestOverhead({})).toBe(0);
  });

  it('counts each tool schema, the output schema and the provider tool framing', () => {
    const one = estimateRequestOverhead({ tools: [tool] });
    const two = estimateRequestOverhead({ tools: [tool, { ...tool, name: 'other_tool' }] });
    expect(one).toBeGreaterThan(10);
    expect(two).toBeGreaterThan(one);
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    expect(estimateRequestOverhead({ outputSchema: schema })).toBeGreaterThan(0);
    expect(estimateRequestOverhead({ tools: [tool], provider: 'anthropic' })).toBe(
      one + ANTHROPIC_TOOL_FRAMING_TOKENS,
    );
    // Without tools there is no tool-use framing.
    expect(estimateRequestOverhead({ provider: 'anthropic' })).toBe(0);
  });

  it('takes the host framing count over the built-in one', () => {
    const base = estimateRequestOverhead({ tools: [tool] });
    expect(
      estimateRequestOverhead({ tools: [tool], provider: 'anthropic', framingTokens: 5 }),
    ).toBe(base + 5);
  });

  it('never throws on a schema JSON cannot encode', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      estimateRequestOverhead({ tools: [{ name: 't', parameters: circular }] }),
    ).not.toThrow();
  });
});

describe('estimateRequestTokens', () => {
  it('is the messages plus the overhead', () => {
    const estimator = createTokenEstimator();
    const messages = [{ role: 'user' as const, content: 'x'.repeat(72) }];
    const tools = [{ name: 'lookup', description: 'Look a thing up' }];
    expect(estimateRequestTokens({ messages, tools }, estimator)).toBe(
      estimator.estimate(messages) + estimateRequestOverhead({ tools }, estimator),
    );
  });
});
