import { describe, it, expect } from 'vitest';
import { getCapabilities } from '../src/core/registry';

const anthropic = (modelId: string) =>
  ({ provider: 'anthropic', modelId, surface: 'anthropic' }) as const;

describe('registry: 2026-07 Anthropic catalog', () => {
  it('claude-fable-5 is a known row with output_config effort wire', () => {
    const caps = getCapabilities(anthropic('claude-fable-5'));
    expect(caps.known).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.caching).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.effortWire).toBe('output_config');
    expect(caps.samplingRestrictions).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('claude-sonnet-5 matches fable-5 caps shape', () => {
    const caps = getCapabilities(anthropic('claude-sonnet-5'));
    expect(caps.known).toBe(true);
    expect(caps.effortWire).toBe('output_config');
    expect(caps.samplingRestrictions).toBe(true);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('opus 4.7/4.8 moved to output_config + samplingRestrictions', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7']) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.effortWire).toBe('output_config');
      expect(caps.samplingRestrictions).toBe(true);
    }
  });

  it('opus 4.6 and older keep the budget_tokens wire and free sampling', () => {
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      const caps = getCapabilities(anthropic(id));
      expect(caps.effortWire).toBe('budget_tokens');
      expect(caps.samplingRestrictions).toBe(false);
    }
  });

  it('unknown slugs default to budget_tokens', () => {
    const caps = getCapabilities(anthropic('claude-opus-4-9'));
    expect(caps.known).toBe(false);
    expect(caps.effortWire).toBe('budget_tokens');
  });
});

describe('registry: 2026-07 OpenAI catalog', () => {
  it('gpt-5.5 exposes reasoning (effort ships on both OpenAI wires)', () => {
    const caps = getCapabilities({
      provider: 'openai',
      modelId: 'gpt-5.5',
      surface: 'chat_completions',
    });
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1_050_000);
  });
  it('gpt-5.4-nano and gpt-5.3-codex are known responses rows', () => {
    for (const id of ['gpt-5.4-nano', 'gpt-5.3-codex']) {
      const caps = getCapabilities({ provider: 'openai', modelId: id, surface: 'responses' });
      expect(caps.known).toBe(true);
      expect(caps.reasoning).toBe(true);
      expect(caps.samplingRestrictions).toBe(true);
      expect(caps.contextWindow).toBe(400_000);
    }
  });
});

describe('registry: 2026-07 Google catalog', () => {
  it('gemini-3.1-pro-preview is known on both wires', () => {
    const native = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
      surface: 'native',
    });
    expect(native.known).toBe(true);
    expect(native.reasoning).toBe(true);
    expect(native.nativePdf).toBe(true);
    const compat = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.1-pro-preview',
      surface: 'chat_completions',
    });
    expect(compat.known).toBe(true);
    expect(compat.usagePerChunk).toBe(true);
  });
  it('gemini-3.1-flash-lite is a known native row', () => {
    const caps = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.1-flash-lite',
      surface: 'native',
    });
    expect(caps.known).toBe(true);
  });
});
