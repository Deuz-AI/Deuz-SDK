import { describe, it, expect } from 'vitest';
import { streamChat, generateText } from '../src/index';
import { createGoogleNative } from '../src/google';
import { toGeminiSchema } from '../src/schema/gemini';
import { sseResponse, sseEvents, mockFetch } from './fixtures/sse';

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
      outputTokens: 4,
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

  async function bodyFor(modelId: string, effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
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
