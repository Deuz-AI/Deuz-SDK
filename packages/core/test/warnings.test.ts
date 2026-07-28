import { describe, it, expect, vi } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createOpenAI } from '../src/openai';
import { createGoogleNative } from '../src/google';
import { filePart } from '../src/parts';
import { runStream } from '../src/core/inference';
import { createWarningSink } from '../src/internal/warnings';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';
import type { StreamPart } from '../src/types/stream';
import type { CallWarning } from '../src/types/methods';
import type { Logger } from '../src/types/deps';

// ===================================================================
// `warnings` (1.9) — the escape valve for "we quietly did something else than
// you asked". Every assertion here is golden-replay: an injected `fetch`, a
// deterministic SSE body, no clock and no randomness.
//
// The invariant that matters most is the NEGATIVE one: a known slug with no
// dropped option must produce NOTHING. A false positive here fires on every
// call of every user and is worse than the missing feature.
// ===================================================================

const ANTHROPIC_DONE = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const CC_DONE = sseEvents([
  { data: { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] } },
  { data: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
  { data: '[DONE]' },
]);

const NATIVE_DONE = sseEvents([
  {
    data: {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  },
]);

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

/** Drain a stream and return every part (nobody pulling = no pump, G2). */
async function drain(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const warningParts = (parts: StreamPart[]): CallWarning[] =>
  parts
    .filter((p): p is Extract<StreamPart, { type: 'warning' }> => p.type === 'warning')
    .map((p) => p.warning);

const body = (call: { init?: RequestInit }): Record<string, unknown> =>
  JSON.parse(String(call.init!.body)) as Record<string, unknown>;

// ===================================================================
// Dropped sampling parameters
// ===================================================================

describe('unsupported-setting', () => {
  it('temperature on a reasoning model: ONE warning naming temperature, mirrored to the logger', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      // claude-opus-4-8: registry row has samplingRestrictions:true, so all
      // sampling params are stripped before the request goes out.
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      deps: { logger },
    });
    const parts = await drain(result.fullStream);

    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: 'unsupported-setting', setting: 'temperature' });
    expect(warnings[0]!.message).toContain('temperature');
    expect(warnings[0]!.message).toContain('claude-opus-4-8');

    // The same warning is live on the stream, and the parameter really was dropped.
    expect(warningParts(parts)).toEqual(warnings);
    expect(body(calls[0]!).temperature).toBeUndefined();

    // A log-only workflow still sees it — this site had no pre-1.9 log line, so
    // the sink's mirror is the only channel it can come from.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({
      warning: 'unsupported-setting',
      setting: 'temperature',
    });
  });

  it('reports temperature and topP separately, and only what the caller SET', async () => {
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      topP: 0.9,
    });
    await drain(result.fullStream);
    expect((await result.warnings!).map((w) => w.setting)).toEqual(['temperature', 'topP']);
  });

  it('maxOutputTokens is NOT reported — a restricted wire renames it, never drops it', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    const result = streamChat({
      // gpt-5.4 rides Responses; gpt-5.5 is the Chat Completions reasoning row.
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 555,
    });
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
    // gpt-5.5 is not sampling-restricted, so it keeps `max_tokens`; the point of
    // the assertion is that the value REACHED the wire, so warning would be a lie.
    expect(body(calls[0]!).max_tokens).toBe(555);
  });

  it('effort on a model with no reasoning capability is reported', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    const result = streamChat({
      // deepseek-v3.2: known row, reasoning:false, samplingRestrictions:false.
      model: createOpenAI({ apiKey: 'k', fetch })('deepseek-v3.2'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
      temperature: 0.3,
    });
    await drain(result.fullStream);

    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1); // temperature rides fine here — no warning for it
    expect(warnings[0]).toMatchObject({ type: 'unsupported-setting', setting: 'effort' });
    expect(warnings[0]!.message).toContain('high');
    expect(body(calls[0]!).reasoning_effort).toBeUndefined();
    expect(body(calls[0]!).temperature).toBe(0.3);
  });

  it("effort:'none' on a non-reasoning model is NOT a degradation", async () => {
    const { fetch } = mockFetch(() => sseResponse([CC_DONE]));
    const result = streamChat({
      model: createOpenAI({ apiKey: 'k', fetch })('deepseek-v3.2'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'none',
    });
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
  });

  it('a capabilities override silences the effort warning (the caller knows better)', async () => {
    const { fetch } = mockFetch(() => sseResponse([CC_DONE]));
    const result = streamChat({
      model: createOpenAI({ apiKey: 'k', fetch })('deepseek-v3.2'),
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'high',
      capabilities: { reasoning: true },
    });
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
  });

  it('the native wire never strips sampling params, so a restricted row is not reported', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([NATIVE_DONE]));
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      // A row can only CLAIM the restriction here via an override; google-native
      // sends temperature regardless, so reporting a drop would be a false positive.
      capabilities: { samplingRestrictions: true },
    });
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
    const generationConfig = body(calls[0]!).generationConfig as Record<string, unknown>;
    expect(generationConfig.temperature).toBe(0.7);
  });
});

// ===================================================================
// The negative case — the one that would annoy every user if it were wrong
// ===================================================================

describe('a clean call warns about nothing', () => {
  it('a KNOWN slug with no dropped option: empty list, no part, no log', async () => {
    const logger = makeLogger();
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { logger },
    });
    const parts = await drain(result.fullStream);

    expect(await result.warnings!).toEqual([]);
    expect(parts.some((p) => p.type === 'warning')).toBe(false);
    expect(parts.map((p) => p.type)).toEqual(['text-delta', 'finish']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a known slug on the native wire is silent too', async () => {
    const { fetch } = mockFetch(() => sseResponse([NATIVE_DONE]));
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
  });

  it('`warnings` resolves (never rejects) when the call FAILS', async () => {
    const { fetch } = mockFetch(
      () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 }),
    );
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    });
    const parts = await drain(result.fullStream);
    expect(parts.at(-1)!.type).toBe('error');
    await expect(result.usage).rejects.toBeDefined();
    // Whatever was collected before the failure still reports.
    expect((await result.warnings!).map((w) => w.type)).toEqual(['unknown-model']);
  });
});

// ===================================================================
// unknown-model
// ===================================================================

describe('unknown-model', () => {
  it('an unknown slug produces exactly one unknown-model warning naming the slug', async () => {
    const logger = makeLogger();
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user', content: 'hi' }],
      deps: { logger },
    });
    const parts = await drain(result.fullStream);

    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe('unknown-model');
    expect(warnings[0]!.message).toContain('claude-unreleased-9');
    expect(warningParts(parts)).toEqual(warnings);
    // The pre-1.9 log line is unchanged AND still the only one — the registry
    // logs it itself, so the sink must record quietly or every unknown slug
    // would log twice.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-unreleased-9',
      surface: 'anthropic',
    });
  });

  it('an unknown NATIVE slug reports too (its own table, its own fallback row)', async () => {
    const { fetch } = mockFetch(() => sseResponse([NATIVE_DONE]));
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-9.9-ultra'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    await drain(result.fullStream);
    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: 'unknown-model' });
    expect(warnings[0]!.message).toContain('gemini-9.9-ultra');
  });

  it('a capabilities override does NOT silence it (an override is a claim, not knowledge)', async () => {
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user', content: 'hi' }],
      capabilities: { maxOutput: 32_000 },
    });
    await drain(result.fullStream);
    expect((await result.warnings!).map((w) => w.type)).toEqual(['unknown-model']);
  });
});

// ===================================================================
// unsupported-tool (Chat Completions has no hosted tools)
// ===================================================================

describe('unsupported-tool', () => {
  it('a provider-executed tool on a chat_completions model is reported', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    // Driven through the pump directly: a `tools` option routes the public
    // entry points into the agentic loop, and the loop is not what is under
    // test here — the wire's drop is.
    const result = runStream(
      {
        model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
        messages: [{ role: 'user', content: 'search' }],
        deps: { logger },
      },
      {
        tools: {
          tools: [
            { name: 'echo', parameters: { type: 'object' } },
            { name: 'web_search', parameters: {}, provider: { type: 'web_search' } },
          ],
        },
      },
    );
    const parts = await drain(result.fullStream);

    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe('unsupported-tool');
    expect(warnings[0]!.message).toContain('web_search');
    expect(warningParts(parts)).toEqual(warnings);
    // The function tool still went out; the hosted one is still dropped.
    const sent = body(calls[0]!).tools as { function: { name: string } }[];
    expect(sent.map((t) => t.function.name)).toEqual(['echo']);
    // Exactly one log line, in the pre-1.9 shape the adapter has always written.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ droppedTools: ['web_search'] });
  });

  it('function-only tools warn about nothing', async () => {
    const { fetch } = mockFetch(() => sseResponse([CC_DONE]));
    const result = runStream(
      {
        model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
        messages: [{ role: 'user', content: 'echo' }],
      },
      { tools: { tools: [{ name: 'echo', parameters: { type: 'object' } }] } },
    );
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
  });
});

// ===================================================================
// A dropped document
// ===================================================================

describe('a dropped document', () => {
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  it('a model without nativePdf/vision: reported, and the request is unchanged', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    const result = streamChat({
      // deepseek-v3.2: known row with vision:false, nativePdf:false.
      model: createOpenAI({ apiKey: 'k', fetch })('deepseek-v3.2'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise this.' },
            filePart({ data: PDF_BYTES, mediaType: 'application/pdf' }),
          ],
        },
      ],
      deps: { logger },
    });
    const parts = await drain(result.fullStream);

    const warnings = await result.warnings!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe('other'); // CallWarning has no content member
    expect(warnings[0]!.message).toContain('application/pdf');
    expect(warningParts(parts)).toEqual(warnings);

    // Byte-level behaviour is exactly what it was: text only, no bogus block.
    const sent = body(calls[0]!);
    expect((sent.messages as { content: unknown }[])[0]!.content).toBe('Summarise this.');
    expect(JSON.stringify(sent)).not.toContain('JVBERg');
    // Still exactly one log line, in the pre-1.9 shape.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ modelId: 'deepseek-v3.2' });
  });

  it('a vision row keeps the document and warns about nothing', async () => {
    const { fetch, calls } = mockFetch(() => sseResponse([CC_DONE]));
    const result = streamChat({
      model: createOpenAI({ apiKey: 'k', fetch })('gpt-5.5'),
      messages: [
        {
          role: 'user',
          content: [filePart({ data: PDF_BYTES, mediaType: 'application/pdf' })],
        },
      ],
    });
    await drain(result.fullStream);
    expect(await result.warnings!).toEqual([]);
    expect(JSON.stringify(body(calls[0]!))).toContain('"type":"file"');
  });
});

// ===================================================================
// Dedup — the contract an agentic loop threads a single sink through
// ===================================================================

describe('dedup across the steps of a run', () => {
  it('one sink shared by N steps reports a re-derived warning ONCE', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    // What a loop does: `InternalRunOptions.warnings` is the seam, so every step
    // records into the same sink instead of re-reporting its own copy.
    const sink = createWarningSink();
    const options = {
      // Unknown slug → the conservative fallback row, which also reports
      // reasoning:false, so ONE call re-derives TWO warnings on every step.
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user' as const, content: 'hi' }],
      effort: 'high' as const,
      deps: { logger },
    };

    const step1 = runStream(options, { warnings: sink });
    const parts1 = await drain(step1.fullStream);
    const step2 = runStream(options, { warnings: sink });
    const parts2 = await drain(step2.fullStream);

    // Both causes are re-derived on step 2, and both are reported exactly once
    // for the whole run.
    expect(sink.list().map((w) => w.type)).toEqual(['unknown-model', 'unsupported-setting']);
    expect(sink.list()[1]).toMatchObject({ setting: 'effort' });
    expect(await step2.warnings!).toEqual(sink.list());
    // ...including on the stream: step 2 emits NO duplicate part.
    expect(warningParts(parts1)).toHaveLength(2);
    expect(warningParts(parts2)).toHaveLength(0);
    expect(calls).toHaveLength(2);
    // The MIRROR is deduped with the list (one line for the effort drop, not one
    // per step). The registry's own pre-1.9 line stays per call, exactly as in
    // 1.8 — this pass does not change what already logged.
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls.filter((c) => String(c[0]).includes('effort'))).toHaveLength(1);
  });

  it('separate calls each own their sink (no cross-call leak)', async () => {
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const options = {
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user' as const, content: 'hi' }],
    };
    const a = streamChat(options);
    await drain(a.fullStream);
    const b = streamChat(options);
    await drain(b.fullStream);
    expect(await a.warnings!).toHaveLength(1);
    expect(await b.warnings!).toHaveLength(1);
  });
});

// ===================================================================
// Surfacing
// ===================================================================

describe('surfacing', () => {
  it('`warnings` resolves without anyone iterating the stream (lazy start, G2)', async () => {
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Awaiting ONLY `warnings` must start the pump and settle, or a caller who
    // reads nothing else would hang forever.
    expect((await result.warnings!).map((w) => w.type)).toEqual(['unknown-model']);
  });

  it('the warning part precedes the model output on fullStream', async () => {
    const { fetch } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-unreleased-9'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts = await drain(result.fullStream);
    expect(parts.map((p) => p.type)).toEqual(['warning', 'text-delta', 'finish']);
  });

  it('the buffered path emits the same warnings (they are pump-level)', async () => {
    const logger = makeLogger();
    const { fetch, calls } = mockFetch(() => sseResponse([ANTHROPIC_DONE]));
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      deps: { logger },
    });
    expect(res.text).toBe('ok');
    expect(body(calls[0]!).temperature).toBeUndefined();
    // NOTE: `GenerateTextResult.warnings` needs the two-line patch in
    // inference/run-step.ts + inference/generate-text.ts (not owned by this
    // pass) to carry them onto the RESULT; the emission itself is asserted here.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ setting: 'temperature' });
  });
});
