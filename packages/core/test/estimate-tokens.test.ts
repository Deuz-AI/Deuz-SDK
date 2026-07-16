import { describe, it, expect } from 'vitest';
import { createTokenEstimator } from '../src/internal/estimate-tokens';
import type { Message, Part } from '../src/types/message';

function textMessage(chars: number): Message {
  return { role: 'user', content: 'x'.repeat(chars) };
}

function partsMessage(parts: Part[]): Message {
  return { role: 'user', content: parts };
}

describe('createTokenEstimator — base heuristic', () => {
  it('returns 0 for an empty message array', () => {
    expect(createTokenEstimator().estimate([])).toBe(0);
  });

  it('estimates plain string content at ~chars/3.6 plus per-message overhead', () => {
    const estimate = createTokenEstimator().estimate([textMessage(3600)]);
    expect(estimate).toBeGreaterThanOrEqual(900);
    expect(estimate).toBeLessThanOrEqual(1200);
  });

  it('adds the fixed overhead for every message', () => {
    const estimator = createTokenEstimator();
    // Two empty-string messages: only the ~4-token overhead each.
    expect(estimator.estimate([textMessage(0), textMessage(0)])).toBe(8);
  });

  it('counts text and reasoning parts by their text length', () => {
    const estimator = createTokenEstimator();
    const text = estimator.estimate([partsMessage([{ type: 'text', text: 'x'.repeat(360) }])]);
    const reasoning = estimator.estimate([
      partsMessage([{ type: 'reasoning', text: 'x'.repeat(360) }]),
    ]);
    expect(text).toBe(104); // 360/3.6 + 4
    expect(reasoning).toBe(104);
  });

  it('adds a flat ~1600 tokens per image part', () => {
    const estimator = createTokenEstimator();
    const withoutImage = estimator.estimate([partsMessage([{ type: 'text', text: 'hello' }])]);
    const withImage = estimator.estimate([
      partsMessage([
        { type: 'text', text: 'hello' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ]),
    ]);
    expect(withImage - withoutImage).toBe(1600);
  });

  it('scales tool_use with the serialized input size', () => {
    const estimator = createTokenEstimator();
    const small = estimator.estimate([
      partsMessage([{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } }]),
    ]);
    const large = estimator.estimate([
      partsMessage([
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a'.repeat(3600) } },
      ]),
    ]);
    expect(large - small).toBeGreaterThanOrEqual(990);
    expect(large - small).toBeLessThanOrEqual(1010);
    // Small call still pays the fixed tool overhead on top of message overhead.
    expect(small).toBeGreaterThanOrEqual(14);
  });

  it('counts tool_result by its stringified result length plus overhead', () => {
    const estimator = createTokenEstimator();
    const estimate = estimator.estimate([
      partsMessage([{ type: 'tool_result', toolUseId: 't1', result: 'r'.repeat(360) }]),
    ]);
    expect(estimate).toBe(114); // 360/3.6 + 10 + 4
  });

  it('falls back to a flat 8 tokens for unknown part types', () => {
    const estimator = createTokenEstimator();
    const unknownPart = { type: 'hologram' } as unknown as Part;
    expect(estimator.estimate([partsMessage([unknownPart])])).toBe(12); // 8 + 4
  });
});

describe('createTokenEstimator — calibration', () => {
  const messages = [textMessage(3600)]; // base 1004

  it('learns the true multiplier under realistic feedback (calibrated estimate fed back)', () => {
    // The loop feeds back the CURRENT calibrated estimate each step, and the
    // provider's real count is a fixed multiple of the heuristic base. The
    // factor must converge to that multiplier — blending in ratio space instead
    // of factor space would converge to its square root (~1.41 for a 2x gap).
    const estimator = createTokenEstimator();
    const base = estimator.estimate(messages);
    const trueTokens = base * 2;

    for (let i = 0; i < 3; i++) estimator.calibrate(trueTokens, estimator.estimate(messages));
    const afterThree = estimator.estimate(messages);
    expect(afterThree).toBeGreaterThanOrEqual(Math.floor(base * 1.6));
    expect(afterThree).toBeLessThanOrEqual(Math.ceil(base * 1.75));

    for (let i = 0; i < 12; i++) estimator.calibrate(trueTokens, estimator.estimate(messages));
    const converged = estimator.estimate(messages);
    expect(converged).toBeGreaterThanOrEqual(Math.floor(base * 1.95));
    expect(converged).toBeLessThanOrEqual(Math.ceil(base * 2));
  });

  it('clamps the correction factor ceiling at 2.0', () => {
    const estimator = createTokenEstimator();
    const base = estimator.estimate(messages);
    estimator.calibrate(10_000, 1000); // ratio 10 → clamped immediately
    expect(estimator.estimate(messages)).toBe(Math.ceil(base * 2));
  });

  it('clamps the correction factor floor at 0.5', () => {
    const estimator = createTokenEstimator();
    const base = estimator.estimate(messages);
    for (let i = 0; i < 5; i++) estimator.calibrate(1, 1000);
    expect(estimator.estimate(messages)).toBe(Math.ceil(base * 0.5));
  });

  it('ignores calibrate calls with estimated <= 0', () => {
    const estimator = createTokenEstimator();
    const base = estimator.estimate(messages);
    estimator.calibrate(500, 0);
    estimator.calibrate(500, -10);
    expect(estimator.estimate(messages)).toBe(base);
  });

  it('ignores non-finite or non-positive samples without poisoning the factor', () => {
    const estimator = createTokenEstimator();
    const base = estimator.estimate(messages);
    estimator.calibrate(NaN, 1000);
    estimator.calibrate(1000, NaN);
    estimator.calibrate(Infinity, 1000);
    estimator.calibrate(0, 1000); // provider omitted usage → Usage zero-fills
    estimator.calibrate(-500, 1000);
    expect(estimator.estimate(messages)).toBe(base); // factor still 1.0, finite
    // A valid sample afterward still moves the (un-poisoned) factor.
    estimator.calibrate(10_000, 1000);
    expect(estimator.estimate(messages)).toBe(Math.ceil(base * 2));
  });

  it('keeps calibration local to each instance', () => {
    const calibrated = createTokenEstimator();
    const untouched = createTokenEstimator();
    const base = untouched.estimate(messages);

    calibrated.calibrate(10_000, 1000);
    expect(calibrated.estimate(messages)).toBe(Math.ceil(base * 2));
    expect(untouched.estimate(messages)).toBe(base);
  });
});
