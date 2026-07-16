import { describe, it, expect } from 'vitest';
import { resolveDependencies } from '../src/client';
import { resolveCall } from '../src/internal/resolve-call';
import { maskSecret, redactString, redactHeaders } from '../src/internal/redact';
import { getCapabilities } from '../src/core/registry';
import { normalizeMessages, extractSystem } from '../src/core/normalize';
import { anthropic, createAnthropic } from '../src/anthropic';
import { google } from '../src/google';
import { AuthenticationError } from '../src/index';
import type { KeyProvider } from '../src/types/deps';

describe('resolve-call (key precedence, G1)', () => {
  it('deps.keyProvider wins over factory apiKey', async () => {
    const keyProvider: KeyProvider = { getKey: async () => 'kp-key' };
    const model = createAnthropic({ apiKey: 'factory-key' })('claude-opus-4-8');
    const call = await resolveCall({ model, deps: resolveDependencies({ keyProvider }) });
    expect(call.apiKey).toBe('kp-key');
  });

  it('factory apiKey wins over ClientConfig.apiKeys table', async () => {
    const model = createAnthropic({ apiKey: 'factory-key' })('claude-opus-4-8');
    const call = await resolveCall({
      model,
      deps: resolveDependencies(),
      clientContext: { apiKeys: { anthropic: 'table-key' } },
    });
    expect(call.apiKey).toBe('factory-key');
  });

  it('falls back to ClientConfig.apiKeys when no keyProvider/factory key', async () => {
    const model = anthropic('claude-opus-4-8');
    const call = await resolveCall({
      model,
      deps: resolveDependencies(),
      clientContext: { apiKeys: { anthropic: 'table-key' } },
    });
    expect(call.apiKey).toBe('table-key');
  });

  it('throws AuthenticationError when no key anywhere', async () => {
    const model = anthropic('claude-opus-4-8');
    await expect(resolveCall({ model, deps: resolveDependencies() })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('resolves the wire default baseURL; factory baseURL overrides', async () => {
    const def = await resolveCall({
      model: createAnthropic({ apiKey: 'k' })('claude-opus-4-8'),
      deps: resolveDependencies(),
    });
    expect(def.baseURL).toBe('https://api.anthropic.com');

    const custom = await resolveCall({
      model: createAnthropic({ apiKey: 'k', baseURL: 'https://proxy.example/' })('claude-opus-4-8'),
      deps: resolveDependencies(),
    });
    expect(custom.baseURL).toBe('https://proxy.example');
  });
});

describe('redact (secrets never logged)', () => {
  it('masks secret token shapes in free text', () => {
    const out = redactString('key=sk-ant-abcdef0123456789 and AIzaSyABCDEF0123');
    expect(out).not.toContain('sk-ant-abcdef');
    expect(out).not.toContain('AIzaSyABCDEF');
  });

  it('masks secret header values by name', () => {
    const safe = redactHeaders({
      authorization: 'Bearer sk-secret-token-value',
      'content-type': 'application/json',
    });
    expect(safe.authorization).toBe(maskSecret('Bearer sk-secret-token-value'));
    expect(safe.authorization).not.toContain('secret');
    expect(safe['content-type']).toBe('application/json');
  });
});

describe('registry (unknown slug never throws)', () => {
  it('returns known caps for a pinned slug', () => {
    const caps = getCapabilities(anthropic('claude-opus-4-8'));
    expect(caps.known).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.maxOutput).toBe(128_000);
  });

  it('falls back to conservative caps for an unknown slug', () => {
    const caps = getCapabilities(anthropic('claude-opus-9-9'));
    expect(caps.known).toBe(false);
    expect(caps.tools).toBe(false);
    expect(caps.maxOutput).toBe(4_096);
  });

  it('keeps the usage-per-chunk quirk for unknown Gemini-compat slugs', () => {
    const caps = getCapabilities(google('gemini-9.9-flash'));
    expect(caps.known).toBe(false);
    expect(caps.usagePerChunk).toBe(true);
    expect(caps.toolIndexAllZero).toBe(true);
  });
});

describe('normalize (canonical only)', () => {
  it('coerces string content to a TextPart', () => {
    const [m] = normalizeMessages([{ role: 'user', content: 'hi' }]);
    expect(m!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('passes image parts through unchanged (vision supported)', () => {
    const msgs = normalizeMessages([
      { role: 'user', content: [{ type: 'image', image: 'https://example.com/img.jpg' }] },
    ]);
    expect(msgs[0]!.content[0]).toMatchObject({ type: 'image' });
  });

  it('extracts and concatenates system messages', () => {
    const norm = normalizeMessages([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
    const { system, rest } = extractSystem(norm);
    expect(system).toBe('be brief');
    expect(rest).toHaveLength(1);
    expect(rest[0]!.role).toBe('user');
  });
});
