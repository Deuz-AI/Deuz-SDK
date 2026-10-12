import { describe, it, expect } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createGoogleNative } from '../src/google';
import { toGeminiSchema } from '../src/schema/gemini';
import { runStream } from '../src/core/inference';
import { getCapabilities } from '../src/core/registry';
import type { CommonCallOptions } from '../src/types/config';
import type { CallWarning } from '../src/types/methods';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';
import { GEMINI_CALL, GEMINI_FINISH_REASONS, geminiTurn } from './fixtures/provider-finish';

function consume(chunks: string[]) {
  return mockFetch(() => sseResponse(chunks));
}

describe('toGeminiSchema', () => {
  it('UPPERCASEs types, injects propertyOrdering, maps required', () => {
    const g = toGeminiSchema({
      type: 'object',
      properties: { city: { type: 'string' }, n: { type: 'integer' } },
      required: ['city'],
    });
    expect(g).toMatchObject({
      type: 'OBJECT',
      properties: { city: { type: 'STRING' }, n: { type: 'INTEGER' } },
      required: ['city'],
      propertyOrdering: ['city', 'n'],
    });
  });

  it('marks ["string","null"] as nullable', () => {
    const g = toGeminiSchema({ type: ['string', 'null'] });
    expect(g).toMatchObject({ type: 'STRING', nullable: true });
  });
});

describe('Gemini native generateContent wire', () => {
  const TEXT = sseEvents([
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Mer' }] } }] } },
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'haba' }] } }] } },
    {
      data: {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
          thoughtsTokenCount: 2,
          cachedContentTokenCount: 3,
        },
      },
    },
  ]);

  it('streams text, maps usage (cached + thoughts), uses x-goog-api-key + streamGenerateContent', async () => {
    const { fetch, calls } = consume([TEXT]);
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'selam' },
      ],
    });
    let text = '';
    for await (const c of result.textStream) text += c;
    expect(text).toBe('Merhaba');

    const usage = await result.usage;
    expect(usage).toMatchObject({
      inputTokens: 7, // 10 - 3 cached
      outputTokens: 6, // 4 candidates + 2 thoughts: reasoning is part of output (2.3)
      reasoningTokens: 2,
      cachedReadTokens: 3,
      totalTokens: 14,
    });
    expect(await result.finishReason).toBe('stop');

    const url = calls[0]!.url;
    expect(url).toContain('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    expect(url).toContain('alt=sse');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza-k');
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'be nice' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'selam' }] }]);
  });

  it('STOP-bug guard: finishReason STOP + functionCall → tool_calls', async () => {
    const TOOL = sseEvents([
      {
        data: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'get_weather', args: { city: 'Paris' } },
                    thoughtSignature: 'sig-123',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
        },
      },
    ]);
    const { fetch } = consume([TOOL]);
    const res = await generateText({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'weather in Paris?' }],
    });
    expect(res.finishReason).toBe('tool_calls');
    const content = res.response.messages[0]!.content;
    const parts = Array.isArray(content) ? content : [];
    const tool = parts.find((p) => p.type === 'tool_use');
    expect(tool).toMatchObject({ name: 'get_weather', input: { city: 'Paris' } });
    // thoughtSignature round-trips into providerMetadata.
    expect(
      (tool as { providerMetadata?: { google?: { thoughtSignature?: string } } }).providerMetadata
        ?.google?.thoughtSignature,
    ).toBe('sig-123');
  });

  it('thinking config: effort→thinkingBudget for 2.5 (not thinkingLevel)', async () => {
    const { fetch, calls } = consume([TEXT]);
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-pro'),
      messages: [{ role: 'user', content: 'think hard' }],
      effort: 'high',
    });
    for await (const _ of result.textStream) void _;
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(24576);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBeUndefined();
  });

  it('content_filter: blocked response (promptFeedback) → content_filter', async () => {
    const BLOCKED = sseEvents([
      {
        data: {
          promptFeedback: { blockReason: 'SAFETY' },
          usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 },
        },
      },
    ]);
    const { fetch } = consume([BLOCKED]);
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'bad' }],
    });
    for await (const _ of result.fullStream) void _;
    expect(await result.finishReason).toBe('content_filter');
  });

  it('grounding chunks → source parts in fullStream', async () => {
    const GROUNDED = sseEvents([
      { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'See sources.' }] } }] } },
      {
        data: {
          candidates: [
            {
              content: { role: 'model', parts: [] },
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        },
      },
    ]);
    const { fetch } = consume([GROUNDED]);
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: 'cite' }],
    });
    const sources: { url?: string; title?: string }[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'source') sources.push({ url: part.url, title: part.title });
    }
    expect(sources).toEqual([{ url: 'https://example.com', title: 'Example' }]);
  });
});

describe('Gemini thinking levels (0.2.0)', () => {
  const MINI = sseEvents([
    {
      data: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      },
    },
  ]);

  async function bodyFor(
    modelId: string,
    effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  ) {
    const { fetch, calls } = consume([MINI]);
    const result = streamChat({
      model: createGoogleNative({ apiKey: 'AIza-k', fetch })(modelId),
      messages: [{ role: 'user', content: 'hi' }],
      effort,
    });
    await result.finishReason;
    return JSON.parse(String(calls[0]!.init!.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number } };
    };
  }

  it('gemini-3.5-flash keeps medium as medium', async () => {
    const body = await bodyFor('gemini-3.5-flash', 'medium');
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('medium');
  });

  it('gemini-3.1-pro-preview collapses medium to low (low/high only model)', async () => {
    const body = await bodyFor('gemini-3.1-pro-preview', 'medium');
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('low');
  });

  it('xhigh/max clamp to high on the level wire', async () => {
    const body = await bodyFor('gemini-3.5-flash', 'max');
    expect(body.generationConfig?.thinkingConfig?.thinkingLevel).toBe('high');
  });

  it('gemini-2.5-pro maps xhigh to a 32768 budget', async () => {
    const body = await bodyFor('gemini-2.5-pro', 'xhigh');
    expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(32_768);
  });
});

// ===================================================================
// 2.3 — the native Gemini wire. F26: every clamp is reported. F08:
// gemini-3.8-flash (GA; research 2026-10-09, not live-verified) and the
// unknown-model output cap.
// ===================================================================

interface GeminiBody {
  generationConfig: {
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number };
  };
}

async function geminiRequest(
  modelId: string,
  options: Partial<CommonCallOptions> = {},
): Promise<{ body: GeminiBody; warnings: CallWarning[] }> {
  const { fetch, calls } = consume([
    sseEvents([
      {
        data: {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        },
      },
    ]),
  ]);
  const result = runStream({
    ...options,
    model: createGoogleNative({ apiKey: 'AIza-k', fetch })(modelId),
    messages: [{ role: 'user', content: 'hi' }],
  });
  for await (const _ of result.fullStream) void _;
  return {
    body: JSON.parse(String(calls[0]!.init!.body)) as GeminiBody,
    warnings: await result.warnings!,
  };
}

const clampedSettings = (warnings: CallWarning[]) =>
  warnings.filter((w) => w.type === 'clamped-setting').map((w) => w.setting);

describe('Gemini clamps are reported (2.3, F26)', () => {
  it("Gemini 3 level wire: 'xhigh' and 'max' → high, each with a clamped-setting", async () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const { body, warnings } = await geminiRequest('gemini-3.5-flash', { effort });
      expect(body.generationConfig.thinkingConfig?.thinkingLevel, effort).toBe('high');
      expect(clampedSettings(warnings), effort).toEqual(['effort']);
    }
    const medium = await geminiRequest('gemini-3.5-flash', { effort: 'medium' });
    expect(medium.body.generationConfig.thinkingConfig?.thinkingLevel).toBe('medium');
    expect(medium.warnings).toEqual([]);
  });

  it("Gemini 3 Pro takes only low/high: 'medium' → low, reported", async () => {
    const { body, warnings } = await geminiRequest('gemini-3.1-pro-preview', { effort: 'medium' });
    expect(body.generationConfig.thinkingConfig?.thinkingLevel).toBe('low');
    expect(clampedSettings(warnings)).toEqual(['effort']);
    expect(warnings[0]!.message).toContain("'medium'");
    expect(warnings[0]!.message).toContain("'low'");
    const high = await geminiRequest('gemini-3.1-pro-preview', { effort: 'high' });
    expect(high.warnings).toEqual([]);
  });

  it("Gemini 2.5 budget wire: 'xhigh' and 'max' share the 32768 budget, reported", async () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const { body, warnings } = await geminiRequest('gemini-2.5-pro', { effort });
      expect(body.generationConfig.thinkingConfig?.thinkingBudget, effort).toBe(32_768);
      expect(clampedSettings(warnings), effort).toEqual(['effort']);
    }
    const high = await geminiRequest('gemini-2.5-pro', { effort: 'high' });
    expect(high.body.generationConfig.thinkingConfig?.thinkingBudget).toBe(24_576);
    expect(high.warnings).toEqual([]);
  });
});

describe('gemini-3.8-flash (2.3, F08)', () => {
  it('is a known native row: thinking low/medium/high, default medium', () => {
    const caps = getCapabilities({
      provider: 'google',
      modelId: 'gemini-3.8-flash',
      surface: 'native',
    });
    expect(caps.known).toBe(true);
    expect(caps).toMatchObject({
      reasoning: true,
      effortLevels: ['low', 'medium', 'high'],
      effortDefault: 'medium',
      effortNone: 'lowest',
    });
  });

  it("no 'minimal' level: effort 'none' → low, reported; 'max' → high, reported", async () => {
    const none = await geminiRequest('gemini-3.8-flash', { effort: 'none' });
    expect(none.body.generationConfig.thinkingConfig?.thinkingLevel).toBe('low');
    expect(clampedSettings(none.warnings)).toEqual(['effort']);
    const max = await geminiRequest('gemini-3.8-flash', { effort: 'max' });
    expect(max.body.generationConfig.thinkingConfig?.thinkingLevel).toBe('high');
    expect(clampedSettings(max.warnings)).toEqual(['effort']);
    const medium = await geminiRequest('gemini-3.8-flash', { effort: 'medium' });
    expect(medium.body.generationConfig.thinkingConfig?.thinkingLevel).toBe('medium');
    expect(medium.warnings).toEqual([]);
  });

  it('its output limit is undocumented, so no maxOutputTokens is invented', async () => {
    const { body } = await geminiRequest('gemini-3.8-flash');
    expect(body.generationConfig).not.toHaveProperty('maxOutputTokens');
  });
});

describe('unknown native model output cap (2.3, F08)', () => {
  it('an unknown native slug sends no maxOutputTokens; a caller cap still does', async () => {
    const plain = await geminiRequest('gemini-9.9-ultra');
    expect(plain.body.generationConfig).not.toHaveProperty('maxOutputTokens');
    const capped = await geminiRequest('gemini-9.9-ultra', { maxOutputTokens: 777 });
    expect(capped.body.generationConfig.maxOutputTokens).toBe(777);
    // A known row keeps its documented limit.
    const known = await geminiRequest('gemini-2.5-flash');
    expect(known.body.generationConfig.maxOutputTokens).toBe(64_000);
  });
});

// ===================================================================
// 2.3 (K4) — every finish reason `@google/genai` 2.28 lists is mapped on
// purpose, on the streamed wire. Fixtures follow the packed 2.28.0 types;
// not live-verified.
// ===================================================================

async function streamedFinish(fixture: string): Promise<string> {
  const { fetch } = consume([fixture]);
  const result = streamChat({
    model: createGoogleNative({ apiKey: 'AIza-k', fetch })('gemini-2.5-flash'),
    messages: [{ role: 'user', content: 'hi' }],
  });
  for await (const _ of result.fullStream) void _;
  return result.finishReason;
}

describe('Gemini finish reasons (2.3, K4)', () => {
  it.each(GEMINI_FINISH_REASONS)('%s ends a streamed turn with %s', async (wire, expected) => {
    expect(await streamedFinish(geminiTurn(wire))).toBe(expected);
  });

  it('every filter of 2.28 ends the turn with content_filter, SPII and the image filters too', async () => {
    for (const wire of ['SPII', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']) {
      expect(await streamedFinish(geminiTurn(wire)), wire).toBe('content_filter');
    }
  });

  it('a value 2.28 does not list ends the turn with stop, as before', async () => {
    expect(await streamedFinish(geminiTurn('A_LATER_REASON'))).toBe('stop');
  });

  it.each(GEMINI_FINISH_REASONS)(
    '%s after a streamed call: a filter or a limit is never hidden by the STOP guard',
    async (wire, mapped) => {
      const expected = mapped === 'content_filter' || mapped === 'length' ? mapped : 'tool_calls';
      expect(await streamedFinish(geminiTurn(wire, [GEMINI_CALL]))).toBe(expected);
    },
  );
});
