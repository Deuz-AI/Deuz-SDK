import { describe, it, expect } from 'vitest';
import { createClient, resolveDependencies } from '../src/client';
import { resolveCall } from '../src/internal/resolve-call';
import { maskSecret, redactString, redactHeaders } from '../src/internal/redact';
import { getCapabilities } from '../src/core/registry';
import {
  normalizeMessages,
  extractSystem,
  inputShapeError,
  resolveInputMessages,
} from '../src/core/normalize';
import { generateText, generateObject, streamChat, streamObject } from '../src/generate';
import { anthropic, createAnthropic } from '../src/anthropic';
import { google } from '../src/google';
import { AuthenticationError, InvalidRequestError } from '../src/index';
import type { KeyProvider } from '../src/types/deps';
import type { GenerateTextOptions, GenerateObjectOptions } from '../src/types/methods';
import type { JSONSchema, StandardSchemaV1 } from '../src/types/schema';
import type { StreamPart } from '../src/types/stream';
import { mockFetch, sseEvents, sseResponse } from './fixtures/sse';

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

// ===================================================================
// 1.9 — `prompt` / `instructions` shorthand
// ===================================================================

const OBJECT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

/** One minimal, well-formed Anthropic text turn. */
const ANTHROPIC_TEXT = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'ok' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const anthropicReplay = (): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } =>
  mockFetch(() => sseResponse([ANTHROPIC_TEXT]));

/**
 * COMPILE-TIME guard (never executed): the `prompt` overload must not degrade
 * `generateObject`'s schema inference — `T` still has to flow out of `schema`, or
 * every shorthand caller silently gets `object: unknown`.
 */
async function _promptOverloadKeepsSchemaInference(): Promise<string> {
  const schema: StandardSchemaV1<unknown, { city: string }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => ({ value: value as { city: string } }),
    },
  };
  const res = await generateObject({ model: anthropic('claude-opus-4-8'), prompt: 'hi', schema });
  return res.object.city;
}
void _promptOverloadKeepsSchemaInference;

describe('input shape: prompt / instructions (1.9)', () => {
  it('prompt becomes exactly one user turn', () => {
    expect(resolveInputMessages({ prompt: 'hi' })).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('instructions goes FIRST and PRESERVES an in-history system message', () => {
    const messages = resolveInputMessages({
      instructions: 'A',
      messages: [
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(messages.map((m) => m.content)).toEqual(['A', 'B', 'hi']);
    // Documented precedence: extractSystem concatenates in array order, so the
    // developer's framing leads and the (possibly replayed) history follows.
    expect(extractSystem(normalizeMessages(messages)).system).toBe('A\n\nB');
  });

  it('the instructions fold is idempotent (chat-persistence round trip cannot duplicate it)', () => {
    const once = resolveInputMessages({
      instructions: 'A',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const twice = resolveInputMessages({ instructions: 'A', messages: once });
    expect(twice).toBe(once); // same array: no second system turn, no re-allocation
  });

  it('never mutates the caller’s array (immutable history)', () => {
    const original = [{ role: 'user' as const, content: 'hi' }];
    const folded = resolveInputMessages({ instructions: 'A', messages: original });
    expect(original).toHaveLength(1);
    expect(folded).toHaveLength(2);
  });

  it('flags both-given and neither-given, and lets `messages: []` yield to prompt', () => {
    expect(
      inputShapeError({ prompt: 'hi', messages: [{ role: 'user', content: 'hi' }] }, 'streamChat'),
    ).toBeInstanceOf(InvalidRequestError);
    expect(inputShapeError({}, 'streamChat')).toBeInstanceOf(InvalidRequestError);
    // An empty array asks for no turns, so it cannot CONFLICT with prompt…
    expect(inputShapeError({ prompt: 'hi', messages: [] }, 'streamChat')).toBeUndefined();
    expect(resolveInputMessages({ prompt: 'hi', messages: [] })).toEqual([
      { role: 'user', content: 'hi' },
    ]);
    // …but alone it stays 1.8 behaviour: the call proceeds to the transport.
    expect(inputShapeError({ messages: [] }, 'streamChat')).toBeUndefined();
  });

  it('prompt is byte-for-byte the equivalent messages array on the wire', async () => {
    const { fetch, calls } = anthropicReplay();
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    await generateText({ model, prompt: 'hi' });
    await generateText({ model, messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toHaveLength(2);
    expect(String(calls[0]!.init!.body)).toBe(String(calls[1]!.init!.body));
  });

  it('instructions lands on the wire as the system prompt', async () => {
    const { fetch, calls } = anthropicReplay();
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    await generateText({ model, prompt: 'hi', instructions: 'be brief' });
    await generateText({
      model,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    });
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.system).toBe('be brief');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(String(calls[0]!.init!.body)).toBe(String(calls[1]!.init!.body));
  });

  it('generateText / generateObject REJECT on a bad input shape (no network)', async () => {
    const { fetch, calls } = anthropicReplay();
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    await expect(
      generateText({ model, prompt: 'hi', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      generateObject({
        model,
        schema: OBJECT_SCHEMA,
        prompt: 'hi',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    // `messages` is REQUIRED on the interface, so neither-given only reaches the
    // runtime through JS callers / casts — which is exactly who needs the message.
    await expect(generateText({ model } as GenerateTextOptions)).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    await expect(
      generateObject({ model, schema: OBJECT_SCHEMA } as GenerateObjectOptions),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('streamChat surfaces a bad input shape WITHOUT throwing synchronously (G2)', async () => {
    const { fetch, calls } = anthropicReplay();
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    const result = streamChat({ model, prompt: 'hi', messages: [{ role: 'user', content: 'hi' }] });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('error');
    await expect(result.usage).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(result.finishReason).rejects.toBeInstanceOf(InvalidRequestError);
    // consume() never rejects — it reports through onError.
    let reported: unknown;
    await result.consume?.({ onError: (e) => (reported = e) });
    expect(reported).toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('streamObject surfaces a bad input shape WITHOUT throwing synchronously (G2)', async () => {
    const { fetch, calls } = anthropicReplay();
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    const result = streamObject({ model, schema: OBJECT_SCHEMA } as GenerateObjectOptions);
    await expect(result.object).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(result.usage).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      (async () => {
        for await (const partial of result.partialObjectStream) void partial;
      })(),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(calls).toHaveLength(0);
  });

  it('the shorthand is stripped once folded, so a re-entry cannot trip the guard', async () => {
    const { fetch, calls } = anthropicReplay();
    const model = createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
    // `wrapModel`/fail-over may hand the SAME options object back to an entry
    // point; with `prompt` still on it that second pass would be "both given".
    const options = { model, prompt: 'hi' } as const;
    await generateText(options);
    await generateText(options);
    expect(calls).toHaveLength(2);
    expect(String(calls[0]!.init!.body)).toBe(String(calls[1]!.init!.body));
  });

  it('a per-call capabilities override keeps the G1 key chain intact', async () => {
    // The override rides a per-call descriptor CLONE and forces a re-spread of the
    // options — so this covers three things at once: the clone must not shadow the
    // factory config, the re-spread must re-attach createClient's non-enumerable
    // context Symbol (the lowest-precedence key source), and the override must
    // still reach the wire.
    const { fetch, calls } = anthropicReplay();
    const client = createClient({ apiKeys: { anthropic: 'table-key' }, deps: { fetch } });
    await client.generateText({
      model: anthropic('claude-opus-4-8'), // bare descriptor: no factory config at all
      messages: [{ role: 'user', content: 'hi' }],
      capabilities: { maxOutput: 999 },
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('table-key');
    const body = JSON.parse(String(calls[0]!.init!.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(999);
  });
});
